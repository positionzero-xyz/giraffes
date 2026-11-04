import {
  assertNever,
  type AgentEventKind,
  type AgentKey,
  type ChannelId,
  type EpochMs,
  type Cohort,
  type FactCause,
  type FactKind,
  type Half,
  type InviteCode,
  type LocalDate,
  type MicroUsd,
  type TaskKind,
  type TaskRef,
  type UtcMonth,
} from "../domain";
import { TASK_REJECTIONS, type UnaskedPurpose } from "../agent/tasks";
import type { AdmissionChange, InviteCheck, SeatAnswer } from "../agent/admission";
import type { BoxHostKind } from "../box/host";
import type { BoxName } from "../box/names";
import type { Usage } from "../model/client";
import type { ModelRef } from "../model/providers";
import type { CallPurpose } from "../model/routes";
import type { QuotaReading } from "../policy/quota";
import { REMINDER_REJECTIONS } from "../policy/schedule";

export type LogRow =
  | {
      readonly stream: "agent";
      readonly id: string;
      readonly agent: AgentKey;
      readonly channel: ChannelId;
      readonly firstSeenAt: EpochMs;
    }
  | {
      readonly stream: "turn";
      readonly id: string;
      readonly agent: AgentKey;
      readonly eventKind: AgentEventKind;
      readonly batchSize: number;
      readonly outcome: TurnOutcome;
      readonly refusedForBudget: boolean;
      readonly costMicro: MicroUsd;
      readonly attempts: number;
      readonly startedAt: EpochMs;
      readonly finishedAt: EpochMs;
    }
  | {
      readonly stream: "model_call";
      readonly id: string;
      readonly agent: AgentKey;
      readonly purpose: CallPurpose;
      readonly model: ModelRef;
      readonly backend: Backend;
      readonly status: ModelCallStatus;
      readonly estimateMicro: MicroUsd;
      readonly costMicro: MicroUsd;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
      readonly at: EpochMs;
    }
  | {
      readonly stream: "unasked";
      readonly id: string;
      readonly agent: AgentKey;
      readonly triggerKind: AgentEventKind;
      readonly text: string;
      readonly status: UnaskedStatus;
      readonly day: LocalDate | null;
      readonly at: EpochMs;
      /** `<agent>|t<task id>`; null when the message is about no task. */
      readonly taskId: string | null;
      readonly purpose: UnaskedPurpose;
    }
  | {
      readonly stream: "task";
      /** `<agent>|t<task id>`, deterministic so a re-flush is a no-op. */
      readonly id: string;
      readonly agent: AgentKey;
      readonly ref: TaskRef;
      readonly kind: TaskKind;
      readonly title: string;
      readonly causeKind: FactCause["kind"];
      readonly openedAt: EpochMs;
    }
  | {
      readonly stream: "task_fact";
      /** `<agent>|f<fact id>`. */
      readonly id: string;
      readonly agent: AgentKey;
      readonly taskId: string;
      readonly kind: FactKind;
      readonly ref: string;
      readonly detail: string;
      /** This fact moved the task to completed. At most one fact per task has it. */
      readonly completes: boolean;
      readonly personDecision: boolean;
      readonly causeKind: FactCause["kind"];
      readonly causeAt: EpochMs;
      readonly at: EpochMs;
    }
  | {
      readonly stream: "admission";
      readonly id: string;
      readonly agent: AgentKey;
      readonly change: AdmissionChange;
      /** The waitlist reason, or the cohort a person was admitted to. */
      readonly reason: string | null;
      readonly channel: ChannelId;
      readonly at: EpochMs;
    }
  | {
      readonly stream: "lifecycle";
      readonly id: string;
      readonly agent: AgentKey;
      readonly change: "follow" | "block";
      readonly source: "channel" | "delivery";
      readonly at: EpochMs;
    }
  | {
      readonly stream: "rejection";
      readonly id: string;
      readonly agent: AgentKey;
      readonly turnId: string;
      readonly action: string;
      readonly reason: ActionRejection;
      readonly at: EpochMs;
    };

export const MODEL_CALL_STATUSES = [
  "settled",
  "refused_user_cap",
  "refused_global_ceiling",
  "recovered_after_crash",
  "unavailable",
  "rejected",
  "in_doubt",
  "provider_refused",
  "usage_missing",
] as const;
export type ModelCallStatus = (typeof MODEL_CALL_STATUSES)[number];

