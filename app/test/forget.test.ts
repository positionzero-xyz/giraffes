import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { devLane, DEV_URL_SCRIPTED } from "../src/access/access";
import { Agent } from "../src/agent/agent";
import type { ProviderOrder } from "../src/agent/forget";
import { AgentStore } from "../src/agent/store";
import { d1Billing, type BillingStore } from "../src/billing/store";
import type { BoxClient } from "../src/box/client";
import { machineConfig } from "../src/box/fly";
import type { BoxToken } from "../src/box/names";
import type { ChannelAdapter, Delivery } from "../src/channels/channel";
import { lineChannel } from "../src/channels/line";
import type { Env } from "../src/config";
import { eventKey, parseButton, type AgentKey, type ChannelEvent, type EpochMs, type ForgetEpoch, type Identity, type InboundEnvelope, type OutboxId } from "../src/domain";
import { connect } from "../src/model/client";
import { scriptedConnect } from "../src/model/scripted";
import {
  billingOn,
  chat,
  devChat,
  fakeBox,
  fakeProvider,
  giveKey,
  hold,
  memoryLedger,
  propose,
  scripted,
  send,
  TEST_KEYS,
  turn,
  type DevChat,
  type ScriptedChannel,
} from "./testkit";

afterEach(() => {
  vi.restoreAllMocks();
});

const until = async (done: () => boolean) => {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!done()) throw new Error("condition never became true");
};

function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

const stubOf = (agent: AgentKey) => env.AGENT.get(env.AGENT.idFromName(agent));
/** Opens a forget at the clock's time, then moves the clock a second on, so what the person sends next is after the cutoff. */
async function begin(c: DevChat, trigger: ProviderOrder = { at: c.clock.now(), seq: null }) {
  const opened = await runInDurableObject<Agent, { op: string; epoch: ForgetEpoch }>(stubOf(c.agent), (a) => a.beginForget(trigger));
  c.clock.set((c.clock.now() + 1000) as EpochMs);
  return opened;
}
const end = (c: DevChat, op: string) => runInDurableObject<Agent, boolean>(stubOf(c.agent), (a) => a.endForget(op));
const sql = <T>(c: DevChat, query: string, ...params: unknown[]) =>
  runInDurableObject<Agent, T[]>(stubOf(c.agent), (_a, state) => state.storage.sql.exec(query, ...params).toArray() as T[]);
const nextAlarm = (c: DevChat) => runInDurableObject<Agent, number | null>(stubOf(c.agent), (_a, state) => state.storage.getAlarm());

/** A new instance of the person's Durable Object over the same storage, with nothing in memory, as after an eviction. */
async function coldDrain(c: DevChat, channel: ScriptedChannel = c.channel): Promise<void> {
  await runInDurableObject<Agent, void>(stubOf(c.agent), async (_a, state) => {
    const fresh = new Agent(state, env as unknown as Env);
    fresh.withDeps({
      connect: scriptedConnect(c.model, connect(fakeProvider())),
      included: devLane(DEV_URL_SCRIPTED),
      keys: TEST_KEYS,
      clock: c.clock,
      ledger: memoryLedger(),
      channels: { line: channel, telegram: channel, dev: channel },
      admission: "open",
    });
    await fresh.alarm();
  });
}

const FORTY_ONE_NOTES = `INSERT INTO memory_note (text, created_at, event_key)
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 41) SELECT 'note ' || i, 0, 'dev:seed' FROM n`;

const PLAN = "Fri 18:30 overnight train from Bangkok\nSat Doi Suthep at 7 before the heat, Nimman cafes after\nSun 16:00 flight back";

