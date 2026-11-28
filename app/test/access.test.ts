import { createHmac } from "node:crypto";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { kidOf } from "../src/access/key";
import type { Agent } from "../src/agent/agent";
import { AgentStore, MESSAGE_QUIET_WINDOW_MS } from "../src/agent/store";
import { TURN_SYSTEM } from "../src/agent/prompt";
import { loadConfig, type Env } from "../src/config";
import type { AgentKey, EpochMs, MicroUsd, UtcMonth } from "../src/domain";
import { bytesOf } from "../src/model/prompt";
import { modelOf, PROVIDERS } from "../src/model/providers";
import { routeFor } from "../src/model/routes";
import { NOTICES } from "../src/notices";
import { chat, devChat, fakeProvider, giveKey, local, schedule, scripted, send, TEST_KEY_SECRET, TEST_KEYS, type ProviderStep } from "./testkit";

const NOTICE = NOTICES.en;
const reply = (text: string, extra: Record<string, unknown> = {}): ProviderStep => ({ kind: "output", value: { actions: [send(text)], tasks: [], about: "", ...extra } });
const KEY = "oc_sk_live_abcdefghijklmnop0123456789";
const ONBOARDING = NOTICE.noAccess({ box: false, key: true, included: false });

async function doDump(agent: AgentKey): Promise<string> {
  const stub = env.AGENT.get(env.AGENT.idFromName(agent));
  return runInDurableObject(stub, (_a, state) => {
    const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").toArray();
    return JSON.stringify(tables.map(({ name }) => state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()));
  });
}

describe("no access", () => {
  test("someone with nothing connected gets the code-written offer once a day, and no model is called", async () => {
    const provider = fakeProvider();
    const c = await devChat("abe", { model: null, provider, at: "2099-11-04T10:00" });

    await c.say("hi");
    await c.say("hello?");
    c.clock.set(local("2099-11-05T10:00"));
    await c.say("anyone?");

    expect(await c.received()).toEqual([ONBOARDING, ONBOARDING]);
    expect(provider.seen).toHaveLength(0);
    expect(c.logs("model_call")).toEqual([]);
    expect(c.logs("turn").map((l) => [l.eventKind, l.outcome])).toEqual([
      ["message", "no_access"],
      ["message", "no_access"],
      ["message", "no_access"],
      ["checkin", "no_access"],
    ]);
    expect((await c.snapshot()).access.lanes).toEqual([]);
  });

  test("someone who adds the agent with nothing connected gets the offer then, and not again that day", async () => {
    const provider = fakeProvider();
    const c = await devChat("ada", { model: null, provider, at: "2099-11-04T10:00" });

    await c.say("/follow");
    expect(await c.received()).toEqual([ONBOARDING]);
    await c.say("hi");
    expect(await c.received()).toEqual([]);
    expect(provider.seen).toHaveLength(0);
    expect(c.logs("turn").map((l) => [l.eventKind, l.outcome])).toEqual([
      ["lifecycle", "no_access"],
      ["message", "no_access"],
    ]);
  });

  test("the offer names only what this deploy can give", () => {
    expect(NOTICE.noAccess({ box: true, key: true, included: false })).toContain("/claude");
    expect(NOTICE.noAccess({ box: false, key: true, included: false })).not.toContain("/claude");
    expect(NOTICE.noAccess({ box: false, key: true, included: true })).toContain("/plan");
    expect(NOTICES.th.noAccess({ box: true, key: true, included: false })).toContain("/key");
  });

  test("the key offer names the cheap routes, OpenCode Go and Mistral, in both languages", () => {
    for (const notice of [NOTICES.en, NOTICES.th]) {
      const offer = notice.noAccess({ box: false, key: true, included: false });
      expect(offer).toContain("opencode.ai/go");
      expect(offer).toContain("Mistral");
    }
    expect(NOTICE.noAccess({ box: true, key: false, included: false })).not.toContain("Mistral");
  });

  test("MODEL_BACKEND=anthropic, left in an old deploy's env, fails loudly instead of serving on our key", () => {
    expect(() => loadConfig({ MODEL_BACKEND: "anthropic" } as unknown as Env)).toThrow("MODEL_BACKEND=anthropic was removed");
    expect(loadConfig({ KEY_SECRET: TEST_KEY_SECRET, PUBLIC_URL: "https://giraffes.test" } as unknown as Env)).toMatchObject({
      model: { backend: "live" },
      included: { on: false },
      keys: { on: true },
    });
  });

  test("a live deploy refuses to start without KEY_SECRET, since people's keys are how it answers; a dev backend may run without one", () => {
    expect(() => loadConfig({} as unknown as Env)).toThrow("KEY_SECRET");
    expect(() => loadConfig({ PUBLIC_URL: "https://giraffes.test" } as unknown as Env)).toThrow("KEY_SECRET");
    expect(loadConfig({ MODEL_BACKEND: "scripted", DEV_MODE: "1" } as unknown as Env).keys.on).toBe(false);
  });

  test("Telegram accepts a 32-character URL-safe webhook secret and rejects short or invalid ones", () => {
    const base = { ...env, TELEGRAM_BOT_TOKEN: "123:abc" };
    const secret = "A0_-".repeat(8);
    expect(loadConfig({ ...base, TELEGRAM_WEBHOOK_SECRET: secret }).telegram?.webhookSecret).toBe(secret);
    for (const invalid of [secret.slice(1), `${secret}+`, `${secret}\n`]) {
      expect(() => loadConfig({ ...base, TELEGRAM_WEBHOOK_SECRET: invalid })).toThrow("TELEGRAM_WEBHOOK_SECRET");
    }
  });
});

