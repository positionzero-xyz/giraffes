/**
 * Scenarios use dates in 2099. The runtime fires a stored alarm on its own once the real clock passes
 * it, which would race the test's explicit runs; far-future fake times keep every alarm in the future.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import type { Agent, AgentSnapshot } from "../src/agent/agent";
import type { ChannelAdapter } from "../src/channels/channel";
import { personAgentKey, type EpochMs, type LocalDateTime, type MicroUsd } from "../src/domain";
import type { LeaseAnswer, Ledger, LogRow } from "../src/ledger/ledger";
import { scripted, type ScriptStep, type ScriptedModel } from "../src/model/scripted";
import { SPEND } from "../src/policy/spend";
import { DEFAULT_TIME_ZONE, fromLocal, toLocal } from "../src/policy/time";

export { scripted };

export const local = (s: string): EpochMs => fromLocal(s as LocalDateTime, DEFAULT_TIME_ZONE);
export const wall = (t: EpochMs): string => toLocal(t, DEFAULT_TIME_ZONE);

export type FakeClock = { now(): EpochMs; set(t: EpochMs): void };

export function fakeClock(start: EpochMs): FakeClock {
  let t = start;
  return {
    now: () => t,
    set(next) {
      t = next;
    },
  };
}

export type MemoryLedger = Ledger & { readonly rows: readonly LogRow[] };

export function memoryLedger(opts: { readonly ceilingMicro?: number } = {}): MemoryLedger {
  const ceiling = opts.ceilingMicro ?? SPEND.globalCeilingMicro;
  const rows: LogRow[] = [];
  const seen = new Set<string>();
  const leases = new Map<string, { month: string; micro: MicroUsd }>();
  return {
    rows,
    async append(batch) {
      for (const row of batch) {
        const key = `${row.stream}:${row.id}`;
        if (!seen.has(key)) rows.push(row);
        seen.add(key);
      }
    },
    async requestLease(req): Promise<LeaseAnswer> {
      const key = `${req.agent}|${req.month}|${req.seq}`;
      const existing = leases.get(key);
      if (existing) return { kind: "granted", micro: existing.micro };
      const used = [...leases.values()].filter((l) => l.month === req.month).reduce((sum, l) => sum + l.micro, 0);
      if (used + req.micro > ceiling) return { kind: "ceiling" };
      leases.set(key, { month: req.month, micro: req.micro });
      return { kind: "granted", micro: req.micro };
    },
  };
}

export type DeliveryStep =
  | { readonly kind: "sent" }
  | { readonly kind: "retry"; readonly afterMs: number }
  | { readonly kind: "throw" }
  | { readonly kind: "gone" };

export type Delivered = { readonly at: EpochMs; readonly text: string; readonly via: "reply" | "push" };

export type ScriptedChannel = ChannelAdapter & { readonly delivered: readonly Delivered[] };

/** Plays one step per delivery attempt, then delivers everything once the script runs out. */
export function scriptedChannel(steps: readonly DeliveryStep[] = []): ScriptedChannel {
  const queue = [...steps];
  const delivered: Delivered[] = [];
  return {
    delivered,
    receive: async () => {
      throw new Error("the agent never receives through its channel");
    },
    async deliver(msg, now) {
      const step = queue.shift() ?? { kind: "sent" };
      switch (step.kind) {
        case "sent": {
          const via = msg.reply !== undefined && !msg.inDoubt && now < msg.reply.expiresAt ? "reply" : "push";
          delivered.push({ at: now, text: msg.texts.join("\n"), via });
          return { kind: "sent", via };
        }
        case "retry":
          return { kind: "retry", afterMs: step.afterMs, detail: "scripted retry" };
        case "throw":
          throw new Error("scripted exception from the channel");
        case "gone":
          return { kind: "recipient_gone" };
      }
    },
  };
}

