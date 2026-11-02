/**
 * Core vocabulary shared by the agent, policy, channels and ledger.
 * No I/O, no SDK types, no channel wire types. Everything here is a parsed domain value.
 */

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

// ---------------------------------------------------------------------------------------------
// Units

/** Milliseconds since the Unix epoch, UTC. The only time representation that is stored or compared. */
export type EpochMs = Brand<number, "EpochMs">;
/** Integer micro-dollars (1 USD = 1_000_000). All spend math is integer; a float never touches a budget. */
export type MicroUsd = Brand<number, "MicroUsd">;
/** An IANA zone name that `Intl` accepted. Constructed only by `policy/time.parseTimeZone`. */
export type TimeZone = Brand<string, "TimeZone">;
/** "YYYY-MM-DDTHH:mm" wall time in the person's zone. The only time shape the model reads or writes. */
export type LocalDateTime = Brand<string, "LocalDateTime">;
/** "YYYY-MM-DD" in the person's zone. Keys the daily unasked budget and the daily check-in. */
export type LocalDate = Brand<string, "LocalDate">;
/** "YYYY-MM" in UTC. Keys the per-user cap and the global ceiling, so both use one calendar. */
export type MonthKey = Brand<string, "MonthKey">;

// ---------------------------------------------------------------------------------------------
// Identity

