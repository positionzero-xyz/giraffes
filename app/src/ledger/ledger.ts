/**
 * The cross-user record, in D1. Owns two kinds of fact:
 *   1. Instrumentation rows (append-only, queryable across all users; the MVP gates are views over them).
 *   2. Global-ceiling leases (the only cross-user *write* that gates behavior).
 *
 * Agents never write D1 inside an event. They write `LogRow`s to their local `log_outbox` in the same
 * SQLite transaction as the state change they describe, then `append` ships them. Every row carries a
 * deterministic id, so a re-shipped batch is `INSERT OR IGNORE` and the log is exactly-once in effect.
 */
import {
  assertNever,
  type AgentEventKind,
  type AgentKey,
  type ChannelId,
  type EpochMs,
  type LocalDate,
  type MicroUsd,
  type MonthKey,
  type TaskKind,
  type TaskStatus,
} from "../domain";
import type { ModelId, Purpose, Usage } from "../model/model";

/**
 * One union, one table per variant, one mapping in `append`. Adding a stream = adding a variant here and a
 * table in d1-schema.sql; `append`'s exhaustive switch fails the build until the mapping exists.
 */
export type LogRow =
  | {
      readonly stream: "agent";
      /** `agent:<key>` — written once per agent, on its first event. Cohort dimension for the gates. */
      readonly id: string;
      readonly agent: AgentKey;
      readonly channel: ChannelId;
      readonly firstSeenAt: EpochMs;
    }
  | {
      readonly stream: "turn";
      /** `<agent>|<first event key of the batch>` — one row per committed turn. */
      readonly id: string;
      readonly agent: AgentKey;
      readonly eventKind: AgentEventKind;
      readonly batchSize: number;
      readonly taskKind: TaskKind | null;
      readonly taskKey: string | null;
      readonly taskStatus: TaskStatus;
      readonly outcome: TurnOutcome;
      readonly refusedForBudget: boolean;
      readonly costMicro: MicroUsd;
      readonly attempts: number;
      readonly startedAt: EpochMs;
      readonly finishedAt: EpochMs;
    }
  | {
      readonly stream: "model_call";
      /** The reservation id; for a refusal, which reserved nothing, `refused:<turn id>`. */
      readonly id: string;
      readonly agent: AgentKey;
      readonly purpose: Purpose;
      readonly model: ModelId;
      readonly status: ModelCallStatus;
      readonly estimateMicro: MicroUsd;
      /** Actual for settled; the estimate for recovered (we can't know); 0 for refused and unavailable. */
      readonly costMicro: MicroUsd;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheWriteTokens: number;
      readonly at: EpochMs;
    }
  | {
      readonly stream: "unasked";
      /** The outbox id. One row per unasked delivery decision that is final (sent or dropped). */
      readonly id: string;
      readonly agent: AgentKey;
      readonly triggerKind: AgentEventKind;
      readonly text: string;
      readonly status: "sent" | "dropped_budget" | "dropped_blocked" | "failed";
      readonly day: LocalDate | null;
      readonly at: EpochMs;
    }
  | {
      readonly stream: "lifecycle";
      /** The inbound event key, or `gone:<outbox id>` when a delivery found the person gone. */
      readonly id: string;
      readonly agent: AgentKey;
      readonly change: "follow" | "block";
      /** "channel": the platform told us. "delivery": a send came back recipient_gone. */
      readonly source: "channel" | "delivery";
      readonly at: EpochMs;
    };

export type ModelCallStatus =
  | "settled"
  | "refused_user_cap"
  | "refused_global_ceiling"
  | "recovered_after_crash"
  /** The provider was unreachable or overloaded; nothing was billed and the batch was retried. */
  | "unavailable";

export type TurnOutcome =
  | "acted" // at least one action applied
  | "quiet" // model chose quiet
  | "refused_budget"
  | "model_failed" // invalid_output / refused_by_model / unavailable after retries
  | "poison" // gave up after TURN.maxAttempts crashes
  | "no_model" // handled by code alone (a block)
  | "stale"; // a lifecycle event older than the last applied one: logged, not applied