export type DevChat = {
  readonly model: ScriptedModel;
  readonly clock: FakeClock;
  readonly channel: ScriptedChannel;
  post(text: string, opts?: { readonly id?: string; readonly at?: EpochMs }): Promise<Response>;
  say(text: string, opts?: { readonly id?: string; readonly at?: EpochMs }): Promise<void>;
  settle(): Promise<void>;
  alarm(): Promise<void>;
  advanceTo(local: string): Promise<void>;
  received(): Promise<string[]>;
  snapshot(): Promise<AgentSnapshot>;
  logs<S extends LogRow["stream"]>(stream: S): Extract<LogRow, { stream: S }>[];
};

let messageIds = 0;

export async function devChat(
  user: string,
  opts: {
    readonly model: ScriptedModel;
    readonly at: string;
    readonly ledger?: MemoryLedger;
    readonly deliveries?: readonly DeliveryStep[];
  },
): Promise<DevChat> {
  const clock = fakeClock(local(opts.at));
  const ledger = opts.ledger ?? memoryLedger();
  const channel = scriptedChannel(opts.deliveries);
  const stub = env.AGENT.get(env.AGENT.idFromName(personAgentKey({ channel: "dev", channelUserId: user })));
  const channels = { line: channel, telegram: channel, dev: channel };
  await runInDurableObject<Agent, void>(stub, (agent) => agent.withDeps({ model: opts.model, clock, ledger, channels }));
  let seen = 0;
  const nextAlarm = () => runInDurableObject(stub, (_agent, state) => state.storage.getAlarm());

  const chat: DevChat = {
    model: opts.model,
    clock,
    channel,
    post(text, o = {}) {
      const body = { user, text, id: o.id ?? `m${++messageIds}`, at: o.at ?? clock.now() };
      return SELF.fetch("https://agent.test/webhook/dev", { method: "POST", body: JSON.stringify(body) });
    },
    async say(text, o) {
      const res = await chat.post(text, o);
      if (!res.ok) throw new Error(`webhook answered ${res.status}`);
      await chat.settle();
    },
    async settle() {
      for (let i = 0; i < 50; i++) {
        await chat.alarm();
        const next = await nextAlarm();
        if (next === null || next > clock.now()) return;
      }
      throw new Error("the agent never went idle");
    },
    alarm: () => runInDurableObject<Agent, void>(stub, (agent) => agent.alarm()),
    async advanceTo(to) {
      const target = local(to);
      for (;;) {
        const next = await nextAlarm();
        if (next === null || next > target) break;
        clock.set(Math.max(next, clock.now()) as EpochMs);
        await chat.settle();
      }
      clock.set(target);
      await chat.settle();
    },
    async received() {
      const fresh = channel.delivered.slice(seen);
      seen = channel.delivered.length;
      return fresh.map((d) => d.text);
    },
    snapshot: () => stub.snapshot(),
    logs: (stream) => ledger.rows.filter((r): r is Extract<LogRow, { stream: typeof stream }> => r.stream === stream),
  };
  return chat;
}

export function turn(o: {
  readonly actions: unknown[];
  readonly lateNotice?: string;
  readonly task: readonly [kind: string, key: string, status: string];
  readonly usage?: Extract<ScriptStep, { kind: "output" }>["usage"];
}): ScriptStep {
  const task = { kind: o.task[0], key: o.task[1], status: o.task[2] };
  const value = o.lateNotice === undefined ? { actions: o.actions, task } : { actions: o.actions, lateNotice: o.lateNotice, task };
  return o.usage ? { kind: "output", value, usage: o.usage } : { kind: "output", value };
}
export const send = (text: string) => ({ type: "send", text });
export const schedule = (key: string, at: string, note: string, asked = true) => ({ type: "schedule_wakeup", key, at, note, asked });
export const cancel = (key: string) => ({ type: "cancel_wakeup", key });
export const quiet = () => ({ type: "quiet" });
export const throws = (): ScriptStep => ({ kind: "throw" });
export const hold = (then: ScriptStep): ScriptStep => ({ kind: "hold", then });
export const chat = (text: string): ScriptStep => turn({ actions: [send(text)], task: ["chat", "chat", "none"] });