/** `api` is history: calls on our key before each person brought their own access. */
export const BACKENDS = ["api", "box", "key", "included"] as const;
export type Backend = (typeof BACKENDS)[number];

export const TURN_OUTCOMES = ["acted", "quiet", "refused_budget", "lapsed", "no_access", "model_failed", "poison", "no_model", "stale", "not_admitted"] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export const ACTION_REJECTIONS = [
  ...REMINDER_REJECTIONS,
  ...TASK_REJECTIONS,
  "not_pending",
  "bad_zone",
  "too_many_sends",
  "too_many_actions",
  "too_long",
] as const;
export type ActionRejection = (typeof ACTION_REJECTIONS)[number];

export const UNASKED_STATUSES = ["sent", "dropped_budget", "dropped_blocked", "dropped_quota", "failed"] as const;
export type UnaskedStatus = (typeof UNASKED_STATUSES)[number];

export function modelCallRow(input: {
  readonly id: string;
  readonly agent: AgentKey;
  readonly purpose: CallPurpose;
  readonly model: ModelRef;
  readonly backend: Backend;
  readonly status: ModelCallStatus;
  readonly estimate: MicroUsd;
  readonly cost: MicroUsd;
  readonly usage: Usage | null;
  readonly at: EpochMs;
}): LogRow {
  return {
    stream: "model_call",
    id: input.id,
    agent: input.agent,
    purpose: input.purpose,
    model: input.model,
    backend: input.backend,
    status: input.status,
    estimateMicro: input.estimate,
    costMicro: input.cost,
    inputTokens: input.usage?.inputTokens ?? 0,
    outputTokens: input.usage?.outputTokens ?? 0,
    cacheReadTokens: input.usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: input.usage?.cacheWriteTokens ?? 0,
    at: input.at,
  };
}

export type BoxClaim = {
  readonly agent: AgentKey;
  readonly name: BoxName;
  readonly host: BoxHostKind;
  readonly at: EpochMs;
  readonly max: number;
};

export type SeatCaps = { readonly recruit: number; readonly joiner: number };

export interface Ledger {
  /** Reads only: a code is checked when it is presented, and nobody holds a seat before consenting. */
  checkInvite(req: { readonly code: InviteCode; readonly agent: AgentKey; readonly caps: SeatCaps }): Promise<InviteCheck>;
  /** One conditional insert. A retry by the same person gets their seat back, and a seat is never freed. */
  claimSeat(req: { readonly agent: AgentKey; readonly code: InviteCode; readonly channel: ChannelId; readonly at: EpochMs; readonly caps: SeatCaps }): Promise<SeatAnswer>;
  issueInvite(req: { readonly issuer: AgentKey; readonly code: InviteCode; readonly at: EpochMs; readonly max: number }): Promise<"issued" | "taken" | "limit" | "not_enrolled">;
  append(rows: readonly LogRow[]): Promise<void>;
  claimBox(req: BoxClaim): Promise<"granted" | "full">;
  releaseBox(agent: AgentKey, at: EpochMs): Promise<void>;
  recordLineQuota(r: QuotaReading): Promise<void>;
  lineQuota(): Promise<QuotaReading | null>;
  lineQuotaAlerts(month: UtcMonth): Promise<number[]>;
  lineQuotaAlerted(month: UtcMonth, percent: number, via: "line" | "telegram" | "log", at: EpochMs): Promise<void>;
}

const APPEND_CHUNK = 100;