describe("work that began before a forget can't save or send after it", () => {
  test("a reply whose model call was in flight is never saved or sent, after the hold ends and after a restart", async () => {
    const model = scripted([hold(chat("You live at 12 Elm Street.")), chat("Hello again!")]);
    const c = await devChat("fence-turn", { model, at: "2099-11-04T10:00" });

    await c.post("where do I live again?");
    await until(() => model.calls.length === 1);
    const { op } = await begin(c);
    model.release();
    await c.settle();

    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).turns).toEqual([]);

    await end(c, op);
    await coldDrain(c);
    await c.settle();
    expect(model.calls).toHaveLength(1);
    expect(await c.received()).toEqual([]);

    await c.say("hi");
    expect(await c.received()).toEqual(["Hello again!"]);
    expect(model.calls[1].user).not.toContain("where do I live");
  });

  test("a message from after the cutoff, waiting when the forget began, is answered once the hold ends", async () => {
    const model = scripted([hold(chat("You live at 12 Elm Street.")), chat("Tomorrow looks sunny.")]);
    const c = await devChat("fence-after", { model, at: "2099-11-04T10:00" });
    const t = c.clock.now();

    await c.post("where do I live again?", { at: t });
    await until(() => model.calls.length === 1);
    await c.post("what's the weather tomorrow?", { at: (t + 5000) as EpochMs });
    const { op } = await begin(c, { at: (t + 1000) as EpochMs, seq: null });
    model.release();
    await c.settle();
    expect(await c.received()).toEqual([]);

    await end(c, op);
    await c.settle();
    expect(await c.received()).toEqual(["Tomorrow looks sunny."]);
    expect(model.calls[1].user).not.toContain("where do I live");
  });

  test("a compaction in flight when the forget began doesn't save its summary", async () => {
    const model = scripted([chat("Noted.")], { compaction: [hold({ kind: "output", value: { summary: "Lives at 12 Elm Street." } })] });
    const c = await devChat("fence-compaction", { model, at: "2099-11-04T10:00" });
    await c.say("hi");
    await sql(c, FORTY_ONE_NOTES);

    const drain = c.alarm();
    await until(() => model.calls.some((call) => call.purpose === "compaction"));
    await begin(c);
    model.release();
    await drain;

    expect(await sql(c, "SELECT summary FROM memory")).toEqual([{ summary: "" }]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM memory_note")).toEqual([{ n: 41 }]);
  });
});

