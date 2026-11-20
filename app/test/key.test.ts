import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { draftKey, KEY_REMOVED, redactSecrets } from "../src/access/key";
import { AgentStore } from "../src/agent/store";
import { eventKey, type AgentKey, type LocalDate, type MicroUsd } from "../src/domain";
import { NOTICES } from "../src/notices";
import { chat, devChat, fakeBox, fakeProvider, giveKey, local, scripted, send, type DevChat, type ProviderStep } from "./testkit";

const NOTICE = NOTICES.en;
const KEY = "oc_sk_live_abcdefghijklmnop0123456789";
const PROBE_OK: ProviderStep = { kind: "output", value: { ok: true } };
const reply = (text: string): ProviderStep => ({ kind: "output", value: { actions: [send(text)], tasks: [], about: "" } });
const LINK = /https:\/\/giraffes\.test\/key#t=([^&\s]+)&l=(en|th)/;

async function keyLink(c: DevChat): Promise<string> {
  await c.say("/key");
  const text = (await c.received()).join("\n");
  const m = LINK.exec(text);
  if (!m) throw new Error(`no key link in: ${text}`);
  return m[1];
}

function submit(ticket: string, fields: Partial<{ provider: string; model: string; baseUrl: string; key: string }> = {}): Promise<Response> {
  const body = { ticket, provider: "opencode-go", model: "", baseUrl: "", key: KEY, ...fields };
  return SELF.fetch("https://giraffes.test/key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function doDump(agent: AgentKey): Promise<string> {
  return runInDurableObject(env.AGENT.get(env.AGENT.idFromName(agent)), (_a, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'")
      .toArray();
    return JSON.stringify(tables.map(({ name }) => state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray()));
  });
}

describe("entering a key on the page", () => {
  test("/key sends a one-time link whose ticket rides in the fragment, kept out of the history, with no model call", async () => {
    const model = scripted([]);
    const c = await devChat("amy", { model, at: "2099-11-04T10:00" });

    await c.say("/key");

    const [text] = await c.received();
    expect(text).toMatch(LINK);
    expect(text).not.toMatch(/\/key\?/);
    expect(JSON.stringify((await c.snapshot()).turns)).not.toContain("giraffes.test/key#");
    expect((await c.snapshot()).turns.at(-1)?.text).toContain("<key link>");
    expect(model.calls).toHaveLength(0);
  });

  test("the page is static, uncached, sends no referrer and runs no outside script", async () => {
    const res = await SELF.fetch("https://giraffes.test/key");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self'");
    const html = await res.text();
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain("OpenCode Go");
    expect(html).toContain(NOTICES.th.keyPage.connect);
  });

  test("a good key is probed once, sealed, and announced in the chat, and never appears in clear in the DO, the logs or a reply", async () => {
    const provider = fakeProvider([PROBE_OK, reply("Hi from your key.")]);
    const logged = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const c = await devChat("bob", { model: null, provider, at: "2099-11-04T10:00" });
    const ticket = await keyLink(c);

    const res = await submit(ticket);
    await c.settle();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider: "OpenCode Go", model: "claude-haiku-5-5" });
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0].body).toMatchObject({ max_tokens: 64, output_config: { format: { type: "json_schema" } } });
    expect(await c.received()).toEqual([NOTICE.keyConnected("OpenCode Go", "claude-haiku-5-5")]);
    expect(c.logs("model_call").map((l) => [l.purpose, l.backend, l.status])).toEqual([["probe", "key", "settled"]]);

    await c.say("hello");
    expect(await c.received()).toEqual(["Hi from your key."]);
    expect((await c.snapshot()).access.key).toMatchObject({ provider: "opencode-go", mode: "strict", hint: KEY.slice(-4) });
    expect(await doDump(c.agent)).not.toContain(KEY);
    expect(JSON.stringify(c.logs("model_call")) + JSON.stringify(c.logs("turn"))).not.toContain(KEY);
    expect(logged.flatMap((s) => s.mock.calls.flat().map(String)).join(" ")).not.toContain(KEY);
    vi.restoreAllMocks();
  });

  test("the ticket is single use: a repeat submission gets the stored outcome and calls no provider", async () => {
    const provider = fakeProvider([PROBE_OK]);
    const c = await devChat("cat", { model: null, provider, at: "2099-11-04T10:00" });
    const ticket = await keyLink(c);
    await submit(ticket);

    const again = await submit(ticket, { key: "oc_sk_someone_else_entirely_0000" });

    expect(await again.json()).toEqual({ ok: true, provider: "OpenCode Go", model: "claude-haiku-5-5" });
    expect(provider.seen).toHaveLength(1);
  });

  test("a key the provider refuses fails the ticket for good, and /key gives a new link that works", async () => {
    const provider = fakeProvider([{ kind: "status", status: 401 }, PROBE_OK]);
    const c = await devChat("dan", { model: null, provider, at: "2099-11-04T10:00" });
    const first = await keyLink(c);

    expect(await (await submit(first)).json()).toEqual({ ok: false, error: "bad_key" });
    expect(await (await submit(first)).json()).toEqual({ ok: false, error: "bad_key" });
    expect(provider.seen).toHaveLength(1);
    expect((await c.snapshot()).access.key).toBeNull();

    const second = await keyLink(c);
    expect(await (await submit(second)).json()).toMatchObject({ ok: true });
  });

  test("a form mistake doesn't use up the link", async () => {
    const provider = fakeProvider([PROBE_OK]);
    const c = await devChat("eve", { model: null, provider, at: "2099-11-04T10:00" });
    const ticket = await keyLink(c);

    expect(await (await submit(ticket, { provider: "nope" })).json()).toEqual({ ok: false, error: "unknown_provider" });
    expect(await (await submit(ticket, { key: "sk-ant-not-a-go-key-0000" })).json()).toEqual({ ok: false, error: "key_shape" });
    expect(await (await submit(ticket, { provider: "openai-compatible", baseUrl: "http://llm.example.com/v1", model: "m", key: "abcd1234abcd1234" })).json()).toEqual({
      ok: false,
      error: "bad_url",
    });
    expect(provider.seen).toHaveLength(0);
    expect(await (await submit(ticket)).json()).toMatchObject({ ok: true });
  });

  test("an expired, tampered or superseded link is refused before any provider call", async () => {
    const provider = fakeProvider([PROBE_OK]);
    const c = await devChat("fay", { model: null, provider, at: "2099-11-04T10:00" });
    const old = await keyLink(c);
    const ticket = await keyLink(c);

    expect(await (await submit(old)).json()).toEqual({ ok: false, error: "expired" });
    const tampered = `${ticket.slice(0, -2)}${ticket.endsWith("AA") ? "BB" : "AA"}`;
    expect((await submit(tampered)).status).toBe(401);
    c.clock.set(local("2099-11-04T10:16"));
    expect(await (await submit(ticket)).json()).toEqual({ ok: false, error: "expired" });
    expect(provider.seen).toHaveLength(0);
  });

  test("a key removed while its link was out can't come back through that link", async () => {
    const provider = fakeProvider([PROBE_OK]);
    const c = await devChat("gus", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent);
    const ticket = await keyLink(c);
    await c.say("/key remove");
    expect(await c.received()).toEqual([NOTICE.keyRemoved]);

    expect(await (await submit(ticket)).json()).toEqual({ ok: false, error: "superseded" });
    expect((await c.snapshot()).access.key).toBeNull();
  });

  test("an endpoint that refuses a strict schema is probed loose, and the key keeps that mode", async () => {
    const provider = fakeProvider([{ kind: "status", status: 400, body: { error: { message: "response_format is not supported" } } }, PROBE_OK]);
    const c = await devChat("hal", { model: null, provider, at: "2099-11-04T10:00" });
    const ticket = await keyLink(c);

    const res = await submit(ticket, { provider: "openai-compatible", baseUrl: "https://llm.example.com/v1", model: "my-model", key: "abcd1234abcd1234" });

    expect(await res.json()).toEqual({ ok: true, provider: "Other (OpenAI-compatible)", model: "my-model" });
    expect(provider.seen.map((s) => (s.body.response_format as { type: string }).type)).toEqual(["json_schema", "json_object"]);
    expect((await c.snapshot()).access.key?.mode).toBe("loose");
  });
});

