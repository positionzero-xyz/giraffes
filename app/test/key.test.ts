import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { KEY_REMOVED, redactSecrets } from "../src/access/key";
import type { AgentKey } from "../src/domain";
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
    expect(c.channel.delivered.at(-1)?.button).toEqual({ label: NOTICE.backupButton, data: "b" });
    expect((await c.snapshot()).access.key?.backup).toBe(false);

    await c.tap("b");
    expect(await c.received()).toEqual([NOTICE.backupOn]);
    expect((await c.snapshot()).access.key?.backup).toBe(true);

    box.replies.push({ kind: "status", status: 503 });
    await c.say("hello");
    expect(await c.received()).toEqual(["From your key."]);
  });

  test("a box connected after the key brings the same question once", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("lee", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("hi");
    await giveKey(c.agent);
    await c.received();

    await c.say("/claude");
    await c.say("/claude");

    expect(await c.received()).toEqual([
      NOTICES.en.box.setting_up("", ""),
      NOTICES.en.box.connected("", ""),
      NOTICE.backupAsk("OpenCode Go"),
      NOTICES.en.box.already_connected("", ""),
    ]);
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
  ])("%s is %s", (text, found) => {
    expect(redactSecrets(text).found).toBe(found);
  });
});