/** Single list of channels. `ChannelRegistry` is a mapped type over it, so a missing adapter fails the build. */
export const CHANNEL_IDS = ["line", "telegram", "dev"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

/** Who the agent talks to on a channel. Week 1: always a person in a 1:1 chat. */
export type Identity = { readonly channel: ChannelId; readonly channelUserId: string };

/**
 * Names one Durable Object. Encoded as `p:<channel>:<channelUserId>`.
 * Week 3 adds group agents as `g:<channel>:<groupId>` with their own budget; the scope prefix is the slot.
 */
export type AgentKey = Brand<string, "AgentKey">;

export function personAgentKey(identity: Identity): AgentKey {
  // TODO: reject ':' in channelUserId (LINE "U…" ids and Telegram numeric ids never contain one).
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------------------------
// Ids

/**
 * Dedupe key for an inbox row; UNIQUE in the inbox table. Channel-provided ids for inbound events,
 * derived ids for internal ones. The constructors below are the only way to make one.
 */
export type EventKey = Brand<string, "EventKey">;
export const eventKey = {
  /** LINE `webhookEventId`. Stable across redeliveries. */
  line: (webhookEventId: string): EventKey => `line:${webhookEventId}` as EventKey,
  /** Telegram `update_id`. Stable across webhook retries. */
  telegram: (updateId: number): EventKey => `tg:${updateId}` as EventKey,
  /** Client-generated id from the dev chat page, so a double-click is one event. */
  dev: (clientId: string): EventKey => `dev:${clientId}` as EventKey,
  /** One firing per wake-up row. An alarm that runs twice inserts the same key twice. */
  wakeup: (id: WakeupId): EventKey => `wake:${id}` as EventKey,
  /** At most one check-in per local day, even if two check-in rows somehow existed. */
  checkin: (day: LocalDate): EventKey => `checkin:${day}` as EventKey,
  // Week 2: job: (jobId: JobId, version: number) => `job:${jobId}:${version}`
} as const;

/** SQLite rowid of a wake-up. One per scheduled instance; never reused. */
export type WakeupId = Brand<number, "WakeupId">;
/**
 * Model-chosen slug, `^[a-z0-9][a-z0-9-]{0,39}$`. Unique among *pending* wake-ups (partial unique index).
 * Scheduling a key that is already pending is the "duplicate is dropped" rule.
 * `daily-checkin` is reserved for code.
 */
export type WakeupKey = Brand<string, "WakeupKey">;
export const CHECKIN_KEY = "daily-checkin" as WakeupKey;

/** UUID v4. Also the LINE `X-Line-Retry-Key`, so a retried push is deduplicated by LINE. */
export type OutboxId = Brand<string, "OutboxId">;

// ---------------------------------------------------------------------------------------------
// Events

/**
 * Proof that a free reply is possible. Minted by the adapter that received the event and consumed
 * only by the same adapter; the core stores and forwards it without reading `token`.
 */
export type ReplyHandle = { readonly token: string; readonly expiresAt: EpochMs };

/** What a channel can tell the agent. Verified and parsed by the adapter. */
export type ChannelEvent =
  | { readonly kind: "message"; readonly text: string; readonly reply?: ReplyHandle }
  /** LINE follow/unfollow, Telegram /start and my_chat_member member/kicked. LINE unfollow *is* a block. */
  | { readonly kind: "lifecycle"; readonly change: "follow" | "block"; readonly reply?: ReplyHandle };

/** What the adapter hands the core: authenticated, keyed, person-scoped. */
export type InboundEnvelope = {
  readonly agent: AgentKey;
  readonly identity: Identity;
  readonly key: EventKey;
  readonly receivedAt: EpochMs;
  readonly event: ChannelEvent;
};

/**
 * Everything an agent turn can be about. Stored as JSON in `inbox.payload` and parsed by `codec.ts`.
 * Adding a kind is additive: the inbox has no CHECK on kind, and `intentOf` / the turn planner are
 * exhaustive switches, so the compiler lists every place a new kind must be handled.
 */
export type AgentEvent =
  | ChannelEvent
  | {
      readonly kind: "wakeup";
      readonly wakeupId: WakeupId;
      readonly key: WakeupKey;
      readonly note: string;
      readonly dueAt: EpochMs;
      readonly firedAt: EpochMs;
    }
  | { readonly kind: "checkin"; readonly day: LocalDate; readonly dueAt: EpochMs; readonly firedAt: EpochMs };
// Week 2:
//  | { kind: "job_result"; jobId: JobId; version: number; result: JobResult }
//    JobResult is a typed union from a fixed list (status, confirmation code by pattern, fields asked),
//    never free text from a worker. The planner records results whose version != job.version and
//    never acts on them.

export type AgentEventKind = AgentEvent["kind"];

/** Lateness is derived from the event, never stored. */
export const lateBy = (e: Extract<AgentEvent, { firedAt: EpochMs }>): number => e.firedAt - e.dueAt;

// ---------------------------------------------------------------------------------------------
// Outbound

/**
 * Whether a send answers the person. Derived by code from the triggering event; the model never
 * chooses it, so the model cannot route around the unasked budget or quiet hours.
 */
export type Intent = "reply" | "unasked";

export function intentOf(e: AgentEvent): Intent {
  // TODO: switch (e.kind) {
  //   case "message": return "reply";
  //   case "lifecycle": return "reply";     // follow welcome; a block never sends
  //   case "wakeup": case "checkin": return "unasked";
  //   default: return assertNever(e);       // week 2 job_result → "unasked"
  // }
  throw new Error("not implemented");
}

/**
 * One delivery: everything a single turn says, in order. One row because a LINE reply token is
 * single-use and carries up to 5 messages, so a turn's texts must go out in one call.
 */
export type OutboundMessage = {
  readonly id: OutboxId;
  readonly to: Identity;
  readonly texts: readonly [string, ...string[]];
  readonly intent: Intent;
  readonly reply?: ReplyHandle;
  /** A previous attempt may have reached the channel. Adapters must not use a non-idempotent path. */
  readonly inDoubt: boolean;
};

// ---------------------------------------------------------------------------------------------
// Tasks (instrumentation)

/**
 * The model labels each turn with the task it served. The gates count `completed` per person per week.
 * The `key` groups turns of one task (a reminder set, then fired). Week 2 replaces `key` with a real JobId
 * for background jobs.
 */
export const TASK_KINDS = ["chat", "reminder", "plan", "booking", "site", "group", "other"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskStatus = "none" | "started" | "progressed" | "completed" | "failed";
export type TaskLabel = { readonly kind: TaskKind; readonly key: string; readonly status: TaskStatus };

export type PersonStatus = "active" | "blocked";

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