describe("no request that carries the person's words starts after a forget begins", () => {
  test("a forget that begins while the plan is being read stops the model call before it starts", async () => {
    const base = d1Billing(env.LEDGER);
    const held = gate();
    let entered = false;
    const store: BillingStore = {
      ...base,
      async standing(agent, now) {
        entered = true;
        await held.wait;
        return base.standing(agent, now);
      },
    };
    const kit = billingOn({}, store);
    const model = scripted([chat("You live at 12 Elm Street.")]);
    const c = await devChat("fence-plan", { model, at: "2099-11-04T10:00", billing: kit.deps });

    await c.post("where do I live again?");
    await until(() => entered);
    await begin(c);
    held.open();
    await c.settle();

    expect(model.calls).toHaveLength(0);
    expect(await c.received()).toEqual([]);
  });

  test("a forget that begins while the box token is being signed stops the box request before it starts", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("fence-hmac", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    const held = gate();
    let armed = true;
    let entered = false;
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args: Parameters<SubtleCrypto["sign"]>) => {
      if (armed) {
        armed = false;
        entered = true;
        await held.wait;
      }
      return sign(...args);
    });
    await c.post("where do I live again?");
    await until(() => entered);
    await begin(c);
    held.open();
    await c.settle();

    expect(box.parses).toEqual([]);
    expect(await c.received()).toEqual([]);
  });

  test("a forget that begins while the person's key is being opened stops the provider request before it starts", async () => {
    const provider = fakeProvider([{ kind: "output", value: { actions: [send("You live at 12 Elm Street.")], tasks: [], about: "" } }]);
    const c = await devChat("fence-key", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent);

    const held = gate();
    let armed = true;
    let entered = false;
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args: Parameters<SubtleCrypto["decrypt"]>) => {
      if (armed) {
        armed = false;
        entered = true;
        await held.wait;
      }
      return decrypt(...args);
    });
    await c.post("where do I live again?");
    await until(() => entered);
    await begin(c);
    held.open();
    await c.settle();

    expect(provider.seen).toEqual([]);
    expect(await c.received()).toEqual([]);
  });

  test("when the box lane gives up after the forget began, the backup key lane is not tried", async () => {
    const box = fakeBox({ signedIn: true });
    const held = gate();
    let entered = false;
    const client: BoxClient = {
      ...box.deps.client,
      async agent() {
        entered = true;
        await held.wait;
        return { kind: "unavailable", detail: "held" };
      },
    };
    const provider = fakeProvider([{ kind: "output", value: { actions: [send("From your key.")], tasks: [], about: "" } }]);
    const c = await devChat("fence-fallback", { model: scripted([]), provider, at: "2099-11-04T10:00", box: { ...box.deps, client } });
    await c.say("/claude");
    await giveKey(c.agent, { backup: true });
    await c.received();

    await c.post("where do I live again?");
    await until(() => entered);
    await begin(c);
    held.open();
    await c.settle();

    expect(provider.seen).toEqual([]);
    expect(await c.received()).toEqual([]);
  });

  test("a repair the forget overtook is never sent", async () => {
    const held = gate();
    const provider = fakeProvider([
      { kind: "call", run: () => held.wait.then(() => ({ kind: "text", text: "not json" }) as const) },
      { kind: "output", value: { actions: [send("You live at 12 Elm Street.")], tasks: [], about: "" } },
    ]);
    const c = await devChat("fence-repair", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent, { mode: "loose" });

    await c.post("where do I live again?");
    await until(() => provider.seen.length === 1);
    await begin(c);
    held.open();
    await c.settle();

    expect(provider.seen).toHaveLength(1);
    expect(await c.received()).toEqual([]);
  });

  test("a LINE reply the token refused falls back to a push only while no forget began", async () => {
    let live = true;
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seen.push(String(input));
      live = false;
      return new Response("invalid reply token", { status: 400 });
    });
    const line = lineChannel({ channelSecret: "s", accessToken: "t" });
    const to: Identity = { channel: "line", channelUserId: "U4af4980629a1b2c3d4e5f60718293a4b" };
    const now = 4097563200000 as EpochMs;
    const sent = await line.deliver({ id: "o1" as OutboxId, to, texts: ["You live at 12 Elm Street."], intent: "reply", reply: { token: "r", expiresAt: (now + 60_000) as EpochMs } }, now, () => live);

    expect(seen).toEqual(["https://api.line.me/v2/bot/message/reply"]);
    expect(sent).toEqual({ kind: "fenced" });
  });

  test("the person's messages wait in their Durable Object, and nobody else's group is served from it, while a forget is open", async () => {
    const model = scripted([chat("Hi.")]);
    const c = await devChat("fence-serve", { model, at: "2099-11-04T10:00" });
    await c.say("hello");
    const group = "g:telegram:-100" as AgentKey;
    await runInDurableObject<Agent, void>(stubOf(c.agent), (a) => a.recordGroup(group, 1));
    await begin(c);

    const served = await runInDurableObject<Agent, unknown>(stubOf(c.agent), (a) =>
      a.serve({ group, ownershipVersion: 1, purpose: "turn", system: "s", prompt: { sections: [] } as never }),
    );
    expect(served).toMatchObject({ kind: "no_access" });
    expect(model.calls).toHaveLength(1);
  });
});