describe("a person's own key", () => {
  test("a turn runs on their OpenCode Go key, is reserved and charged to their own spend, and the key appears nowhere in clear", async () => {
    const provider = fakeProvider([reply("Hi from your key.")]);
    const c = await devChat("bea", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent, { key: KEY });

    await c.say("hello");

    expect(await c.received()).toEqual(["Hi from your key."]);
    const [req] = provider.seen;
    expect(req.url).toBe("https://opencode.ai/inference/go/anthropic/v1/messages");
    expect(req.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(req.headers.get("x-opencode-session")).toMatch(/^[0-9a-f]{32}$/);
    expect(c.logs("model_call").map((l) => [l.backend, l.status])).toEqual([["key", "settled"]]);
    const snap = await c.snapshot();
    expect(snap.access.spentMicro.byok).toBeGreaterThan(0);
    expect(snap.access.spentMicro.included).toBe(0);
    expect(snap.access.key).toMatchObject({ provider: "opencode-go", hint: KEY.slice(-4), health: "ok" });
    expect(JSON.stringify(snap)).not.toContain(KEY);
    expect(JSON.stringify(c.logs("model_call"))).not.toContain(KEY);
    expect(await doDump(c.agent)).not.toContain(KEY);
  });

  test("the dev lane never sits behind a person's own key", async () => {
    const model = scripted([chat("From the dev lane.")]);
    const provider = fakeProvider([reply("From your key.")]);
    const c = await devChat("bel", { model, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent);

    await c.say("hello");

    expect(await c.received()).toEqual(["From your key."]);
    expect(model.calls).toHaveLength(0);
  });

  test("a refused key rests, the person is told once, every later message is answered with the problem, and after an hour it is tried again", async () => {
    const provider = fakeProvider([{ kind: "status", status: 401 }, reply("Back again.")]);
    const c = await devChat("cal", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent);
    const refused = NOTICE.keyRefused("OpenCode Go");

    await c.say("hello");
    await c.say("still there?");
    expect(await c.received()).toEqual([refused, refused]);
    expect((await c.snapshot()).outbox.map((o) => o.intent)).toEqual(["requested", "reply"]);
    expect(provider.seen).toHaveLength(1);
    expect((await c.snapshot()).access.key?.health).toBe("resting:credential");

    c.clock.set(local("2099-11-04T11:01"));
    await c.say("and now?");
    expect(await c.received()).toEqual(["Back again."]);
    expect((await c.snapshot()).access.key?.health).toBe("ok");
    expect(c.logs("model_call").map((l) => [l.status, l.costMicro])).toEqual([
      ["provider_refused", 0],
      ["settled", expect.any(Number)],
    ]);
  });

  test("a key that keeps failing is announced at most once a local day, and no message goes unanswered", async () => {
    const refused401: ProviderStep = { kind: "status", status: 401 };
    const provider = fakeProvider([refused401, refused401, refused401]);
    const c = await devChat("cam", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent);
    const refused = NOTICE.keyRefused("OpenCode Go");
    const pushes = async () => (await c.snapshot()).outbox.filter((o) => o.intent === "requested").length;

    await c.say("hello");
    c.clock.set(local("2099-11-04T11:01"));
    await c.say("again");
    c.clock.set(local("2099-11-04T11:30"));
    await c.say("and again");
    expect(await c.received()).toEqual([refused, refused, refused]);
    expect(provider.seen).toHaveLength(2);
    expect(await pushes()).toBe(1);

    c.clock.set(local("2099-11-05T10:00"));
    await c.say("new day");
    c.clock.set(local("2099-11-05T10:05"));
    await c.say("still?");
    expect(await c.received()).toEqual([refused, refused]);
    expect(provider.seen).toHaveLength(3);
    expect(await pushes()).toBe(2);
  });

  test("a usage window is waited out: the person is told when, and the message is retried after the backoff", async () => {
    const provider = fakeProvider([{ kind: "status", status: 429, retryAfter: "3600" }]);
    const c = await devChat("cy", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent);

    await c.say("hello");
    await c.advanceTo("2099-11-04T10:05");

    expect(await c.received()).toEqual([NOTICE.keyRateLimited("OpenCode Go", "2099-11-04 11:01"), NOTICE.failed]);
    expect(provider.seen).toHaveLength(1);
  });

  const rateLimitNotice = async (user: string, deadlineOffsetMs: number, channel?: "line" | "telegram"): Promise<string> => {
    const provider = fakeProvider([{ kind: "status", status: 429, retryAfter: "14400" }]);
    const c = await devChat(user, { model: null, provider, at: "2099-11-04T19:58", ...(channel === undefined ? {} : { channel }) });
    await giveKey(c.agent);
    c.clock.set((local("2099-11-05T00:00") - 14_400_000 + deadlineOffsetMs - MESSAGE_QUIET_WINDOW_MS) as EpochMs);

    await c.say("hello");

    return (await c.received())[0];
  };

  test.each([
    { offsetMs: -1, display: "2099-11-05 00:00" },
    { offsetMs: 0, display: "2099-11-05 00:00" },
    { offsetMs: 1, display: "2099-11-05 00:01" },
  ])("the English retry notice rounds a midnight deadline at millisecond offset $offsetMs up to a dated minute", async ({ offsetMs, display }) => {
    expect(await rateLimitNotice(`rate-en-${offsetMs}`, offsetMs)).toBe(NOTICE.keyRateLimited("OpenCode Go", display));
  });

  test("the Thai retry notice shows the next day's date and a minute no earlier than the deadline", async () => {
    expect(await rateLimitNotice("U00000000000000000000000000000a05", 1, "line")).toBe(NOTICES.th.keyRateLimited("OpenCode Go", "2099-11-05 00:01"));
  });

  test("the retry notice shows the date and minute in the person's own time zone", async () => {
    const provider = fakeProvider([reply("Hi."), { kind: "status", status: 429, retryAfter: "90" }]);
    const c = await devChat("rate-london", { model: null, provider, at: "2099-11-05T06:30" });
    await giveKey(c.agent);
    await c.say("hello");
    await c.received();
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_a, state) => {
      state.storage.sql.exec("UPDATE agent SET tz = 'Europe/London'");
    });
    c.clock.set((local("2099-11-05T06:59") + 30_000 - MESSAGE_QUIET_WINDOW_MS) as EpochMs);

    await c.say("one more thing");

    expect((await c.received())[0]).toBe(NOTICE.keyRateLimited("OpenCode Go", "2099-11-05 00:01"));
  });

  test("when the clocks go back, the retry notice skips the repeated hour so no reading of it is before the deadline", async () => {
    const provider = fakeProvider([reply("Hi."), { kind: "status", status: 429, retryAfter: "4500" }]);
    const c = await devChat("rate-london-fall-back", { model: null, provider, at: "2099-10-25T06:00" });
    await giveKey(c.agent);
    await c.say("hello");
    await c.received();
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_a, state) => {
      state.storage.sql.exec("UPDATE agent SET tz = 'Europe/London'");
    });
    c.clock.set(local("2099-10-25T07:15"));

    await c.say("one more thing");

    expect((await c.received())[0]).toBe(NOTICE.keyRateLimited("OpenCode Go", "2099-10-25 02:00"));
  });

  test("a requested reminder still arrives, written by code, while the person's key is refused", async () => {
    const provider = fakeProvider([
      { kind: "output", value: { actions: [schedule("clinic", "2099-11-04T18:00", "call the clinic"), send("Done.")], tasks: [], about: "" } },
      { kind: "status", status: 401 },
    ]);
    const c = await devChat("dee", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent);
    await c.say("remind me at 6pm to call the clinic");

    await c.advanceTo("2099-11-04T18:00");

    expect(await c.received()).toEqual(["Done.", NOTICE.keyRefused("OpenCode Go"), "Reminder: call the clinic"]);
  });

  test("over the monthly limit the person set, nothing is sent, they are told once a day, and the refusal is logged", async () => {
    const provider = fakeProvider();
    const c = await devChat("eda", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent, { capMicro: 10 });

    await c.say("hello");
    await c.say("hello?");

    expect(await c.received()).toEqual([NOTICE.ownCapReached("0.00")]);
    expect(provider.seen).toHaveLength(0);
    expect(c.logs("model_call").map((l) => [l.backend, l.status])).toEqual([
      ["key", "refused_user_cap"],
      ["key", "refused_user_cap"],
    ]);
  });

  test("someone who adds the agent over the monthly limit they set gets the cap notice then, and not again that day", async () => {
    const provider = fakeProvider();
    const c = await devChat("eff", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent, { capMicro: 10 });

    await c.say("/follow");
    expect(await c.received()).toEqual([NOTICE.ownCapReached("0.00")]);
    await c.say("hello");
    expect(await c.received()).toEqual([]);
    expect(provider.seen).toHaveLength(0);
    expect(c.logs("turn").map((l) => [l.eventKind, l.outcome])).toEqual([
      ["lifecycle", "refused_budget"],
      ["message", "refused_budget"],
    ]);
  });

  test("in loose mode a bad reply is repaired once, and both attempts are charged", async () => {
    const provider = fakeProvider([{ kind: "text", text: "Sure! Here you go" }, reply("Repaired.")]);
    const c = await devChat("eli", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent, { provider: "alibaba", key: "sk-alibaba-0123456789", mode: "loose" });

    await c.say("hello");

    expect(await c.received()).toEqual(["Repaired."]);
    expect(provider.seen[0].body.response_format).toEqual({ type: "json_object" });
    expect((provider.seen[1].body.messages as unknown[]).length).toBe(4);
    expect(c.logs("model_call").map((l) => l.status)).toEqual(["settled", "settled"]);
  });

  test("a route with a small budget gets a fitted prompt: the oldest conversation goes first and the new message stays", async () => {
    const steps = Array.from({ length: 21 }, (_, i) => reply(`Reply ${i}.`));
    const provider = fakeProvider(steps);
    const c = await devChat("fay", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent, { provider: "alibaba", key: "sk-alibaba-0123456789", mode: "strict" });

    for (let i = 0; i < 20; i++) await c.say(`${i} ${"ก".repeat(1_500)}`);
    await c.say("the newest");

    const last = provider.seen.at(-1)!.body.messages as { role: string; content: string }[];
    const budget = routeFor({ kind: "key", provider: "alibaba", model: "qwen3.7-flash" }, "turn").promptBytes;
    expect(bytesOf(last[0].content) + bytesOf(last[1].content)).toBeLessThanOrEqual(budget);
    expect(last[0].content).toBe(TURN_SYSTEM);
    expect(last[1].content).toContain("earlier lines left out");
    expect(last[1].content).toContain("Person: the newest");
  });
});

