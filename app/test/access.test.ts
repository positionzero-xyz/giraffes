import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { kidOf } from "../src/access/key";
import type { Agent } from "../src/agent/agent";
import { AgentStore } from "../src/agent/store";
import { TURN_SYSTEM } from "../src/agent/prompt";
import { loadConfig, type Env } from "../src/config";
import type { AgentKey, MicroUsd, UtcMonth } from "../src/domain";
import { bytesOf } from "../src/model/prompt";
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

  test("the offer names only what this deploy can give", () => {
    expect(NOTICE.noAccess({ box: true, key: true, included: false })).toContain("/claude");
    expect(NOTICE.noAccess({ box: false, key: true, included: false })).not.toContain("/claude");
    expect(NOTICE.noAccess({ box: false, key: true, included: true })).toContain("/plan");
    expect(NOTICES.th.noAccess({ box: true, key: true, included: false })).toContain("/key");
  });

  test("MODEL_BACKEND=anthropic, left in an old deploy's env, fails loudly instead of serving on our key", () => {
    expect(() => loadConfig({ MODEL_BACKEND: "anthropic" } as unknown as Env)).toThrow("MODEL_BACKEND=anthropic was removed");
    expect(loadConfig({} as unknown as Env)).toMatchObject({ model: { backend: "live" }, included: { on: false }, keys: { on: false } });
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
    expect(c.logs("model_call").map((l) => [l.backend, l.model, l.status])).toEqual([["key", "opencode-go:claude-haiku-5-5", "settled"]]);
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

  test("a refused key rests, the person is told once, later messages wait quietly, and after an hour it is tried again", async () => {
    const provider = fakeProvider([{ kind: "status", status: 401 }, reply("Back again.")]);
    const c = await devChat("cal", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent);

    await c.say("hello");
    await c.say("still there?");
    expect(await c.received()).toEqual([NOTICE.keyRefused("OpenCode Go")]);
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

  test("a usage window is waited out: the person is told when, and the message is retried after the backoff", async () => {
    const provider = fakeProvider([{ kind: "status", status: 429, retryAfter: "3600" }]);
    const c = await devChat("cy", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent);

    await c.say("hello");
    await c.advanceTo("2099-11-04T10:05");

    expect(await c.received()).toEqual([NOTICE.keyRateLimited("OpenCode Go", "11:00"), NOTICE.failed]);
    expect(provider.seen).toHaveLength(1);
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

  test("KEY_SECRET changed without KEY_SECRET_PREVIOUS: the key can't be opened, the person is told once, and nothing is sent", async () => {
    const provider = fakeProvider();
    const c = await devChat("hal", { model: null, provider, at: "2099-11-04T10:00", keys: { ...TEST_KEYS, secrets: { current: "another-key-secret-abcdefghijklmnopqrs", previous: null } } });
    await giveKey(c.agent);

    await c.say("hello");
    await c.say("hello?");

    expect(await c.received()).toEqual([NOTICE.keyUnreadable]);
    expect(provider.seen).toHaveLength(0);
    expect((await c.snapshot()).access.key?.health).toBe("resting:unreadable");
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

describe("a group's calls run on its owner's access", () => {
  const prompt = { sections: [{ title: "New", keep: ["Person: hi from the group"], trim: [], dropRank: 0 }] };
  const group = "g:telegram:-100123" as AgentKey;

  test("a group the owner's DO hasn't recorded at that ownership version is refused before anything is spent", async () => {
    const provider = fakeProvider([reply("For the group.")]);
    const c = await devChat("jan", { model: null, provider, at: "2099-11-04T10:00" });
    await c.say("hi");
    await giveKey(c.agent);
    const owner = env.AGENT.get(env.AGENT.idFromName(c.agent));

    expect(await owner.serve({ group, ownershipVersion: 1, purpose: "turn", system: "s", prompt })).toEqual({ kind: "not_owner" });
    await owner.recordGroup(group, 2);
    expect(await owner.serve({ group, ownershipVersion: 1, purpose: "turn", system: "s", prompt })).toEqual({ kind: "not_owner" });
    expect(provider.seen).toHaveLength(0);

    const served = await owner.serve({ group, ownershipVersion: 2, purpose: "turn", system: "s", prompt });
    expect(served).toMatchObject({ kind: "ok", value: { actions: [{ type: "send", text: "For the group." }] }, call: { lane: "key" } });
    expect((await c.snapshot()).access.spentMicro.byok).toBeGreaterThan(0);
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