describe("branches that tell the person something", () => {
  test("a key refused after the forget began rests the key but queues no notice", async () => {
    const held = gate();
    const provider = fakeProvider([{ kind: "call", run: () => held.wait.then(() => ({ kind: "status", status: 401 }) as const) }]);
    const c = await devChat("fence-refused", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent);

    await c.post("where do I live again?");
    await until(() => provider.seen.length === 1);
    const { op } = await begin(c);
    held.open();
    await c.settle();
    await end(c, op);
    await c.settle();

    const s = await c.snapshot();
    expect(s.turns).toEqual([]);
    expect(s.outbox).toEqual([]);
    expect(s.access.key?.health).toBe("resting:credential");
  });

  test("a box that answers signed out after the forget began moves to signed out but queues no notice", async () => {
    const box = fakeBox({ signedIn: true });
    const held = gate();
    let entered = false;
    const client: BoxClient = {
      ...box.deps.client,
      async agent() {
        entered = true;
        await held.wait;
        return { kind: "signed_out" };
      },
    };
    const c = await devChat("fence-signed-out", { model: scripted([]), at: "2099-11-04T10:00", box: { ...box.deps, client } });
    await c.say("/claude");
    await c.received();
    const before = (await c.snapshot()).turns.length;

    await c.post("where do I live again?");
    await until(() => entered);
    const { op } = await begin(c);
    held.open();
    await c.settle();
    await end(c, op);
    await c.settle();

    const s = await c.snapshot();
    expect(s.box?.state).toBe("signed_out");
    expect(s.turns).toHaveLength(before);
    expect(await c.received()).toEqual([]);
  });

  test("a request waiting for a connection when the forget began isn't answered once the person connects", async () => {
    const provider = fakeProvider([{ kind: "output", value: { actions: [send("You live at 12 Elm Street.")], tasks: [], about: "" } }]);
    const c = await devChat("fence-catch-up", { model: null, provider, at: "2099-11-04T10:00" });
    await c.say("where do I live again?");
    await c.received();

    const { op } = await begin(c);
    await end(c, op);
    await giveKey(c.agent);
    await c.settle();

    expect(provider.seen).toEqual([]);
    expect(await c.received()).toEqual([]);
  });

  test("a notice queued during the hold waits for its end, without a busy alarm", async () => {
    const c = await devChat("fence-notice", { model: scripted([chat("Hi.")]), at: "2099-11-04T10:00" });
    await c.say("hello");
    await c.received();
    const { op } = await begin(c);
    await runInDurableObject<Agent, void>(stubOf(c.agent), (_a, state) =>
      new AgentStore(state.storage).notifyOnce("plan", eventKey.billing("plan"), { texts: ["Your plan changed."], note: "Your plan changed." }, c.clock.now()),
    );
    await c.settle();
    const alarm = await nextAlarm(c);
    expect(alarm === null || alarm > c.clock.now()).toBe(true);
    expect(await c.received()).toEqual([]);

    await end(c, op);
    await c.settle();
    expect(await c.received()).toEqual(["Your plan changed."]);
  });
});

describe("delivery after a forget", () => {
  test("a reply still waiting to be sent when the forget began never goes out", async () => {
    const model = scripted([chat("You live at 12 Elm Street.")]);
    const c = await devChat("fence-pending", { model, at: "2099-11-04T10:00", deliveries: [{ kind: "retry", afterMs: 60_000 }] });
    await c.say("where do I live again?");
    expect(await c.received()).toEqual([]);

    const { op } = await begin(c);
    await end(c, op);
    c.clock.set((c.clock.now() + 5 * 60_000) as EpochMs);
    await c.settle();

    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).outbox.map((o) => o.status)).toEqual(["dropped"]);
  });

  async function heldChannel(c: DevChat, answer: Delivery) {
    const held = gate();
    let entered = false;
    const channel: ChannelAdapter = {
      receive: () => Promise.reject(new Error("unused")),
      async deliver() {
        entered = true;
        await held.wait;
        return answer;
      },
    };
    await runInDurableObject<Agent, void>(stubOf(c.agent), (a) => a.withDeps({ channels: { line: channel, telegram: channel, dev: channel } }));
    return { held, entered: () => entered };
  }

  test("a send that was in flight when the forget began can't put its row back in the queue", async () => {
    const model = scripted([chat("You live at 12 Elm Street.")]);
    const c = await devChat("fence-retry", { model, at: "2099-11-04T10:00" });
    const ch = await heldChannel(c, { kind: "retry", afterMs: 60_000, detail: "held" });

    await c.post("where do I live again?");
    await until(ch.entered);
    const { op } = await begin(c);
    ch.held.open();
    await c.settle();
    await end(c, op);
    await runInDurableObject<Agent, void>(stubOf(c.agent), (a) => a.withDeps({ channels: { line: c.channel, telegram: c.channel, dev: c.channel } }));
    c.clock.set((c.clock.now() + 5 * 60_000) as EpochMs);
    await c.settle();

    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).outbox.map((o) => o.status)).toEqual(["dropped"]);
  });

  test("a send in flight when the forget began can't mark the person blocked", async () => {
    const model = scripted([chat("You live at 12 Elm Street.")]);
    const c = await devChat("fence-gone", { model, at: "2099-11-04T10:00" });
    const ch = await heldChannel(c, { kind: "recipient_gone" });

    await c.post("where do I live again?");
    await until(ch.entered);
    await begin(c);
    ch.held.open();
    await c.settle();

    expect((await c.snapshot()).agent?.status).toBe("active");
  });
});

