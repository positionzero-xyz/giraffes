import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { draftKey, KEY_REMOVED, redactSecrets } from "../src/access/key";
import { AgentStore } from "../src/agent/store";
import { eventKey, type AgentKey, type EpochMs, type LocalDate, type MicroUsd } from "../src/domain";
import { NOTICES } from "../src/notices";
import worker from "../src/worker";
import { chat, devChat, fakeBox, fakeProvider, giveKey, local, schedule, scripted, send, type DevChat, type ProviderStep } from "./testkit";

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
  test("a request waits when the new key can afford its probe but not catch-up", async () => {
    const provider = fakeProvider([PROBE_OK, PROBE_OK, reply("I'll help you remember to call Mum.")]);
    const c = await devChat("catch-up-cap", { model: null, provider, at: "2099-11-04T10:00" });
    expect((await submit(await keyLink(c))).status).toBe(200);
    await c.settle();
    await c.received();
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_agent, state) => {
      state.storage.sql.exec("UPDATE spend_month SET spent_micro = 4990000 WHERE scope = 'byok' AND month = '2099-11'");
    });
    await c.say("Can you plan a day trip for us?");
    expect(await c.received()).toEqual([NOTICE.ownCapReached("5.00")]);
    await c.say("/key remove");
    await c.received();
    const request = "Remind me to call Mum at 6.";
    await c.say(request);
    expect((await c.received())[0]).toContain("answer requests from the last 24 hours");

    expect((await submit(await keyLink(c))).status).toBe(200);
    await c.settle();
    expect(await c.received()).toEqual([NOTICE.keyConnected("OpenCode Go", "claude-haiku-5-5")]);
    expect(provider.seen).toHaveLength(2);
    expect(c.logs("turn").at(-1)?.outcome).toBe("refused_budget");

    await c.say("/key cap 10");
    expect(await c.received()).toEqual([NOTICE.keyCapSet("10.00"), `${NOTICE.catchUp}\nI'll help you remember to call Mum.`]);
    expect(provider.seen).toHaveLength(3);
    expect(JSON.stringify(provider.seen[2].body)).toContain(request);
    await c.say("/key cap 11");
    expect(await c.received()).toEqual([NOTICE.keyCapSet("11.00")]);
    expect(provider.seen).toHaveLength(3);
  });

  test("a key out of credit says when the key can be tried again without promising to replay requests", async () => {
    const provider = fakeProvider([PROBE_OK, { kind: "status", status: 402 }, { kind: "status", status: 402 }, PROBE_OK]);
    const c = await devChat("catch-up-key-out-of-credit", { model: null, provider, at: "2099-11-04T22:59" });
    expect((await submit(await keyLink(c))).status).toBe(200);
    await c.settle();
    await c.received();
    c.clock.set((local("2099-11-04T23:00") - 500) as EpochMs);
    await c.say("Help me plan dinner.");
    const [refused] = await c.received();
    expect(refused).toContain("try the key again after 2099-11-05 00:00");
    expect(refused).not.toContain("answer requests");
    c.clock.set((local("2099-11-05T00:00") - 1000) as EpochMs);
    await c.say("Can we use pumpkin?");
    expect(await c.received()).toEqual([refused]);
    expect(provider.seen).toHaveLength(2);
    c.clock.set(local("2099-11-05T00:00"));
    await c.say("How should I cook the pumpkin?");
    expect((await c.received())[0]).toContain("try the key again after 2099-11-05 02:00");
    c.clock.set(local("2099-11-05T01:59"));
    await c.say("Could we roast it?");
    expect((await c.received())[0]).toContain("2099-11-05 02:00");
    expect(provider.seen).toHaveLength(3);
    expect((await submit(await keyLink(c))).status).toBe(200);
    await c.settle();
    expect(await c.received()).toEqual([NOTICE.keyConnected("OpenCode Go", "claude-haiku-5-5")]);
    expect(provider.seen).toHaveLength(4);
  });

  test("the Thai credit notice shows the date and time the key can be tried again", async () => {
    const provider = fakeProvider([PROBE_OK, { kind: "status", status: 402 }]);
    const c = await devChat("U00000000000000000000000000000a04", {
      model: null, provider, at: "2099-11-04T23:00", channel: "line",
    });
    expect((await submit(await keyLink(c))).status).toBe(200);
    await c.settle();
    await c.received();
    await c.say("ช่วยคิดเมนูมื้อเย็นหน่อยค่ะ");
    expect((await c.received())[0]).toContain("ลองใช้ key นี้อีกครั้งได้หลัง 2099-11-05 00:00");
  });

  test.each(["pending", "processing"] as const)("catch-up expiry applies to %s batches after backoff", async (status) => {
    const provider = fakeProvider([PROBE_OK, { kind: "network" }, reply("This reply would be too late.")]);
    const c = await devChat(`catch-up-expired-${status}`, { model: null, provider, at: "2099-11-04T10:00" });
    await c.say("Look up my October receipt.", { id: "old-request", at: local("2099-11-03T10:01") });
    await c.received();
    expect((await submit(await keyLink(c))).status).toBe(200);
    await c.settle();
    expect(await c.received()).toEqual([NOTICE.keyConnected("OpenCode Go", "claude-haiku-5-5")]);
    expect(provider.seen).toHaveLength(2);
    if (status === "processing") {
      await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_agent, state) => {
        state.storage.sql.exec("UPDATE inbox SET status = 'processing', attempts = 3 WHERE event_key = ?", eventKey.dev("old-request"));
      });
    }

    c.clock.set(local("2099-11-04T10:02"));
    await c.settle();

    expect(await c.received()).toEqual([]);
    expect(provider.seen).toHaveLength(2);
  });

  test("roll-forward skips a claimed request that the old Worker marked answered", async () => {
    const provider = fakeProvider([PROBE_OK, { kind: "network" }, reply("Duplicate answer.")]);
    const c = await devChat("catch-up-roll-forward", { model: null, provider, at: "2099-11-04T10:00" });
    await c.say("Plan dinner for me.", { id: "old-worker-answer" });
    await c.received();
    expect((await submit(await keyLink(c))).status).toBe(200);
    await c.settle();
    expect(await c.received()).toEqual([NOTICE.keyConnected("OpenCode Go", "claude-haiku-5-5")]);
    expect(provider.seen).toHaveLength(2);
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_agent, state) => {
      state.storage.sql.exec("UPDATE inbox SET status = 'done', outcome = 'acted' WHERE event_key = ?", eventKey.dev("old-worker-answer"));
    });

    await c.settle();

    expect(await c.received()).toEqual([]);
    expect(provider.seen).toHaveLength(2);
  });

  test("connecting answers the earlier request once without replaying commands or follow", async () => {
    const provider = fakeProvider([PROBE_OK, reply("The market opens at 8."), PROBE_OK]);
    const c = await devChat("catch-up-key", { model: null, provider, at: "2099-11-04T10:00" });
    await c.say("/follow");
    await c.say("When does the market open?");
    expect(await c.received()).toEqual([NOTICE.noAccess({ box: false, key: true, included: false })]);

    const ticket = await keyLink(c);
    expect((await submit(ticket)).status).toBe(200);
    await c.settle();

    expect(await c.received()).toEqual([
      NOTICE.keyConnected("OpenCode Go", "claude-haiku-5-5"),
      "Here's my answer to what you sent earlier.\nThe market opens at 8.",
    ]);
    expect(provider.seen).toHaveLength(2);
    expect(JSON.stringify(provider.seen[1].body)).toContain("When does the market open?");

    expect((await submit(await keyLink(c))).status).toBe(200);
    await c.settle();
    expect(await c.received()).toEqual([NOTICE.keyConnected("OpenCode Go", "claude-haiku-5-5")]);
    expect(provider.seen).toHaveLength(3);
  });

  test("a catch-up turn log uses the request, start time and outcome as its identity", async () => {
    const provider = fakeProvider([PROBE_OK, reply("Here is the route.")]);
    const c = await devChat("catch-up-log", { model: null, provider, at: "2099-11-04T10:00" });
    await c.say("How do I get there?", { id: "route-request" });
    await c.received();
    const ticket = await keyLink(c);
    expect((await submit(ticket)).status).toBe(200);
    await c.settle();

    expect(c.logs("turn").filter((row) => row.outcome === "acted").map((row) => row.id)).toEqual([
      `${c.agent}|${eventKey.dev("route-request")}|catch-up:${c.clock.now()}:acted`,
    ]);
  });

  test("a repeat queued after connecting joins catch-up, and a message during the model call gets its own reply", async () => {
    const provider = fakeProvider();
    const c = await devChat("catch-up-batch", { model: null, provider, at: "2099-11-04T10:00" });
    const ticket = await keyLink(c);
    const noticeStarted = Promise.withResolvers<void>();
    const repeatQueued = Promise.withResolvers<void>();
    const deliver = c.channel.deliver;
    c.channel.deliver = async (message, now) => {
      if (message.texts[0].startsWith("I need an AI")) {
        noticeStarted.resolve();
        await repeatQueued.promise;
      }
      return deliver(message, now);
    };
    const request = "What is the exchange rate?";
    provider.steps.push(
      PROBE_OK,
      { kind: "call", run: async () => {
        expect((await c.post("How much is a train ticket?")).status).toBe(200);
        return reply("I can't check live exchange rates.");
      } },
      reply("It depends on the route."),
    );

    await c.post(request);
    await noticeStarted.promise;
    try {
      expect((await submit(ticket)).status).toBe(200);
      c.clock.set(local("2099-11-04T10:01"));
      expect((await c.post(request)).status).toBe(200);
    } finally {
      repeatQueued.resolve();
    }
    await c.settle();

    expect(await c.received()).toEqual([
      NOTICE.noAccess({ box: false, key: true, included: false }),
      NOTICE.keyConnected("OpenCode Go", "claude-haiku-5-5"),
      `${NOTICE.catchUp}\nI can't check live exchange rates.`,
      "It depends on the route.",
    ]);
    expect(provider.seen).toHaveLength(3);
    const batch = JSON.stringify(provider.seen[1].body);
    expect(batch).toContain(`[Sent 2099-11-04 10:00] Person: ${request}`);
    expect(batch).toContain(`[Sent 2099-11-04 10:01] Person: ${request}`);
    expect(batch).not.toContain("How much is a train ticket?");
    expect(c.logs("turn").filter((row) => row.outcome === "acted").map((row) => row.batchSize)).toEqual([2, 1]);
  });

  test("catch-up drops an expired request and uses send time for relative reminders", async () => {
    const provider = fakeProvider([PROBE_OK, {
      kind: "output",
      value: {
        actions: [
          schedule("call-mum", "2099-11-04T11:00", "Call Mum"),
          schedule("check-oven", "2099-11-04T13:00", "Check the oven"),
          send("I'll remind you to check the oven at 1 pm."),
        ],
        tasks: [],
        about: "",
      },
    }]);
    const c = await devChat("catch-up-reminders", { model: null, provider, at: "2099-11-04T10:00" });
    await c.say("Find my October receipt.", { at: local("2099-11-03T11:00") });
    await c.say("Remind me in an hour to call Mum.");
    await c.say("Remind me in three hours to check the oven.");
    await c.received();
    c.clock.set(local("2099-11-04T12:00"));
    expect((await submit(await keyLink(c))).status).toBe(200);
    await c.settle();

    expect(await c.received()).toEqual([
      NOTICE.keyConnected("OpenCode Go", "claude-haiku-5-5"),
      `${NOTICE.catchUp}\nI'll remind you to check the oven at 1 pm.\n${NOTICE.reminderPast}`,
    ]);
    expect(provider.seen).toHaveLength(2);
    const prompt = JSON.stringify(provider.seen[1].body);
    expect(prompt).not.toContain("Find my October receipt.");
    expect(prompt).toContain("[Sent 2099-11-04 10:00] Person: Remind me in an hour to call Mum.");
    expect(prompt).toContain("Resolve relative reminder times from when the request was first sent");
    expect((await c.snapshot()).pendingWakeups.filter((w) => w.kind === "reminder")).toMatchObject([
      { key: "check-oven", dueAt: local("2099-11-04T13:00") },
    ]);
  });

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
    expect(html).toContain("Claude Haiku 5.5");
    expect(html).toContain("Another model");
    expect(html).toContain("id=\"modelPick\"");
    expect(html).toContain('if (!$("modelRow").hidden && typedModel === "")');
    expect(html).toContain(NOTICES.th.keyPage.connect);
  });

  test("the page lists the provider's priced model and offers another", async () => {
    const html = await (await SELF.fetch("https://giraffes.test/key")).text();
    const data = JSON.parse(/<script type="application\/json" id="data">(.*?)<\/script>/.exec(html)?.[1] ?? "") as {
      providers: { id: string; models: { id: string; pick: string | null }[] }[];
    };

    expect(data.providers.find((p) => p.id === "opencode-go")?.models.map((m) => [m.id, m.pick])).toEqual([
      ["claude-haiku-5-5", null],
    ]);
    expect(data.providers.find((p) => p.id === "mistral")?.models.map((m) => m.id)).toEqual(["mistral-small-2603"]);
    expect(html).toContain("Another model");
  });

  test("the key page says checking can use more than one small request in both languages", async () => {
    const html = await (await SELF.fetch("https://giraffes.test/key")).text();
    expect(html).toContain("Checking your key. This may use a few small requests on your provider account…");
    expect(html).toContain("กำลังตรวจ key ค่ะ อาจส่งคำขอสั้น ๆ สองสามครั้งผ่านบัญชีของคุณกับผู้ให้บริการ…");
  });

  test.each([true, false])("rejects an oversized form early, declared length %s", async (declared) => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("é".repeat(++reads === 1 ? 2048 : 1)));
        if (reads === 3) controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const request = new Request("https://giraffes.test/key", {
      method: "POST", body, headers: declared ? { "content-length": "4100" } : {},
    });
    const res = await worker.fetch(request, env);
    expect(res.status).toBe(413);
    expect(reads).toBe(declared ? 0 : 2);
    expect(cancelled).toBe(!declared);
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
    expect(got.join("\n")).not.toContain("answer requests from the last 24 hours");
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
  // This drive walks the box setup, backup-question, and two-day reclaim alarm chain.
  }, 10_000);

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

  test("four short ordinary words reach the model as written, with no key warning", async () => {
    const model = scripted([chat("Sure.")]);
    const c = await devChat("max", { model, at: "2099-11-04T10:00" });

    await c.say("book cafe near work");

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].user).toContain("book cafe near work");
    expect((await c.received()).join("\n")).not.toContain(NOTICE.pastedKey(null).split("\n")[0]);
  });

  const pemLines = [
    "-----BEGIN " + "OPENSSH PRIVATE KEY-----",
    "bm90L2EtcHJpdmF0ZS9rZXk=",
    "c2Vjb25kLWxpbmU=",
    "-----END " + "OPENSSH PRIVATE KEY-----",
  ];
  const jwtParts = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmaWN0aW9uIn0", "TDgYUkFHcXVGRkFuaUNi"];
  const jweParts = ["eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0", "", "bm9uY2VyYW5kb20", "ZmljdGlvbmFsZW5jcnlwdGVkdGV4dA", "c2lnbmF0dXJl"];
  const slackToken = "xox" + "b-904709774064-1412892120756-mtbruma0ofnrlgmn05xql7ef";
  const awsKeyId = "AK" + "IA" + "A1B2C3D4E5F6G7H8";
  const providerKey = "gh" + "p_" + "a".repeat(36);
  const awsSecretParts = ["Qz7xP2mK9vL4", "/nB8wR3tY6uI1", "+oE5aS0dF7gH2jK"];
  const webhookPath = ["T0FAKE0001", "B0FAKE0002", "Zq8rT4vW1xY6aB3cD9eF2gH"];
  const appGroups = ["wqzk", "rbtm", "hlvn", "pxjd"];

  test.each([
    ["pem", "here is the server key\n", pemLines.join("\n"), "\nplease check", pemLines],
    ["jwt", "my token ", jwtParts.join("."), " please check", jwtParts],
    ["encrypted-jwt", "my token ", jweParts.join("."), " please check", jweParts.filter(Boolean)],
    ["database-url", "connect with postgres://admin:", "pa%40ss:123", "@db.example.test:5432/app", ["pa%40ss", "ss:123"]],
    ["database-url-at-sign", "connect with postgres://admin:", "pa@ss:123", "@db.example.test:5432/app", ["pa@ss", "ss:123"]],
    ["slack", "slack bot ", slackToken, " please check", slackToken.split("-")],
    ["aws-key-id", "AWS access key ", awsKeyId, " please check", [awsKeyId.slice(0, 9), awsKeyId.slice(9)]],
    ["aws-secret", "aws secret: ", "G8XG6yL4DvV5/3lpvdiQ0pJ+slMP66pRh0vtSh2wr", "", ["G8XG6yL4DvV5", "3lpvdiQ0pJ", "slMP66pRh0vtSh2wr"]],
    ["provider-key", "GitHub key ", providerKey, " please check", [providerKey.slice(0, 16), providerKey.slice(16)]],
    ["short-password", "my password is ", "hunter2", "", ["hunter2"]],
    ["colon-password", "password: ", "hunter2", " for the wifi", ["hunter2"]],
    ["symbol-password", "password: ", "Tr0ub4dor&3!x", "", ["Tr0ub4dor", "&3!x"]],
    ["at-password", "password: ", "P@ssw0rd-54mpvX", "", ["P@", "ssw0rd-54mpvX"]],
    ["thai-password", "รหัสผ่านคือ ", "Xk92mmQp", "", ["Xk92mmQp"]],
    ["numeric-password", "the wifi password is ", "84302917", "", ["84302917"]],
    ["long-symbol-password", "password: ", "LongAlpha1234&" + "q".repeat(70), " for the wifi", ["LongAlpha1234", "q".repeat(20)]],
    ["env-name", "DB_PASSWORD=", "hunter2", "", ["hunter2"]],
    ["json-password", '{"password":"', "hunter2", '"}', ["hunter2"]],
    ["pass-colon", "gmail pass: ", "Ab12Cd34Ef", "", ["Ab12Cd34Ef"]],
    ["app-password-copy-left", "App password: type ", "copy-qvzf-wpxn-next", " thnx", ["copy", "qvzf", "wpxn", "next"]],
    ["app-password-tail", "App password: plse ", "qvzf-wpxn-kjmg-next", "", ["qvzf", "wpxn", "kjmg", "next"]],
    ["app-password-copy-colon", "App password: copy: (", "qvzfwpxnkjmgrbhy", ")", ["qvzfwpxnkjmgrbhy"]],
    ["reverse-access-token", "(", "qvzfwpxnkjmgrbhy", ") is my access token", ["qvzfwpxnkjmgrbhy"]],
    ["quoted-app-password", 'App password: "', appGroups.join(" "), '"', appGroups],
    ["curly-quoted-app-password", "app password: paste: “", appGroups.join(" "), "”", appGroups],
    ["bracketed-app-password", "App password: (", appGroups.join(" "), ")", appGroups],
    ["single-quoted-app-password", "password: '", appGroups.join(" "), "'", appGroups],
    ["said-quoted-app-password", 'app password is "', appGroups.join(" "), '"', appGroups],
    ["quoted-passphrase", 'password: "', "quokka zephyr47 plinth", '"', ["quokka", "zephyr", "plinth"]],
    ["is-and-colon", "my password is: ", "BlueSky#2026", " ok", ["BlueSky", "Sky#2026"]],
    ["thai-password-for-service", "รหัสผ่าน wifi คือ ", "Rt56Yu78", "", ["Rt56Yu78"]],
    ["thai-wifi-code", "รหัส wifi คือ ", "55667788", "", ["55667788"]],
    ["database-url-no-user", "use redis://:", "onlypass123", "@cache.example.test:6379", ["onlypass123"]],
    ["short-token", "token: ", "7f3a9c2e1b", "", ["7f3a9c2e1b"]],
    ["client-secret", "client secret: ", "Gq8sLp2Wm4", "", ["Gq8sLp2Wm4"]],
    ["secret-key", "secret key: ", awsSecretParts.join(""), "", awsSecretParts.map((p) => p.slice(1))],
    ["slack-webhook", "post to https://hooks.slack" + ".com/services/", webhookPath.join("/"), "", webhookPath],
    ["bank-pin", "my bank PIN is ", "4821", "", ["4821"]],
  ] as const)("removes every part of the pasted credential from storage and the next prompt: %s", async (_id, before, value, after, fragments) => {
    const model = scripted([chat("I can help."), chat("I can help.")]);
    const c = await devChat("pasted-credential", { model, at: "2099-11-04T10:00" });
    const redacted = before + KEY_REMOVED + after;

    await c.say(before + value + after);
    const initialCalls = model.calls.length;
    await c.say("ok what now");

    const stored = await doDump(c.agent);
    const prompts = model.calls.map((call) => call.user).join("\n");
    for (const fragment of fragments) {
      expect(stored.includes(fragment), `stored credential fragment: ${fragment}`).toBe(false);
      expect(prompts.includes(fragment), `forwarded credential fragment: ${fragment}`).toBe(false);
    }
    expect(initialCalls).toBe(0);
    expect(model.calls).toHaveLength(1);
    expect((await c.snapshot()).turns.map((t) => t.text)).toContain(redacted);
    expect(prompts).toContain(redacted);
  });

  test.each([
    ["memo", "edit memo weds noon"],
    ["model-name", "Can I use my API key with Qwen3-Coder-480B-A35B-Instruct?"],
    ["password-reset", "I forgot my password, how do I reset it?"],
    ["thai-password-reset", "ฉันลืมรหัสผ่าน ต้องรีเซ็ตยังไง"],
    ["password-tip", "password: use something long like correct horse battery staple"],
    ["password-length", "a good password is 12 characters or more"],
    ["password-description", "the password is case-sensitive"],
    ["password-link", "the password reset link is https://accounts.example.test/reset?id=abc123"],
    ["password-wrong", "my password is wrong, can you remind me to reset it?"],
    ["thai-password-description", "รหัสผ่านคือวันเกิดของฉัน ช่วยเตือนให้เปลี่ยนด้วย"],
    ["code-that-reads-a-token", "token = response.headers['x-token']"],
    ["token-description", "the token is single-use"],
    ["password-advice", "password: at least 8 chars, one number"],
    ["boarding-pass", "boarding pass: gate D7, seat 32A"],
    ["boarding-pass-code", "boarding pass: X7KQ2P, seat 32A"],
    ["day-pass-price", "day pass = 300 baht"],
    ["day-pass-said", "the day pass is 300"],
    ["day-pass-hours", "day pass: 10am-5pm"],
    ["pass-declined", "pass: no thanks, maybe next week"],
    ["password-same", "password: same as last time?"],
    ["password-still", "Password: still not working after reset"],
    ["password-forgot", "password: I forgot it, can you help?"],
    ["password-question-mark", "wifi password: ?"],
    ["password-wrong-exclaim", "my password is wrong!"],
    ["password-see-above", "password: (see above)"],
    ["password-quoted-phrase-said", 'my password is "too short" apparently'],
    ["pin-price", "pin: 1500 baht"],
    ["token-none", "token: none yet"],
    ["thai-promo-code", "รหัส promo คือ SAVE50"],
    ["password-not-applicable", "password: N/A"],
    ["password-emoji", "wifi password: 👍"],
    ["password-price", "password: $200 for premium"],
    ["password-percent", "my password is 100% correct"],
    ["password-company-name", "password: AT&T account"],
    ["password-bracketed-word", "password: (same)"],
    ["password-quoted-none", 'password: "none"'],
    ["password-quoted-same-said", 'my password is "same"'],
    ["password-quoted-later", "Password: 'ask me later'"],
    ["password-quoted-forgot", `password: "I don't remember"`],
    ["thai-password-quoted-same", 'รหัสผ่าน: "เหมือนเดิม"'],
    ["wifi-password-quoted-fridge", `wifi password: "it's on the fridge"`],
    ["app-password-quoted-question", 'App password: "what is this"'],
    ["password-quoted-before", 'Password: "same as before"'],
    ["wifi-password-quoted-time", 'Wi-Fi password: "ask me after 7 tonight"'],
    ["wifi-password-quoted-price", 'Wi-Fi password: "ask the host for $5"'],
    ["password-quoted-at-name", "Password: ‘Please ask @ Maya.’"],
    ["app-password-quoted-four-words", 'App password: "just call back soon"'],
    ["season-pass-name", "season pass: summer2026"],
    ["postal-pin-code", "pin code: 400001"],
  ] as const)("ordinary chat reaches the model as written: %s", async (id, text) => {
    const model = scripted([chat("Sure.")]);
    const c = await devChat(`ordinary-${id}`, { model, at: "2099-11-04T10:00" });

    await c.say(text);

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].user).toContain(text);
    expect((await c.received()).join("\n")).not.toContain(NOTICE.pastedKey(null).split("\n")[0]);
  });

  test.each([
    ["sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", true],
    ["abcd-efgh-ijkl-mnop", true],
    ["abcd efgh ijkl mnop", true],
    ["My app password is abcd efgh ijkl mnop keep it private.", true],
    ["They both read each page.", false],
    ["password: x8Kp2Qz9Lm4Rt7Bv3N", true],
    ["x8Kp2Qz9Lm4Rt7Bv3N is my app password", true],
    ["x8Kp2Qz9Lm4Rt7Bv3N", true],
    ["this will take some time", false],
    ["this-will-take-time", false],
    ["please make sure your door is closed", false],
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
    ["book cafe near work", false],
    ["pick milk eggs soap", false],
    ["shopping list:\nmilk eggs rice soap\nbread", false],
    ["I forgot my password, book cafe near work", false],
    ["my password is unpredictable", false],
    ["password confirmation", false],
    ["authentication token", false],
    ["Mistral-Small-2603 is cheapest", false],
    ["I switched to Mistral-Small-2603 today", false],
    ["Mistral-Small-2603 token price", false],
    ["does my api key work with Mistral-Small-2603", false],
    ["my api key is for deepseek-v4-1-flash-1017", false],
    ["รหัสพัสดุ TH0123456789AB", false],
    ["password: Xk29fLq8Wm2p", true],
    ["password is Xk29fLq8Wm2p", true],
    ["รหัสผ่าน icloud: Xk29fLq8Wm2p", true],
    ["รหัสผ่านคือ Xk29fLq8Wm2p", true],
    ["พาสเวิร์ด Xk29fLq8Wm2p", true],
    ["รหัส: Xk29fLq8Wm2p", true],
    ["รหัสผ่านแอป gmail คือ qwer tyui opas dfgh ช่วยตั้งค่าให้หน่อย", true],
    ["my gmail app pw is qwer tyui opas dfgh thanks", true],
    ["password: Mistral-Small-2603", true],
    ["password: unpredictable", true],
    ["my app password is book qwer tyui work", true],
    ["x8Kp2Qz9Lm4Rt7B is my app password", true],
    ["password for gmail is x8Kp2Qz9Lm4Rt7B", true],
    ["password:\nx8Kp2Qz9Lm4Rt7B", true],
    ["password for icloud is Xk29fLq8Wm2p", true],
    ["รหัสผ่าน icloud คือ Xk29fLq8Wm2p", true],
    ["dakfUp-nixjy2-qibgyv", true],
    ["my password is dakfUp-nixjy2-qibgyv", true],
    ["Llama-4-Maverick-17B is cheaper", false],
    ["GPT-4o-mini-2024-07-18 is cheaper", false],
    ["edit memo weds noon", false],
    ["Can I use my API key with Qwen3-Coder-480B-A35B-Instruct?", false],
    ["password: Qwen3-Coder-480B-A35B-Instruct", true],
    ["password is this will take time", true],
  ])("%s is %s", (text, found) => {
    expect(redactSecrets(text).found).toBe(found);
  });

  test("the context allowance is measured after the end of the hint", () => {
    const token = "Xk29fLq8Wm2p";
    expect(redactSecrets(`password:${" ".repeat(31)}${token}`).found).toBe(true);
    expect(redactSecrets(`password:${" ".repeat(32)}${token}`).found).toBe(false);
  });

  const bareKey = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE";

  test.each([".", ":", "=", "/", "@"])("redacts a bare key followed by %s", (punctuation) => {
    expect(redactSecrets(`${bareKey}${punctuation}`)).toEqual({ text: `${KEY_REMOVED}${punctuation}`, found: true });
  });

  test.each([`${bareKey}.com`, `a.${bareKey}.b`, `https://h/${bareKey}/x`, `${bareKey}/path`])("keeps a host or path intact: %s", (text) => {
    expect(redactSecrets(text)).toEqual({ text, found: false });
  });

  test("an explicit app-password label wins over following prose, while ordinary prose stays intact", () => {
    expect(redactSecrets("My app password is abcd efgh ijkl mnop keep it private.")).toEqual({ text: `My app password is ${KEY_REMOVED} keep it private.`, found: true });
    expect(redactSecrets("They both read each page.")).toEqual({ text: "They both read each page.", found: false });
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

  test("a pasted Vibe plan key with no model gets the same Mistral model on the same URL", () => {
    expect(draftKey({ provider: "mistral-vibe", model: "", baseUrl: "", key: "AbCdEfGhIjKlMnOpQrStUvWxYz012345" }, { devMode: false })).toMatchObject({
      ok: true,
      value: { provider: "mistral-vibe", baseUrl: "https://api.mistral.ai/v1", model: "mistral-small-2603" },
    });
  });

  test("an explicitly typed unlisted model is kept for the provider to judge", () => {
    expect(draftKey({ provider: "mistral", model: "mistral-medium-2608", baseUrl: "", key: "AbCdEfGhIjKlMnOpQrStUvWxYz012345" }, { devMode: false })).toMatchObject({
      ok: true,
      value: { provider: "mistral", model: "mistral-medium-2608" },
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
