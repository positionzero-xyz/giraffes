/**
 * Drives a real Agent Durable Object through the real Worker route, with a scripted model, a fake clock
 * and an in-memory ledger. Runs under @cloudflare/vitest-pool-workers (isolated storage per test).
 *
 * The test talks the way a channel does (POST /webhook/dev) and reads what the person would see
 * (delivered outbox texts). It never reaches into tables, so a refactor of the store doesn't break tests.
 */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import type { Agent, AgentSnapshot } from "../src/agent/agent";
import type { EpochMs } from "../src/domain";
import type { LogRow, Ledger } from "../src/ledger/ledger";
import { scripted, type ScriptStep, type ScriptedModel } from "../src/model/scripted";

export { scripted };

export type DevChat = {
  /** POST /webhook/dev, then run the alarm until the agent is idle at the current fake time. */
  say(text: string): Promise<void>;
  /** Move the fake clock to a local wall time and run every alarm due up to it, in order. */
  advanceTo(local: string): Promise<void>;
  /** Texts delivered to the person since the last call, one string per outbox row (texts joined by \n). */
  received(): Promise<string[]>;
  snapshot(): Promise<AgentSnapshot>;
  /** Rows the agent shipped to the ledger, by stream. */
  logs<S extends LogRow["stream"]>(stream: S): Extract<LogRow, { stream: S }>[];
  /** Simulate a crash: drop the in-memory instance mid-turn (via a "hold" script step), then resume. */
  crashDuringNextModelCall(): Promise<void>;
};

export async function devChat(
  user: string,
  opts: { readonly model: ScriptedModel; readonly at: string; readonly tz?: string },
): Promise<DevChat> {
  // TODO:
  //   clock = fakeClock(fromLocal(opts.at, tz)); ledger = memoryLedger()
  //   stub = env.AGENT.get(env.AGENT.idFromName(`p:dev:${user}`))
  //   await runInDurableObject(stub, (agent: Agent) => agent.withDeps({ model: opts.model, clock, ledger }))
  //   say:       await SELF.fetch("https://x/webhook/dev", { method: "POST", body: JSON.stringify({ user, text, id }) })
  //              clock.advance(MESSAGE_DEBOUNCE_MS); await runUntilIdle()
  //   runUntilIdle: loop { const next = await runInDurableObject(stub, (_, state) => state.storage.getAlarm())
  //                        if (next === null || next > clock.now()) break; await runDurableObjectAlarm(stub) }
  //   advanceTo: step the clock to each alarm time <= target, run it, then set the clock to target
  void env; void runDurableObjectAlarm; void runInDurableObject; void SELF;
  throw new Error("not implemented");
}

/** Builds a ScriptStep whose value must satisfy TurnOutputSchema (checked when the agent calls). */
export function turn(o: {
  actions: unknown[];
  lateNotice?: string;
  task: [kind: string, key: string, status: string];
}): ScriptStep {
  return { kind: "output", value: { actions: o.actions, lateNotice: o.lateNotice, task: { kind: o.task[0], key: o.task[1], status: o.task[2] } } };
}
export const send = (text: string) => ({ type: "send", text });
export const schedule = (key: string, at: string, note: string) => ({ type: "schedule_wakeup", key, at, note });
export const cancel = (key: string) => ({ type: "cancel_wakeup", key });
export const quiet = () => ({ type: "quiet" });

export function fakeClock(start: EpochMs): { now(): EpochMs; set(t: EpochMs): void; advance(ms: number): void } {
  throw new Error("not implemented");
}

export function memoryLedger(opts?: { ceilingMicro?: number; failAppends?: boolean }): Ledger & { rows: LogRow[] } {
  throw new Error("not implemented");
}