describe("the provider cutoff", () => {
  const lineEnvelope = (c: DevChat, id: string, at: number): InboundEnvelope => ({
    agent: c.agent,
    identity: { channel: "line", channelUserId: c.agent.split(":")[2] },
    key: eventKey.line(id),
    receivedAt: at as EpochMs,
    event: { kind: "message", text: "my address is 12 Elm Street" },
  });
  const telegramEnvelope = (c: DevChat, updateId: number, at: number, event: ChannelEvent = { kind: "message", text: "my address is 12 Elm Street" }): InboundEnvelope => ({
    agent: c.agent,
    identity: { channel: "telegram", channelUserId: c.agent.split(":")[2] },
    key: eventKey.telegram(updateId),
    receivedAt: at as EpochMs,
    event,
  });
  const enqueue = (e: InboundEnvelope) => stubOf(e.agent).enqueue(e);
  const stored = async (c: DevChat, key: string) => (await sql<{ n: number }>(c, "SELECT COUNT(*) AS n FROM inbox WHERE event_key = ?", key))[0].n;

  test("a LINE event from before the cutoff is refused before it is stored, on its first delivery, at the same time, and after its row was pruned", async () => {
    const c = await devChat("Ucutoffline", { model: scripted([chat("Got it."), chat("Hello again!")]), channel: "line", at: "2099-11-04T10:00" });
    const t0 = c.clock.now();
    expect(await enqueue(lineEnvelope(c, "seen-before", t0))).toBe("queued");
    await c.settle();
    await c.received();

    c.clock.set((t0 + 60_000) as EpochMs);
    const cutoff = c.clock.now();
    const { op } = await begin(c, { at: cutoff, seq: null });
    await end(c, op);
    await runInDurableObject<Agent, void>(stubOf(c.agent), (_a, state) => new AgentStore(state.storage).prune((cutoff + 15 * 24 * 60 * 60_000) as EpochMs));

    expect(await enqueue(lineEnvelope(c, "late-first", cutoff - 1000))).toBe("stale");
    expect(await enqueue(lineEnvelope(c, "same-ms", cutoff))).toBe("stale");
    expect(await enqueue(lineEnvelope(c, "seen-before", t0))).toBe("stale");
    expect(await stored(c, "line:late-first")).toBe(0);
    expect(await stored(c, "line:same-ms")).toBe(0);
    expect(await stored(c, "line:seen-before")).toBe(0);

    expect(await enqueue(lineEnvelope(c, "after", cutoff + 1))).toBe("queued");
    await c.settle();
    expect(await c.received()).toEqual(["Hello again!"]);
  });

  test("Telegram orders by update_id only within one second, since the ids can restart", async () => {
    const c = await devChat("9100", { model: scripted([]), channel: "telegram", at: "2099-11-04T10:00" });
    const second = Math.floor(c.clock.now() / 1000) * 1000;
    await begin(c, { at: second as EpochMs, seq: 100 });

    expect(await enqueue(telegramEnvelope(c, 99, second))).toBe("stale");
    expect(await enqueue(telegramEnvelope(c, 500, second - 1000))).toBe("stale");
    expect(await enqueue(telegramEnvelope(c, 101, second))).toBe("queued");
    expect(await enqueue(telegramEnvelope(c, 5, second + 1000))).toBe("queued");
  });

  test("a tap counts only on a button sent since the last forget", async () => {
    const model = scripted([turn({ actions: [send("Here's the plan.")], tasks: [propose("trip", "A trip", PLAN)] })]);
    const c = await devChat("9200", { model, channel: "telegram", at: "2099-11-04T10:00" });
    const { op } = await begin(c);
    await end(c, op);
    await c.say("plan my weekend");

    const data = c.channel.delivered.at(-1)?.button?.data ?? "";
    expect(data).toMatch(/@1$/);
    const button = parseButton(data);
    if (!button) throw new Error("no button");
    const now = c.clock.now();
    const tap = (epoch: ForgetEpoch | undefined): ChannelEvent => ({ kind: "choice", choice: button.choice, at: now, ...(epoch === undefined ? {} : { epoch }) });
    expect(await enqueue(telegramEnvelope(c, 7001, now, tap(undefined)))).toBe("stale");
    expect(await enqueue(telegramEnvelope(c, 7002, now, tap(0 as ForgetEpoch)))).toBe("stale");
    expect(await enqueue(telegramEnvelope(c, 7003, now, tap(button.epoch)))).toBe("queued");
  });
});

