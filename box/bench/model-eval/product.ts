import type { AgentReply, AgentRequest, Usage } from "../../src/claude.ts";
import type { Candidate, Observation, RunStatus, Wall, Wakeup } from "./types.ts";
import { AGENT_SYSTEM, AGENT_TOOLS, BoxTurnOutputSchema, fromLocal, parseTimeZone, planTurn, renderPrompt, renderUser, toLocal, turnFromAgent } from "./worker.ts";

export const TZ = "Asia/Bangkok";
const tz = parseTimeZone(TZ);

export const effortOf = (c: Candidate) => (c.effort === "default" ? undefined : c.effort);

export function viewOf(message: string, now: Wall) {
  const at = fromLocal(now, tz);
  return {
    now: at,
    tz,
    language: "th",
    status: "active",
    statusAt: 0,
    checkinLocal: "09:00",
    admission: { state: "admitted", seat: { cohort: "staff", half: null, code: null, inviter: null }, at: 0 },
    batch: { items: [{ key: "eval:0", event: { kind: "message", text: message }, attempts: 1, receivedAt: at }] },
    summary: "",
    notes: [],
    recent: [],
    historyLeftOut: 0,
    pending: [],
    openTasks: [],
    acceptable: null,
    tapped: [],
    unaskedLeftToday: 3,
  };
}

export function agentRequest(c: Candidate, message: string, now: Wall): AgentRequest {
  const parts = renderUser(viewOf(message, now));
  const turn = renderPrompt({ sections: parts.sections.filter((s: { history?: boolean }) => !s.history) });
  const effort = effortOf(c);
  return { model: c.model, append: AGENT_SYSTEM, turn, tools: AGENT_TOOLS, ...(effort ? { effort } : {}) };
}

export const NO_OBSERVATION: Observation = { text: "", wakeups: [], rejected: [], files: {}, page: null };

export type TurnRead = {
  readonly status: RunStatus;
  readonly observation: Observation;
  readonly calls: readonly unknown[];
  readonly refusedCalls: readonly unknown[];
  readonly usage: Usage | null;
  readonly costUsd: number | null;
};

/** A 200 reply from the box turn, read the way the Worker reads it and planned against the eval's view. */
export function readTurn(body: Extract<AgentReply, { status: 200 }>["body"], message: string, now: Wall): TurnRead {
  const base = { calls: body.calls, refusedCalls: body.refusedCalls, usage: body.usage, costUsd: body.costUsd };
  const parsed = BoxTurnOutputSchema.safeParse(turnFromAgent(body));
  if (!parsed.success) return { status: "invalid_output", observation: { ...NO_OBSERVATION, text: body.text }, ...base };
  const commit = planTurn(parsed.data, viewOf(message, now));
  const wakeups: Wakeup[] = commit.wakeupsAdd.map((w: { dueAt: number; repeat: { every: Wakeup["repeat"] } | null; origin: string }) => ({
    at: toLocal(w.dueAt, tz),
    repeat: w.repeat?.every ?? null,
    asked: w.origin === "person",
  }));
  const rejected = commit.rejected.map((r: { action: string; reason: string }) => `${r.action} ${r.reason}`);
  return { status: "ok", observation: { text: body.text.trim(), wakeups, rejected, files: {}, page: null }, ...base };
}