describe("operator transitions", () => {
  test("KEY_SECRET rotated with KEY_SECRET_PREVIOUS set: the key opens with the old secret and is resealed with the new one", async () => {
    const provider = fakeProvider([reply("One."), reply("Two.")]);
    const fresh = "rotated-key-secret-abcdefghijklmnopqrstuv";
    const c = await devChat("gil", { model: null, provider, at: "2099-11-04T10:00", keys: { ...TEST_KEYS, secrets: { current: fresh, previous: TEST_KEY_SECRET } } });
    await giveKey(c.agent);

    await c.say("hello");
    expect(await c.received()).toEqual(["One."]);
    const kid = await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_a, s) => new AgentStore(s.storage).key()?.sealed.kid);
    expect(kid).toBe(await kidOf(fresh));

    const after = await devChat("gil", { model: null, provider, at: "2099-11-04T10:05", keys: { ...TEST_KEYS, secrets: { current: fresh, previous: null } } });
    await after.say("again");
    expect(await after.received()).toEqual(["Two."]);
  });

  test("KEY_SECRET changed without KEY_SECRET_PREVIOUS: the key can't be opened, the person is told, every message names the problem, and nothing is sent", async () => {
    const provider = fakeProvider();
    const c = await devChat("hal", { model: null, provider, at: "2099-11-04T10:00", keys: { ...TEST_KEYS, secrets: { current: "another-key-secret-abcdefghijklmnopqrs", previous: null } } });
    await giveKey(c.agent);

    await c.say("hello");
    await c.say("hello?");

    expect(await c.received()).toEqual([NOTICE.keyUnreadable, NOTICE.keyUnreadable]);
    expect(provider.seen).toHaveLength(0);
    expect((await c.snapshot()).access.key?.health).toBe("resting:unreadable");
  });

  test("a key found unreadable is opened again once the configured secret changes, here back to the one that sealed it", async () => {
    const provider = fakeProvider([reply("Readable again.")]);
    const wrong = { ...TEST_KEYS, secrets: { current: "another-key-secret-abcdefghijklmnopqrs", previous: null } };
    const c = await devChat("hel", { model: null, provider, at: "2099-11-04T10:00", keys: wrong });
    await giveKey(c.agent);
    await c.say("hello");
    expect(await c.received()).toEqual([NOTICE.keyUnreadable]);

    const fixed = await devChat("hel", { model: null, provider, at: "2099-11-04T10:05" });
    await fixed.say("hello again");

    expect(await fixed.received()).toEqual(["Readable again."]);
    expect((await fixed.snapshot()).access.key?.health).toBe("ok");
  });

  test("a key found unreadable while keys were off works again as soon as KEY_SECRET is set", async () => {
    const provider = fakeProvider([reply("Keys are on.")]);
    const c = await devChat("hem", { model: null, provider, at: "2099-11-04T10:00", keys: { on: false, defaultCapMicro: 5_000_000 as MicroUsd } });
    await giveKey(c.agent);
    await c.say("hello");
    expect((await c.snapshot()).access.key?.health).toBe("resting:unreadable");

    const on = await devChat("hem", { model: null, provider, at: "2099-11-04T10:05" });
    await on.say("hello again");

    expect(await on.received()).toEqual(["Keys are on."]);
  });

  test("a sealed key names the secret that sealed it by a short HMAC of a fixed label", async () => {
    const expected = createHmac("sha256", TEST_KEY_SECRET).update("giraffes key fingerprint").digest("hex").slice(0, 12);
    expect(await kidOf(TEST_KEY_SECRET)).toBe(expected);
  });

  test("a deploy over open reservations: one a dead instance left is charged at its estimate and logged once", async () => {
    const c = await devChat("ivy", { model: scripted([chat("Hi.")]), at: "2099-11-04T10:00" });
    await c.say("hi");
    await c.received();
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_a, s) =>
      new AgentStore(s.storage).reserve(
        { id: "r-dead", month: "2099-11" as UtcMonth, scope: "byok", purpose: "turn", model: "opencode-go:claude-haiku-5-5", backend: "key", estimate: 1234 as MicroUsd, instance: "" },
        local("2099-11-04T10:00"),
      ),
    );

    await c.say("again");
    await c.say("and again");

    expect(c.logs("model_call").filter((l) => l.id === "r-dead").map((l) => [l.status, l.backend, l.costMicro])).toEqual([["recovered_after_crash", "key", 1234]]);
    expect((await c.snapshot()).access.spentMicro.byok).toBe(1234);
  });
});