describe("the key commands", () => {
  test("/key with a key says what it is, its month's spend against its limit, and gives a replacement link", async () => {
    const c = await devChat("ida", { model: null, at: "2099-11-04T10:00" });
    await giveKey(c.agent, { key: KEY });

    await c.say("/key");

    const [text] = await c.received();
    expect(text).toContain("Your key: OpenCode Go, claude-haiku-5-5, ending 6789.");
    expect(text).toContain("This month: $0.00 of your $5.00 limit.");
    expect(text).toMatch(LINK);
    expect(text).not.toContain(KEY);
  });

  test("/key cap sets the monthly limit within its range, and /key remove forgets the key", async () => {
    const c = await devChat("jo", { model: null, at: "2099-11-04T10:00" });
    await c.say("/key cap 10");
    await giveKey(c.agent);
    await c.say("/key cap 10");
    await c.say("/key cap 9999");
    await c.say("/key remove");
    await c.say("/key remove");

    expect(await c.received()).toEqual([NOTICE.noKey, NOTICE.keyCapSet("10.00"), NOTICE.keyCapRange("0.50", "500.00"), NOTICE.keyRemoved, NOTICE.noKey]);
  });
});

describe("a key alongside a Claude plan", () => {
  test("the person is asked once, with a button, whether their key may back up their plan, and a tap says yes", async () => {
    const box = fakeBox({ signedIn: true });
    const provider = fakeProvider([PROBE_OK, reply("From your key.")]);
    const c = await devChat("kim", { model: scripted([]), provider, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();
    const ticket = await keyLink(c);

    await submit(ticket);
    await c.settle();
    expect(await c.received()).toEqual([NOTICE.keyConnected("OpenCode Go", "claude-haiku-5-5"), NOTICE.backupAsk("OpenCode Go")]);
    const button = c.channel.delivered.at(-1)?.button;
    expect(button).toEqual({ label: NOTICE.backupButton, data: expect.stringMatching(/^b:\d+$/) });
    expect((await c.snapshot()).access.key?.backup).toBe(false);

    await c.tap(button!.data);
    expect(await c.received()).toEqual([NOTICE.backupOn]);
    expect((await c.snapshot()).access.key?.backup).toBe(true);

    box.replies.push({ kind: "status", status: 503 });
    await c.say("hello");
    expect(await c.received()).toEqual(["From your key."]);
  });

  test("a box set up after the key brings the same question once, as soon as the box exists", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("lee", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("hi");
    await giveKey(c.agent);
    await c.received();

    await c.say("/claude");
    await c.say("/claude");

    expect(await c.received()).toEqual([
      NOTICES.en.box.setting_up("", ""),
      NOTICE.backupAsk("OpenCode Go"),
      NOTICES.en.box.connected("", ""),
      NOTICES.en.box.already_connected("", ""),
    ]);
  });
});

describe("no consent, no key: a person who has or had a Claude plan box", () => {
  const BOX = NOTICES.en.box;

  test("while the plan's box is still being set up, the key isn't used without a yes, and the person is asked", async () => {
    const retry = { retryable: true, detail: "503" };
    const box = fakeBox({ host: [retry, retry, retry, retry] });
    const provider = fakeProvider();
    const c = await devChat("uma", { model: scripted([]), provider, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    expect((await c.snapshot()).box?.state).toBe("provisioning");
    await giveKey(c.agent);
    await c.received();

    await c.say("hello");

    expect(provider.seen).toHaveLength(0);
    const got = await c.received();
    expect(got).toContain(NOTICE.boxNotReady);
    expect(got).toContain(NOTICE.backupAsk("OpenCode Go"));
    expect((await c.snapshot()).access.lanes).toEqual([]);
  });

  test("a box removed by reclaim doesn't make the key primary: the backup question is asked again then", async () => {
    const box = fakeBox();
    const provider = fakeProvider();
    const c = await devChat("vic", { model: scripted([]), provider, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await giveKey(c.agent);
    await c.advanceTo("2099-11-04T10:05");
    expect(await c.received()).toContain(NOTICE.backupAsk("OpenCode Go"));

    await c.advanceTo("2099-11-06T10:30");
    expect((await c.snapshot()).box).toBeNull();
    expect(await c.received()).toEqual([BOX.reclaimed("", ""), NOTICE.backupAsk("OpenCode Go")]);

    await c.say("hello");
    expect(provider.seen).toHaveLength(0);
    expect(await c.received()).toEqual([NOTICE.boxNotReady]);
  });

  test("/claude remove removes the plan's box, asks nothing, and from then on the key answers", async () => {
    const box = fakeBox({ signedIn: true });
    const provider = fakeProvider([reply("From your key.")]);
    const c = await devChat("wyn", { model: scripted([]), provider, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await giveKey(c.agent);
    await c.say("/claude");
    await c.received();

    await c.say("/claude remove");
    expect(await c.received()).toEqual([BOX.removing("", ""), BOX.removed("", "")]);
    expect((await c.snapshot()).box).toBeNull();
    expect(box.created.size).toBe(0);

    await c.say("hello");
    expect(await c.received()).toEqual(["From your key."]);
  });

  test("/claude remove with no box left forgets the plan, so the key answers", async () => {
    const box = fakeBox();
    const provider = fakeProvider([reply("From your key.")]);
    const c = await devChat("xan", { model: scripted([]), provider, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await giveKey(c.agent);
    await c.advanceTo("2099-11-06T10:30");
    await c.received();

    await c.say("/claude remove");
    await c.say("hello");

    expect(await c.received()).toEqual([BOX.removed("", ""), "From your key."]);
  });
});

describe("a key pasted into the chat", () => {
  test("is removed before the message is stored, no model sees it, and the person is told to revoke it with a fresh link", async () => {
    const model = scripted([chat("Next turn.")]);
    const c = await devChat("max", { model, at: "2099-11-04T10:00" });
    const pasted = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

    await c.say(`here is my key ${pasted} thanks`);

    const [text] = await c.received();
    expect(text).toContain(NOTICE.pastedKey(null).split("\n")[0]);
    expect(text).toMatch(LINK);
    expect(model.calls).toHaveLength(0);
    const snap = await c.snapshot();
    expect(snap.turns.map((t) => t.text)).toContain(`here is my key ${KEY_REMOVED} thanks`);
    expect(await doDump(c.agent)).not.toContain(pasted);

    await c.say("ok what now");
    expect(model.calls[0].user).not.toContain(pasted);
    expect(model.calls[0].user).toContain(KEY_REMOVED);
  });

  test.each([
    ["sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", true],
    ["oc_sk_9f8e7d6c5b4a3210fedcba", true],
    ["sk-or-v1-0123456789abcdef0123456789abcdef", true],
    ["my key is aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE ok", true],
    ["ส่ง key ให้แล้วนะ sk-proj-Ab12Cd34Ef56Gh78Ij90", true],
    ["https://maps.app.goo.gl/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", false],
    ["commit 3f9a2c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39", false],
    ["550e8400-e29b-41d4-a716-446655440000", false],
    ["task-management-system-for-the-team-2026", false],
    ["พรุ่งนี้เตือนให้โทรหาคลินิกตอนเก้าโมงนะคะ", false],
    ["sk-learning is fun", false],
    ["key:AbcDef12345678901234567890123456", true],
    ["KEY=AbcDef12345678901234567890123456", true],
    ["my deepinfra key 3f9a2c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a393f9a2c1e8b7d6a5f4e3d2c1b", true],
    ["sk-ant-abcdefghijklmnopqrstuvwx", true],
    ["https://api.example.com/v1/chat?api_key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", true],
    ["https://openrouter.ai/sk-or-v1-0123456789abcdef0123456789abcdef/x", true],
    ["https://example.com/cb?token=aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE&x=1", true],
    ["ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", true],
    ["commit 3f9a2c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39 and 1f9a2c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39", false],
    ["https://github.com/org/repo/commit/3f9a2c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39", false],
  ])("%s is %s", (text, found) => {
    expect(redactSecrets(text).found).toBe(found);
  });

  test("a key inside a link is removed and the rest of the link is kept", () => {
    const r = redactSecrets("try https://api.example.com/v1?api_key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789&model=x please");
    expect(r.text).toBe(`try https://api.example.com/v1?api_key=${KEY_REMOVED}&model=x please`);
  });

  test("a key pasted inside a link never reaches the store or a model", async () => {
    const model = scripted([chat("Next turn.")]);
    const c = await devChat("nia", { model, at: "2099-11-04T10:00" });
    const pasted = "sk-or-v1-0123456789abcdef0123456789abcdef";

    await c.say(`https://openrouter.ai/api/v1/models?key=${pasted}`);
    await c.say("ok");

    expect(await doDump(c.agent)).not.toContain(pasted);
    expect(model.calls.map((x) => x.user).join("")).not.toContain(pasted);
  });
});

describe("every key write is compare-and-set on the key's revision", () => {
  const OTHER = "oc_sk_replacement_key_9876543210";

  test("a provider fault on a key replaced while its call was in flight rests nothing, tells nothing, and the turn retries on the new key", async () => {
    let agent = "" as AgentKey;
    const provider = fakeProvider([
      {
        kind: "call",
        run: async () => {
          await giveKey(agent, { key: OTHER });
          return { kind: "status", status: 401 };
        },
      },
      reply("From the new key."),
    ]);
    const c = await devChat("oli", { model: null, provider, at: "2099-11-04T10:00" });
    agent = c.agent;
    await giveKey(c.agent, { key: KEY });

    await c.say("hello");
    await c.advanceTo("2099-11-04T10:02");

    expect(await c.received()).toEqual(["From the new key."]);
    expect(provider.seen[1].headers.get("authorization")).toBe(`Bearer ${OTHER}`);
    expect((await c.snapshot()).access.key).toMatchObject({ hint: OTHER.slice(-4), health: "ok" });
  });

  test("a reseal, rest, heal, backup answer, cap or removal made for an older revision changes nothing", async () => {
    const c = await devChat("pam", { model: null, at: "2099-11-04T10:00" });
    await giveKey(c.agent, { key: KEY });
    await giveKey(c.agent, { key: OTHER });
    const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));

    const after = await runInDurableObject(stub, (_a, state) => {
      const store = new AgentStore(state.storage);
      const current = store.key()!;
      const stale = current.revision - 1;
      const now = local("2099-11-04T10:00");
      const writes = [
        store.reseal({ kid: "stale", iv: new Uint8Array(12), ciphertext: new Uint8Array(4) }, stale),
        store.restKey("credential", null, { key: eventKey.access("stale"), message: { texts: ["stale"], note: "stale" } }, "2099-11-04" as LocalDate, now, stale),
        store.setBackup(true, now, stale),
        store.setKeyCap(1 as MicroUsd, stale),
        store.removeKey(stale),
      ];
      return { writes, key: store.key(), revision: current.revision };
    });

    expect(after.writes).toEqual([false, "stale", "stale", false, false]);
    expect(after.key).toMatchObject({ hint: OTHER.slice(-4), revision: after.revision, backup: false, capMicro: 5_000_000, health: { kind: "ok" } });
    expect(after.key?.sealed.kid).not.toBe("stale");
    expect(await c.received()).toEqual([]);
  });

  test("the backup button names the key it asked about: a tap after that key was replaced changes nothing and says so", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("quin", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await giveKey(c.agent, { key: KEY });
    await c.say("/claude");
    await c.received();
    const asked = c.channel.delivered.at(-1)?.button?.data;
    expect(asked).toMatch(/^b:\d+$/);

    await giveKey(c.agent, { key: OTHER });
    await c.tap(asked!);
    expect(await c.received()).toEqual([NOTICE.backupStale]);
    expect((await c.snapshot()).access.key?.backup).toBe(false);

    await c.tap("b");
    expect(await c.received()).toEqual([NOTICE.backupStale]);
    expect((await c.snapshot()).access.key?.backup).toBe(false);
  });

  test("a tap on the button for the current key turns backup on", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("ros", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await giveKey(c.agent, { key: KEY });
    await c.say("/claude");
    await c.received();

    await c.tap(c.channel.delivered.at(-1)!.button!.data);

    expect(await c.received()).toEqual([NOTICE.backupOn]);
    expect((await c.snapshot()).access.key?.backup).toBe(true);
  });
});

describe("the Mistral preset", () => {
  test("a pasted Mistral key with no model gets Mistral Small 4 on Mistral's own URL", () => {
    expect(draftKey({ provider: "mistral", model: "", baseUrl: "", key: "AbCdEfGhIjKlMnOpQrStUvWxYz012345" }, { devMode: false })).toMatchObject({
      ok: true,
      value: { provider: "mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-2603" },
    });
  });

  test("a pasted Vibe plan key with no model gets the same Small 4 on the same URL", () => {
    expect(draftKey({ provider: "mistral-vibe", model: "", baseUrl: "", key: "AbCdEfGhIjKlMnOpQrStUvWxYz012345" }, { devMode: false })).toMatchObject({
      ok: true,
      value: { provider: "mistral-vibe", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-2603" },
    });
  });
});

describe("a dev run's stub provider", () => {
  test("with DEV_MODE a preset may point at a loopback stub, so its own route is exercised; without it the preset's URL stands", () => {
    const fields = { provider: "alibaba", model: "", baseUrl: "http://127.0.0.1:18801/v1", key: "sk-alibaba-0123456789" };
    expect(draftKey(fields, { devMode: true })).toMatchObject({ ok: true, value: { provider: "alibaba", baseUrl: "http://127.0.0.1:18801/v1", model: "qwen3.7-flash" } });
    expect(draftKey(fields, { devMode: false })).toMatchObject({ ok: true, value: { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" } });
    expect(draftKey({ ...fields, baseUrl: "https://elsewhere.example.com/v1" }, { devMode: true })).toEqual({ ok: false, error: "bad_url" });
    expect(draftKey({ ...fields, baseUrl: "" }, { devMode: true })).toMatchObject({ ok: true, value: { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" } });
  });
});