function insertFor(db: D1Database, row: LogRow): D1PreparedStatement {
  switch (row.stream) {
    case "agent":
      return db
        .prepare("INSERT INTO agent (id, agent_key, channel, first_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
        .bind(row.id, row.agent, row.channel, row.firstSeenAt);
    case "turn":
      return db
        .prepare(
          `INSERT INTO turn_log (id, agent_key, event_kind, batch_size, outcome, refused_for_budget, cost_micro, attempts, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          row.id,
          row.agent,
          row.eventKind,
          row.batchSize,
          row.outcome,
          row.refusedForBudget ? 1 : 0,
          row.costMicro,
          row.attempts,
          row.startedAt,
          row.finishedAt,
        );
    case "model_call":
      return db
        .prepare(
          `INSERT INTO model_call (id, agent_key, purpose, model, backend, status, estimate_micro, cost_micro,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          row.id,
          row.agent,
          row.purpose,
          row.model,
          row.backend,
          row.status,
          row.estimateMicro,
          row.costMicro,
          row.inputTokens,
          row.outputTokens,
          row.cacheReadTokens,
          row.cacheWriteTokens,
          row.at,
        );
    case "unasked":
      return db
        .prepare(
          `INSERT INTO unasked_message (id, agent_key, trigger_kind, text, status, day, at, task_id, purpose)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(row.id, row.agent, row.triggerKind, row.text, row.status, row.day, row.at, row.taskId, row.purpose);
    case "task":
      return db
        .prepare(
          `INSERT INTO task (id, agent_key, ref, kind, title, cause_kind, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(row.id, row.agent, row.ref, row.kind, row.title, row.causeKind, row.openedAt);
    case "task_fact":
      return db
        .prepare(
          `INSERT INTO task_fact (id, agent_key, task_id, kind, ref, detail, completes, person_decision, cause_kind, cause_at, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          row.id,
          row.agent,
          row.taskId,
          row.kind,
          row.ref,
          row.detail,
          row.completes ? 1 : 0,
          row.personDecision ? 1 : 0,
          row.causeKind,
          row.causeAt,
          row.at,
        );
    case "lifecycle":
      return db
        .prepare("INSERT INTO lifecycle (id, agent_key, change, source, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
        .bind(row.id, row.agent, row.change, row.source, row.at);
    case "admission":
      return db
        .prepare("INSERT INTO admission_log (id, agent_key, change, reason, channel, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
        .bind(row.id, row.agent, row.change, row.reason, row.channel, row.at);
    case "rejection":
      return db
        .prepare("INSERT INTO action_rejection (id, agent_key, turn_id, action, reason, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
        .bind(row.id, row.agent, row.turnId, row.action, row.reason, row.at);
    default:
      return assertNever(row);
  }
}

type InviteCols = { cohort: Cohort; half: Half | null; used: number; taken: number };

const INVITE_STATE = `SELECT c.cohort,
         CASE c.cohort WHEN 'joiner' THEN (SELECT half FROM enrollment WHERE agent_key = c.issuer) ELSE c.half END AS half,
         EXISTS (SELECT 1 FROM enrollment e WHERE e.code = c.code AND e.agent_key != ?2) AS used,
         (SELECT COUNT(*) FROM enrollment e WHERE e.cohort = c.cohort AND e.agent_key != ?2) AS taken
       FROM invite_code c WHERE c.code = ?1 AND c.issuer != ?2`;

function inviteCheck(r: InviteCols | null, caps: SeatCaps): InviteCheck {
  if (r === null) return { kind: "bad_code" };
  if (r.used) return { kind: "used" };
  if (r.cohort !== "staff" && r.taken >= caps[r.cohort]) return { kind: "full" };
  return { kind: "ok", cohort: r.cohort, half: r.half };
}

export function d1Ledger(db: D1Database): Ledger {
  return {
    async checkInvite(req) {
      return inviteCheck(await db.prepare(INVITE_STATE).bind(req.code, req.agent).first<InviteCols>(), req.caps);
    },
    async claimSeat(req) {
      const [, seated, state] = await db.batch([
        db
          .prepare(
            `INSERT INTO enrollment (agent_key, code, cohort, half, inviter, channel, seated_at)
             SELECT ?1, c.code, c.cohort,
                    CASE c.cohort WHEN 'joiner' THEN (SELECT half FROM enrollment WHERE agent_key = c.issuer) ELSE c.half END,
                    NULLIF(c.issuer, 'operator'), ?3, ?4
             FROM invite_code c
             WHERE c.code = ?2 AND c.issuer != ?1
               AND NOT EXISTS (SELECT 1 FROM enrollment e WHERE e.code = c.code)
               AND (c.cohort = 'staff'
                    OR (SELECT COUNT(*) FROM enrollment e WHERE e.cohort = c.cohort) < CASE c.cohort WHEN 'recruit' THEN ?5 ELSE ?6 END)
             ON CONFLICT (agent_key) DO NOTHING`,
          )
          .bind(req.agent, req.code, req.channel, req.at, req.caps.recruit, req.caps.joiner),
        db.prepare("SELECT cohort, half, code, inviter FROM enrollment WHERE agent_key = ?1").bind(req.agent),
        db.prepare(INVITE_STATE).bind(req.code, req.agent),
      ]);
      const seat = seated?.results[0] as { cohort: Cohort; half: Half | null; code: InviteCode; inviter: AgentKey | null } | undefined;
      if (seat) return { kind: "granted", seat };
      const check = inviteCheck((state?.results[0] as InviteCols | undefined) ?? null, req.caps);
      return check.kind === "ok" ? { kind: "full" } : check;
    },
    async issueInvite(req) {
      const [inserted, issuer] = await db.batch([
        db
          .prepare(
            `INSERT INTO invite_code (code, cohort, half, issuer, created_at)
             SELECT ?1, 'joiner', NULL, ?2, ?3
             WHERE EXISTS (SELECT 1 FROM enrollment WHERE agent_key = ?2 AND cohort IN ('recruit', 'joiner'))
               AND (SELECT COUNT(*) FROM invite_code WHERE issuer = ?2) < ?4
             ON CONFLICT (code) DO NOTHING`,
          )
          .bind(req.code, req.issuer, req.at, req.max),
        db
          .prepare(
            `SELECT EXISTS (SELECT 1 FROM enrollment WHERE agent_key = ?1 AND cohort IN ('recruit', 'joiner')) AS enrolled,
                    (SELECT COUNT(*) FROM invite_code WHERE issuer = ?1) AS issued`,
          )
          .bind(req.issuer),
      ]);
      if ((inserted?.meta.changes ?? 0) > 0) return "issued";
      const r = issuer?.results[0] as { enrolled: number; issued: number } | undefined;
      if (!r?.enrolled) return "not_enrolled";
      return r.issued >= req.max ? "limit" : "taken";
    },
    async append(rows) {
      for (let i = 0; i < rows.length; i += APPEND_CHUNK) {
        await db.batch(rows.slice(i, i + APPEND_CHUNK).map((row) => insertFor(db, row)));
      }
    },
    async claimBox(req) {
      const [, live] = await db.batch([
        db
          .prepare(
            `INSERT INTO boxes (agent_key, name, host, created_at)
             SELECT ?1, ?2, ?3, ?4
             WHERE (SELECT COUNT(*) FROM boxes WHERE deleted_at IS NULL) < ?5
             ON CONFLICT (agent_key) DO UPDATE SET name = excluded.name, host = excluded.host, created_at = excluded.created_at, deleted_at = NULL
               WHERE boxes.deleted_at IS NOT NULL`,
          )
          .bind(req.agent, req.name, req.host, req.at, req.max),
        db.prepare("SELECT 1 AS one FROM boxes WHERE agent_key = ?1 AND deleted_at IS NULL").bind(req.agent),
      ]);
      return live?.results.length ? "granted" : "full";
    },
    async releaseBox(agent, at) {
      await db.prepare("UPDATE boxes SET deleted_at = ? WHERE agent_key = ? AND deleted_at IS NULL").bind(at, agent).run();
    },
    async recordLineQuota(r) {
      await db
        .prepare("INSERT INTO line_quota (at, month, quota, used) VALUES (?, ?, ?, ?) ON CONFLICT (at) DO NOTHING")
        .bind(r.at, r.month, r.limit, r.used)
        .run();
    },
    async lineQuota() {
      const r = await db
        .prepare("SELECT at, month, quota, used FROM line_quota ORDER BY at DESC LIMIT 1")
        .first<{ at: EpochMs; month: UtcMonth; quota: number | null; used: number }>();
      return r ? { at: r.at, month: r.month, limit: r.quota, used: r.used } : null;
    },
    async lineQuotaAlerts(month) {
      const { results } = await db.prepare("SELECT percent FROM line_quota_alert WHERE month = ?").bind(month).all<{ percent: number }>();
      return results.map((r) => r.percent);
    },
    async lineQuotaAlerted(month, percent, via, at) {
      await db
        .prepare("INSERT INTO line_quota_alert (month, percent, via, at) VALUES (?, ?, ?, ?) ON CONFLICT (month, percent) DO NOTHING")
        .bind(month, percent, via, at)
        .run();
    },
  };
}