describe("the dev lane", () => {
  test("a scripted dev run without a script has no access, and one with a script answers", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName("p:dev:kit" as AgentKey));
    const c = await devChat("kit", { model: null, at: "2099-11-04T10:00" });
    await c.say("hi");
    expect(await c.received()).toEqual([ONBOARDING]);

    await runInDurableObject<Agent, void>(stub, (a) => a.script([{ actions: [send("Scripted.")], tasks: [], about: "" }], []));
    await c.say("hi again");
    expect(await c.received()).toEqual(["Scripted."]);
  });

  test("a canned output that drifts from the schema fails loudly", async () => {
    const model = scripted([{ kind: "output", value: { actions: "none" } }]);
    const route = routeFor({ kind: "dev", model: "claude-haiku-5-5" }, "turn");
    await expect(model.send({ route, mode: "strict", system: "s", user: "u", schema: {}, repair: null })).rejects.toThrow(/doesn't match the schema/);
  });
});

describe("money a provider may have billed", () => {
  const turnBody = (text: string) => JSON.stringify({ actions: [send(text)], tasks: [], about: "" });
  const custom = { provider: "openai-compatible", baseUrl: "https://llm.example.com/v1", model: "custom-model", key: "abcd1234abcd1234" } as const;

  test("an OpenAI-compatible reply with no usage is charged at its reservation's estimate and logged as usage_missing", async () => {
    const provider = fakeProvider([{ kind: "raw", body: { choices: [{ message: { content: turnBody("Hi.") }, finish_reason: "stop" }] } }]);
    const c = await devChat("mo", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent, custom);

    await c.say("hello");

    expect(await c.received()).toEqual(["Hi."]);
    const calls = c.logs("model_call");
    expect(calls.map((l) => l.status)).toEqual(["usage_missing"]);
    expect(calls[0].costMicro).toBeGreaterThan(0);
    expect(calls[0].costMicro).toBe(calls[0].estimateMicro);
    expect((await c.snapshot()).access.spentMicro.byok).toBe(calls[0].estimateMicro);
  });

  test("an Anthropic 200 whose body doesn't parse is charged at the estimate, not $0", async () => {
    const provider = fakeProvider([{ kind: "raw", body: "<html>gateway</html>" }]);
    const c = await devChat("mu", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent);

    await c.say("hello");

    expect(await c.received()).toEqual([NOTICE.failed]);
    const calls = c.logs("model_call");
    expect(calls.map((l) => l.status)).toEqual(["usage_missing"]);
    expect(calls[0].costMicro).toBe(calls[0].estimateMicro);
    expect((await c.snapshot()).access.spentMicro.byok).toBe(calls[0].estimateMicro);
  });

  test("replies with no usage stop at the cap like any other", async () => {
    const steps = Array.from({ length: 10 }, (): ProviderStep => ({ kind: "raw", body: { choices: [{ message: { content: turnBody("Hi.") }, finish_reason: "stop" }] } }));
    const provider = fakeProvider(steps);
    const c = await devChat("my", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent, { ...custom, capMicro: 20_000 });

    for (let i = 0; i < 6; i++) await c.say(`hello ${i}`);

    const statuses = c.logs("model_call").map((l) => l.status);
    expect(statuses).toContain("refused_user_cap");
    expect((await c.snapshot()).access.spentMicro.byok).toBeLessThanOrEqual(20_000);
  });

  test("a provider that never answers times out as in_doubt, is charged at the estimate, and the next message is still answered", async () => {
    const provider = fakeProvider([{ kind: "hang" }, reply("Back.")]);
    const c = await devChat("nan", { model: null, provider, at: "2099-11-04T10:00", timeouts: { turn: 30, compaction: 30, probe: 30 } });
    await giveKey(c.agent);

    await c.say("hello");
    c.clock.set(local("2099-11-04T10:01"));
    await c.say("still there?");

    expect(await c.received()).toEqual(["Back."]);
    const calls = c.logs("model_call");
    expect(calls.map((l) => l.status)).toEqual(["in_doubt", "settled"]);
    expect(calls[0].costMicro).toBe(calls[0].estimateMicro);
    expect(provider.seen.at(-1)!.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining("still there?") })]));
  });

  test("a body that stalls after the headers also times out as in_doubt", async () => {
    const stalled = Object.assign(
      async (_input: string, init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(new TextEncoder().encode('{"content": ['));
              init?.signal?.addEventListener("abort", () => ctrl.error(init.signal!.reason), { once: true });
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      { steps: [], seen: [] },
    );
    const c = await devChat("ned", { model: null, provider: stalled, at: "2099-11-04T10:00", timeouts: { turn: 30, compaction: 30, probe: 30 } });
    await giveKey(c.agent);

    await c.say("hello");

    expect(c.logs("model_call").map((l) => l.status)).toEqual(["in_doubt"]);
  });
});

