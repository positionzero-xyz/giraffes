import type { AgentReply, AgentRequest, Usage } from "../../src/claude.ts";
import type { Candidate, Contract, Observation, RunStatus, Tap, Wall, Wakeup } from "./types.ts";
import {
  boxTurnAttempt,
  boxTurnRequest,
  CHANNEL_LANGUAGE,
  checkinWakeup,
  fromLocal,
  OUTREACH,
  parseTimeZone,
  planTurn,
  readAgentBody,
  renderUser,
  SCHEDULE,
  toLocal,
  TURN_SYSTEM,
  UNREADABLE_REPLY,
} from "./worker.ts";

export const TZ = "Asia/Bangkok";
const tz = parseTimeZone(TZ);

export const effortOf = (c: Candidate) => (c.effort === "default" ? undefined : c.effort);

/** The channel the eval plays: Thailand first, so LINE, whose notices start in Thai. */
export const CHANNEL = "line";

/**
 * A fresh LINE person's first box turn, built as the Worker builds one: their check-in pending and a full day's unasked
 * budget. A box turn comes only after the person sent /claude and signed in, so there is history, which the box never sees.
 */
export function viewOf(message: string, now: Wall) {
  const at = fromLocal(now, tz);
  return {
    now: at,
    tz,
    language: CHANNEL_LANGUAGE[CHANNEL],
    status: "active",
    statusAt: 0,
    checkinLocal: SCHEDULE.defaultCheckinLocal,
    admission: { state: "admitted", seat: { cohort: "staff", half: null, code: null, inviter: null }, at: 0 },
    batch: { items: [{ key: "eval:0", event: { kind: "message", text: message }, attempts: 1, receivedAt: at }] },
    summary: "",
    notes: [],
    recent: [{ role: "person", text: "/claude", at: at - 60_000 }],
    historyLeftOut: 0,
    pending: [checkinWakeup(at - 60_000, tz, SCHEDULE.defaultCheckinLocal)],
    openTasks: [],
    acceptable: null,
    tapped: [],
    unaskedLeftToday: OUTREACH.dailyUnaskedBudget,
  };
}

export function agentRequest(c: Candidate, message: string, now: Wall): AgentRequest {
  const sent = boxTurnRequest(TURN_SYSTEM, renderUser(viewOf(message, now)));
  if (sent === null) throw new Error("the turn doesn't fit the box route");
  const effort = effortOf(c);
  return { ...sent, model: c.model, ...(effort ? { effort } : {}) };
}

export const NO_OBSERVATION: Observation = { text: "", raw: "", answered: false, wakeups: [], rejected: [], files: {}, page: null };

export type TurnRead = {
  readonly status: RunStatus;
  readonly observation: Observation;
  readonly calls: readonly unknown[];
  readonly refusedCalls: readonly unknown[];
  readonly usage: Usage | null;
  readonly costUsd: number | null;
};

export function failedTurn(status: 409 | 502, tap: Tap | null): TurnRead {
  const kind: RunStatus = tap?.killed ? "timeout" : status === 409 ? "signed_out" : "claude_failed";
  return { status: kind, observation: NO_OBSERVATION, calls: [], refusedCalls: [], usage: tap?.usage ?? null, costUsd: tap?.costUsd ?? null };
}

const FAILED: Readonly<Record<string, RunStatus>> = { refused_by_model: "refused", invalid: "invalid_output" };

export function readTurn(body: Extract<AgentReply, { status: 200 }>["body"], message: string, now: Wall, contract: Contract = "product"): TurnRead {
  const base = { calls: body.calls, refusedCalls: body.refusedCalls, usage: body.usage, costUsd: body.costUsd };
  const attempt = boxTurnAttempt(readAgentBody(JSON.parse(JSON.stringify(body))) ?? UNREADABLE_REPLY);
  if (attempt.kind !== "ok") {
    const status = body.stop === "max_tokens" ? "cut_off" : (FAILED[attempt.kind] ?? "invalid_output");
    return { status, observation: { ...NO_OBSERVATION, text: body.text, raw: body.text }, ...base };
  }
  const commit = planTurn(attempt.value, viewOf(message, now));
  const wakeups: Wakeup[] = commit.wakeupsAdd.map((w: { dueAt: number; repeat: { every: Wakeup["repeat"] } | null; origin: string; note: string }) => ({
    at: toLocal(w.dueAt, tz),
    repeat: w.repeat?.every ?? null,
    asked: w.origin === "person",
    note: w.note,
  }));
  const rejected = commit.rejected.map((r: { action: string; reason: string }) => `${r.action} ${r.reason}`);
  const raw = body.text.trim();
  const delivered = commit.outbound?.texts.join("\n") ?? "";
  const answered = commit.turns.some((t: { role: string }) => t.role === "agent");
  return { status: "ok", observation: { text: contract === "product" ? delivered : raw, raw, answered, wakeups, rejected, files: {}, page: null }, ...base };
}
