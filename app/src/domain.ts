declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type EpochMs = Brand<number, "EpochMs">;
export type MicroUsd = Brand<number, "MicroUsd">;
export type TimeZone = Brand<string, "TimeZone">;
export type LocalDateTime = Brand<string, "LocalDateTime">;
export type LocalDate = Brand<string, "LocalDate">;
export type UtcMonth = Brand<string, "UtcMonth">;
export type TimeOfDay = `${number}:${number}`;

export const CHANNEL_IDS = ["line", "telegram", "dev"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

export type Identity = { readonly channel: ChannelId; readonly channelUserId: string };

export type AgentKey = Brand<string, "AgentKey">;

export function personAgentKey(identity: Identity): AgentKey {
  if (identity.channelUserId.length === 0 || identity.channelUserId.includes(":")) {
    throw new Error(`invalid channel user id: ${JSON.stringify(identity.channelUserId)}`);
  }
  return `p:${identity.channel}:${identity.channelUserId}` as AgentKey;
}

export type EventKey = Brand<string, "EventKey">;
export const eventKey = {
  /** LINE `webhookEventId`. Stable across redeliveries. */
  line: (webhookEventId: string): EventKey => `line:${webhookEventId}` as EventKey,
  /** Telegram `update_id`. Stable across webhook retries. */
  telegram: (updateId: number): EventKey => `tg:${updateId}` as EventKey,
  dev: (clientId: string): EventKey => `dev:${clientId}` as EventKey,
  wakeup: (id: WakeupId): EventKey => `wake:${id}` as EventKey,
  checkin: (day: LocalDate): EventKey => `checkin:${day}` as EventKey,
} as const;

export type WakeupId = Brand<number, "WakeupId">;
export type WakeupKey = Brand<string, "WakeupKey">;
export const WAKEUP_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const CHECKIN_KEY = "daily-checkin" as WakeupKey;

export function parseWakeupKey(raw: string): WakeupKey | null {
  return WAKEUP_KEY_PATTERN.test(raw) ? (raw as WakeupKey) : null;
}

export type WakeupOrigin = "person" | "agent" | "system";

export type OutboxId = Brand<string, "OutboxId">;

export type ReplyHandle = { readonly token: string; readonly expiresAt: EpochMs };

export type ChannelEvent =
  | { readonly kind: "message"; readonly text: string; readonly reply?: ReplyHandle }
  | {
      readonly kind: "lifecycle";
      readonly change: "follow" | "block";
      readonly at: EpochMs;
      readonly reply?: ReplyHandle;
    };

export type InboundEnvelope = {
  readonly agent: AgentKey;
  readonly identity: Identity;
  readonly key: EventKey;
  readonly receivedAt: EpochMs;
  readonly event: ChannelEvent;
};

export type AgentEvent =
  | ChannelEvent
  | {
      readonly kind: "wakeup";
      readonly wakeupId: WakeupId;
      readonly key: WakeupKey;
      readonly origin: Exclude<WakeupOrigin, "system">;
      readonly note: string;
      readonly dueAt: EpochMs;
      readonly firedAt: EpochMs;
    }
  | { readonly kind: "checkin"; readonly day: LocalDate; readonly dueAt: EpochMs; readonly firedAt: EpochMs };

export type AgentEventKind = AgentEvent["kind"];

export type Intent = "reply" | "requested" | "unasked";

export function intentOf(e: AgentEvent): Intent {
  switch (e.kind) {
    case "message":
      return "reply";
    case "lifecycle":
      return "reply";
    case "wakeup":
      return e.origin === "person" ? "requested" : "unasked";
    case "checkin":
      return "unasked";
    default:
      return assertNever(e);
  }
}

/**
 * One row because a LINE reply token is single-use and carries up to 5 messages, so a turn's texts
 * must go out in one call.
 */
export type OutboundMessage = {
  readonly id: OutboxId;
  readonly to: Identity;
  readonly texts: readonly [string, ...string[]];
  readonly intent: Intent;
  readonly reply?: ReplyHandle;
};

export const TASK_KINDS = ["chat", "reminder", "plan", "booking", "site", "group", "other"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_STATUSES = ["none", "started", "progressed", "completed", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskLabel = { readonly kind: TaskKind; readonly key: string; readonly status: TaskStatus };

export type PersonStatus = "active" | "blocked";

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