/** Builds the model_call row for one reservation, so turns, compaction and recovery log calls alike. */
export function modelCallRow(input: {
  readonly id: string;
  readonly agent: AgentKey;
  readonly purpose: Purpose;
  readonly model: ModelId;
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

export type LeaseRequest = {
  readonly agent: AgentKey;
  readonly month: MonthKey;
  /** Per-agent sequence. The agent persists `seq` before asking, so a retry after a crash reuses it. */
  readonly seq: number;
  readonly micro: MicroUsd;
  readonly at: EpochMs;
};

/** `micro` is what the ledger holds for this seq, which a retried request may have asked for differently. */
export type LeaseAnswer = { readonly kind: "granted"; readonly micro: MicroUsd } | { readonly kind: "ceiling" };

export interface Ledger {
  /** Idempotent by row id. Throws on D1 unavailability; the caller keeps the rows and backs off. */
  append(rows: readonly LogRow[]): Promise<void>;
  /**
   * Atomically grant `micro` against the global ceiling for `month`, unless that would exceed it.
   * Idempotent by (agent, month, seq): a repeated request returns the original answer.
   */
  requestLease(req: LeaseRequest): Promise<LeaseAnswer>;
}

/** D1 caps bound parameters per statement; a batch of single-row inserts stays far below it. */
const APPEND_CHUNK = 100;

function insertFor(db: D1Database, row: LogRow): D1PreparedStatement {
  switch (row.stream) {
    case "agent":
      return db
        .prepare("INSERT OR IGNORE INTO agent (id, agent_key, channel, first_seen_at) VALUES (?, ?, ?, ?)")
        .bind(row.id, row.agent, row.channel, row.firstSeenAt);
    case "turn":
      return db
        .prepare(
          `INSERT OR IGNORE INTO turn_log (id, agent_key, event_kind, batch_size, task_kind, task_key, task_status,
             outcome, refused_for_budget, cost_micro, attempts, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.agent,
          row.eventKind,
          row.batchSize,
          row.taskKind,
          row.taskKey,
          row.taskStatus,
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
          `INSERT OR IGNORE INTO model_call (id, agent_key, purpose, model, status, estimate_micro, cost_micro,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.agent,
          row.purpose,
          row.model,
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
          `INSERT OR IGNORE INTO unasked_message (id, agent_key, trigger_kind, text, status, day, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(row.id, row.agent, row.triggerKind, row.text, row.status, row.day, row.at);
    case "lifecycle":
      return db
        .prepare("INSERT OR IGNORE INTO lifecycle (id, agent_key, change, source, at) VALUES (?, ?, ?, ?, ?)")
        .bind(row.id, row.agent, row.change, row.source, row.at);
    default:
      return assertNever(row);
  }
}

export function d1Ledger(db: D1Database, ceiling: MicroUsd): Ledger {
  return {
    async append(rows) {
      for (let i = 0; i < rows.length; i += APPEND_CHUNK) {
        await db.batch(rows.slice(i, i + APPEND_CHUNK).map((row) => insertFor(db, row)));
      }
    },
    async requestLease(req) {
      // One conditional INSERT: D1 has a single writer, so the ceiling check and the grant are atomic.
      const [, granted] = await db.batch<{ micro: number }>([
        db
          .prepare(
            `INSERT INTO spend_lease (agent_key, month, seq, micro, granted_at)
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE (SELECT COALESCE(SUM(micro), 0) FROM spend_lease WHERE month = ?2) + ?4 <= ?6
             ON CONFLICT (agent_key, month, seq) DO NOTHING`,
          )
          .bind(req.agent, req.month, req.seq, req.micro, req.at, ceiling),
        db.prepare("SELECT micro FROM spend_lease WHERE agent_key = ?1 AND month = ?2 AND seq = ?3").bind(req.agent, req.month, req.seq),
      ]);
      const row = granted?.results[0];
      return row ? { kind: "granted", micro: row.micro as MicroUsd } : { kind: "ceiling" };
    },
  };
}
