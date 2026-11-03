import {
  assertNever,
  type AgentEventKind,
  type AgentKey,
  type ChannelId,
  type EpochMs,
  type LocalDate,
  type MicroUsd,
  type TaskKind,
  type TaskStatus,
  type UtcMonth,
} from "../domain";
import type { ModelId, Purpose, Usage } from "../model/model";
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
      readonly id: string;
      readonly agent: AgentKey;
      readonly purpose: Purpose;
      readonly model: ModelId;
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
] as const;
export type ModelCallStatus = (typeof MODEL_CALL_STATUSES)[number];

export const TURN_OUTCOMES = ["acted", "quiet", "refused_budget", "model_failed", "poison", "no_model", "stale"] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export const ACTION_REJECTIONS = [...REMINDER_REJECTIONS, "not_pending", "too_many_sends", "too_many_actions", "too_long"] as const;
export type ActionRejection = (typeof ACTION_REJECTIONS)[number];

export const UNASKED_STATUSES = ["sent", "dropped_budget", "dropped_blocked", "failed"] as const;
export type UnaskedStatus = (typeof UNASKED_STATUSES)[number];

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
  readonly month: UtcMonth;
  readonly seq: number;
  readonly micro: MicroUsd;
  readonly at: EpochMs;
};

export type LeaseAnswer = { readonly kind: "granted"; readonly micro: MicroUsd } | { readonly kind: "ceiling" };

export interface Ledger {
  append(rows: readonly LogRow[]): Promise<void>;
  requestLease(req: LeaseRequest): Promise<LeaseAnswer>;
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
          `INSERT INTO turn_log (id, agent_key, event_kind, batch_size, task_kind, task_key, task_status,
             outcome, refused_for_budget, cost_micro, attempts, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
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
          `INSERT INTO model_call (id, agent_key, purpose, model, status, estimate_micro, cost_micro,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
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
          `INSERT INTO unasked_message (id, agent_key, trigger_kind, text, status, day, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(row.id, row.agent, row.triggerKind, row.text, row.status, row.day, row.at);
    case "lifecycle":
      return db
        .prepare("INSERT INTO lifecycle (id, agent_key, change, source, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
        .bind(row.id, row.agent, row.change, row.source, row.at);
    case "rejection":
      return db
        .prepare("INSERT INTO action_rejection (id, agent_key, turn_id, action, reason, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
        .bind(row.id, row.agent, row.turnId, row.action, row.reason, row.at);
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
