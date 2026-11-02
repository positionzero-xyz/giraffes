/**
 * The cross-user record, in D1. Owns two kinds of fact:
 *   1. Instrumentation rows (append-only, queryable across all users; the MVP gates are views over them).
 *   2. Global-ceiling leases (the only cross-user *write* that gates behavior).
 *
 * Agents never write D1 inside an event. They write `LogRow`s to their local `log_outbox` in the same
 * SQLite transaction as the state change they describe, then `append` ships them. Every row carries a
 * deterministic id, so a re-shipped batch is `INSERT OR IGNORE` and the log is exactly-once in effect.
 */
import type {
  AgentEventKind,
  AgentKey,
  ChannelId,
  EpochMs,
  LocalDate,
  MicroUsd,
  MonthKey,
  TaskKind,
  TaskStatus,
} from "../domain";
import type { ModelId, Purpose } from "../model/model";

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
      /** The reservation id. */
      readonly id: string;
      readonly agent: AgentKey;
      readonly purpose: Purpose;
      readonly model: ModelId;
      readonly status: "settled" | "refused_user_cap" | "refused_global_ceiling" | "recovered_after_crash";
      readonly estimateMicro: MicroUsd;
      /** Actual for settled; the estimate for recovered (we can't know); 0 for refused. */
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
      /** The inbound event key. */
      readonly id: string;
      readonly agent: AgentKey;
      readonly change: "follow" | "block";
      /** "channel": the platform told us. "delivery": a send came back recipient_gone. */
      readonly source: "channel" | "delivery";
      readonly at: EpochMs;
    };

export type TurnOutcome =
  | "acted" // at least one action applied
  | "quiet" // model chose quiet
  | "refused_budget"
  | "model_failed" // invalid_output / refused_by_model / unavailable after retries
  | "poison" // gave up after MAX_ATTEMPTS crashes
  | "no_model"; // handled by code alone (a block)

export type LeaseRequest = {
  readonly agent: AgentKey;
  readonly month: MonthKey;
  /** Per-agent sequence. The agent persists `seq` before asking, so a retry after a crash reuses it. */
  readonly seq: number;
  readonly micro: MicroUsd;
};

export interface Ledger {
  /** Idempotent by row id. Throws on D1 unavailability; the caller keeps the rows and backs off. */
  append(rows: readonly LogRow[]): Promise<void>;
  /**
   * Atomically grant `micro` against the global ceiling for `month`, unless that would exceed it.
   * Idempotent by (agent, month, seq): a repeated request returns the original answer.
   */
  requestLease(req: LeaseRequest): Promise<"granted" | "ceiling">;
}

export function d1Ledger(db: D1Database, ceiling: MicroUsd): Ledger {
  return {
    async append(rows) {
      // TODO: group by stream; db.batch([...INSERT OR IGNORE INTO <table> (...) VALUES (...)]).
      //       D1 batch is one transaction. Batch size ≤ 100 rows to stay under statement limits.
      void rows;
      throw new Error("not implemented");
    },
    async requestLease(req) {
      // TODO: one statement, so D1's single writer makes check-and-grant atomic:
      //   INSERT INTO spend_lease (agent, month, seq, micro, granted_at)
      //   SELECT ?1, ?2, ?3, ?4, ?5
      //   WHERE (SELECT COALESCE(SUM(micro), 0) FROM spend_lease WHERE month = ?2) + ?4 <= ?6
      //   ON CONFLICT (agent, month, seq) DO NOTHING;
      //   then SELECT 1 FROM spend_lease WHERE agent=?1 AND month=?2 AND seq=?3
      //   → row exists: "granted" (first time or a replay); else "ceiling".
      void req; void ceiling;
      throw new Error("not implemented");
    },
  };
}