describe("pricing a model no preset lists", () => {
  test("an unlisted model is priced at the dearest card its protocol's presets publish, and marked approximate", () => {
    const dear = { ...PROVIDERS.anthropic.models["claude-haiku-5-5"].card, inputPerM: 3_000_000, outputPerM: 15_000_000 };
    const table = { ...PROVIDERS, deepinfra: { ...PROVIDERS.deepinfra, models: { ...PROVIDERS.deepinfra.models, "big-model": { name: "Big", pick: null, card: { ...dear, longPrompt: null }, effort: false } } } };

    const openai = modelOf("openai-compatible", "whatever", table);
    expect(openai.priced).toBe(false);
    expect(openai.model.card.outputPerM).toBe(15_000_000);
    expect(modelOf("anthropic-compatible", "whatever", table).model.card.outputPerM).toBe(PROVIDERS["opencode-go"].models["claude-haiku-5-5"].card.outputPerM);
    expect(modelOf("deepinfra", "big-model", table).priced).toBe(true);
  });

  test("with today's presets no listed model of a protocol is dearer than an unlisted one", () => {
    for (const [unlisted, protocol] of [["anthropic-compatible", "anthropic"], ["openai-compatible", "openai"]] as const) {
      const card = modelOf(unlisted, "whatever").model.card;
      for (const p of Object.values(PROVIDERS).filter((p) => p.protocol === protocol)) {
        for (const m of Object.values(p.models)) expect(card.inputPerM + card.outputPerM).toBeGreaterThanOrEqual(m.card.inputPerM + m.card.outputPerM);
      }
    }
  });
});