describe("the hold while a forget is open", () => {
  test("nothing ordinary runs and the alarm doesn't spin, then everything resumes when it ends", async () => {
    const model = scripted([chat("Hi."), chat("Hello again!"), turn({ actions: [{ type: "quiet" }] })], {
      compaction: [{ kind: "output", value: { summary: "Some notes." } }],
    });
    const c = await devChat("fence-hold", { model, at: "2099-11-04T10:00" });
    await c.post("first");
    await c.settle();
    await c.received();
    const { op } = await begin(c);
    await sql(c, FORTY_ONE_NOTES);
    await sql(c, "UPDATE wakeup SET due_at = ? WHERE kind = 'checkin'", c.clock.now() - 1);

    await c.post("are you there?");
    await c.settle();
    const alarm = await nextAlarm(c);
    expect(alarm === null || alarm > c.clock.now()).toBe(true);
    expect(model.calls).toHaveLength(1);
    expect(await c.received()).toEqual([]);

    await end(c, op);
    await c.settle();
    expect(await c.received()).toContain("Hello again!");
  });

  test("a second forget makes the first one's end change nothing", async () => {
    const model = scripted([chat("Hello again!")]);
    const c = await devChat("fence-overlap", { model, at: "2099-11-04T10:00" });
    const first = await begin(c);
    const second = await begin(c);
    expect(second.epoch).toBe(first.epoch + 1);

    await c.post("are you there?");
    expect(await end(c, first.op)).toBe(false);
    await c.settle();
    expect(await c.received()).toEqual([]);

    expect(await end(c, second.op)).toBe(true);
    await c.settle();
    expect(await c.received()).toEqual(["Hello again!"]);
  });

  test("a cold start with a forget open keeps the hold and arms no busy alarm", async () => {
    const model = scripted([chat("Hello again!")]);
    const c = await devChat("fence-cold", { model, at: "2099-11-04T10:00" });
    const { op } = await begin(c);
    await c.post("are you there?");
    await c.settle();

    await coldDrain(c);
    const alarm = await nextAlarm(c);
    expect(alarm === null || alarm > c.clock.now()).toBe(true);
    expect(model.calls).toHaveLength(0);

    await end(c, op);
    await c.settle();
    expect(await c.received()).toEqual(["Hello again!"]);
  });
});

describe("box requests name the volume and the epoch", () => {
  test("every box turn carries the volume id the box reported and the current forget epoch", async () => {
    const volume = "3f0c7d9e-1b2a-4c5d-8e9f-0a1b2c3d4e5f";
    const box = fakeBox({ signedIn: true, volume });
    const c = await devChat("fence-volume", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    box.replies.push({ kind: "reply", step: chat("Hi from your box.") });
    await c.say("hello");
    const { op } = await begin(c);
    await end(c, op);
    box.replies.push({ kind: "reply", step: chat("Hi again.") });
    await c.say("hello again");

    expect(box.parses.map((p) => p.at)).toEqual([{ box: volume, epoch: 0 }, { box: volume, epoch: 1 }]);
  });

  test("a box the Worker creates requires every request to name an epoch", () => {
    const config = machineConfig(
      { apiToken: "t", org: "o", region: "sin", image: "registry.test/box:1", appPrefix: "gxb63a-", secret: "s" } as never,
      "token" as BoxToken,
      "vol_1",
    );
    expect(config.config.env).toMatchObject({ BOX_REQUIRE_EPOCH: "1" });
  });
});
