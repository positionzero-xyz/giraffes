declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type EpochMs = Brand<number, "EpochMs">;
/** Counts the person's forgets. Work started under an older epoch may not send, save or call out under a newer one. */
export type ForgetEpoch = Brand<number, "ForgetEpoch">;
export type MicroUsd = Brand<number, "MicroUsd">;
export type TimeZone = Brand<string, "TimeZone">;
export type LocalDateTime = Brand<string, "LocalDateTime">;
export type LocalDate = Brand<string, "LocalDate">;

export const REPEATS = ["daily", "weekdays", "weekly"] as const;
/** A routine: `anchor` is its first local time, which fixes the time of day and, for weekly, the weekday. */
export type Repeat = { readonly every: (typeof REPEATS)[number]; readonly anchor: LocalDateTime };
export type UtcMonth = Brand<string, "UtcMonth">;
export type TimeOfDay = `${number}:${number}`;

export const CHANNEL_IDS = ["line", "telegram", "dev"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

export const LANGUAGES = ["th", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

/** The language a person's code-written notices start in, until they ask for another. */
export const CHANNEL_LANGUAGE: { readonly [K in ChannelId]: Language } = { line: "th", telegram: "en", dev: "en" };

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
  box: (name: string): EventKey => `box:${name}` as EventKey,
  billing: (what: string): EventKey => `billing:${what}` as EventKey,
  /** A message about the person's model access: a key connected, refused or removed. */
  access: (what: string): EventKey => `access:${what}` as EventKey,
  prune: (at: EpochMs): EventKey => `prune:${at}` as EventKey,
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

export type ProviderMessageReference = { readonly id: string; readonly position: number };

/** A message the person pointed at. A reference is resolved to text before the model sees it; an unresolved one is not shown. */
export type MessageQuote =
  | { readonly kind: "reference"; readonly id: string }
  | { readonly kind: "text"; readonly text: string };

export type ChannelEvent =
  /** `redacted`: code removed what looked like an API key before the message was stored. */
  | {
      readonly kind: "message";
      readonly text: string;
      readonly reply?: ReplyHandle;
      readonly redacted?: true;
      readonly edited?: true;
      readonly quote?: MessageQuote;
    }
  | {
      readonly kind: "lifecycle";
      readonly change: "follow" | "block";
      readonly at: EpochMs;
      readonly reply?: ReplyHandle;
      /** The invite code a follow arrived with, such as Telegram's `/start CODE`. */
      readonly code?: InviteCode;
    }
  /** `epoch`: the forget epoch the button was sent in; absent on a button from before buttons carried one, which is epoch 0. */
  | { readonly kind: "choice"; readonly choice: Choice; readonly at: EpochMs; readonly reply?: ReplyHandle; readonly epoch?: ForgetEpoch };

export type InboundEnvelope = {
  readonly agent: AgentKey;
  readonly identity: Identity;
  readonly key: EventKey;
  readonly receivedAt: EpochMs;
  readonly event: ChannelEvent;
  readonly initialLanguage?: Language;
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
      /** The task this wake-up was scheduled to follow up, checked when it was scheduled. */
      readonly task: TaskId | null;
      /** True only for a check code scheduled itself, never the model. */
      readonly bookkeeping: boolean;
      readonly repeat: Repeat | null;
    }
  | { readonly kind: "checkin"; readonly day: LocalDate; readonly dueAt: EpochMs; readonly firedAt: EpochMs };

export type AgentEventKind = AgentEvent["kind"];

export type Intent = "reply" | "requested" | "unasked";

export function intentOf(e: AgentEvent): Intent {
  switch (e.kind) {
    case "message":
      return "reply";
    case "lifecycle":
    case "choice":
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
  /** One button under the last text, labelled in the person's language. */
  readonly button?: { readonly label: string; readonly data: string };
  /** Never pushed: sent only on the reply token. Set for anyone not admitted, so strangers cost no billed sends. */
  readonly replyOnly?: boolean;
};

export type TaskId = Brand<number, "TaskId">;
/** The model's name for a task, reused across turns; the same slug grammar as wake-up keys. */
export type TaskRef = Brand<string, "TaskRef">;
export const parseTaskRef = (raw: string): TaskRef | null => (WAKEUP_KEY_PATTERN.test(raw) ? (raw as TaskRef) : null);

/** Descriptive only: no gate decides anything by kind. Chat and reminders are not tasks. */
export const TASK_KINDS = ["plan", "booking", "site", "group", "other"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_STATUSES = ["open", "completed", "closed", "expired"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

type FactRule = { readonly completes: boolean; readonly decision: boolean };
/**
 * Everything code knows happened to a task, and the one list of what completes a task or counts as the
 * person's own decision. A new kind of evidence is a new entry here; no table or view keeps a copy.
 */
export const FACTS = {
  opened: { completes: false, decision: false },
  proposed: { completes: false, decision: false },
  plan_accepted: { completes: true, decision: true },
  closed: { completes: false, decision: false },
  expired: { completes: false, decision: false },
} as const satisfies Record<string, FactRule>;
export type FactKind = keyof typeof FACTS;

/** The event that caused a fact, or the drain's prune for a task code expired. */
export type FactCause = { readonly key: EventKey; readonly kind: AgentEventKind | "prune"; readonly at: EpochMs };
export type TaskFact = {
  readonly kind: FactKind;
  /** A proposal id, job id or outbox id; "" when the fact has none, so UNIQUE(task_id, kind, ref) dedupes. */
  readonly ref: string;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
  readonly cause: FactCause;
};
const isPersonEvent = (k: FactCause["kind"]): boolean => k === "message" || k === "choice";
export const personDecision = (f: TaskFact): boolean => FACTS[f.kind].decision && isPersonEvent(f.cause.kind);

/** `<task id>.<version>`, such as "7.1". */
export type ProposalId = Brand<string, "ProposalId">;
export const proposalId = (task: TaskId, version: number): ProposalId => `${task}.${version}` as ProposalId;

/**
 * `backup`: yes to the person's own key backing up their Claude plan. It names the key revision it was asked about;
 * null is a button from before buttons carried one.
 */
export type Choice =
  | { readonly kind: "accept"; readonly proposal: ProposalId }
  | { readonly kind: "consent" }
  | { readonly kind: "backup"; readonly revision: number | null }
  | { readonly kind: "erase" | "start"; readonly challenge: string };

/** "a:7.1", "c" or "b:3": short enough for Telegram's 64-byte callback_data and a LINE postback. */
export function choiceToken(c: Choice): string {
  switch (c.kind) {
    case "accept":
      return `a:${c.proposal}`;
    case "consent":
      return "c";
    case "backup":
      return c.revision === null ? "b" : `b:${c.revision}`;
    case "erase":
    case "start":
      return `${c.kind}:${c.challenge}`;
  }
}

export function parseChoice(token: string): Choice | null {
  const account = /^(erase|start):([a-f0-9]{32})$/.exec(token);
  if (account) return { kind: account[1] === "erase" ? "erase" : "start", challenge: account[2] };
  if (token === "c") return { kind: "consent" };
  if (token === "b") return { kind: "backup", revision: null };
  const backup = /^b:(\d{1,9})$/.exec(token);
  if (backup) return { kind: "backup", revision: Number(backup[1]) };
  const m = /^a:([1-9]\d{0,9}\.[1-9]\d{0,5})$/.exec(token);
  return m ? { kind: "accept", proposal: m[1] as ProposalId } : null;
}

/** A button's data: its choice token, and after a forget the epoch it was sent in, so a tap on an older button can be refused. */
export const buttonData = (token: string, epoch: ForgetEpoch): string => (epoch === 0 ? token : `${token}@${epoch}`);

export function parseButton(data: string): { readonly choice: Choice; readonly epoch: ForgetEpoch } | null {
  const m = /^([^@]+)(?:@([1-9]\d{0,15}))?$/.exec(data);
  const choice = m ? parseChoice(m[1]) : null;
  const epoch = Number(m?.[2] ?? 0);
  return m && choice && Number.isSafeInteger(epoch) ? { choice, epoch: epoch as ForgetEpoch } : null;
}

export type InviteCode = Brand<string, "InviteCode">;
export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_CODE = new RegExp(`^[${INVITE_ALPHABET}]{6,8}$`);

export function newInviteCode(): InviteCode {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("") as InviteCode;
}

export function parseInviteCode(raw: string): InviteCode | null {
  const code = raw.trim().toUpperCase();
  return INVITE_CODE.test(code) ? (code as InviteCode) : null;
}

export const COHORTS = ["recruit", "joiner", "staff"] as const;
export type Cohort = (typeof COHORTS)[number];
/** Set by recruiting, through the code, never by the channel a person writes on. */
export const HALVES = ["th_line", "intl_telegram"] as const;
export type Half = (typeof HALVES)[number];

export type Seat = { readonly cohort: Cohort; readonly half: Half | null; readonly code: InviteCode | null; readonly inviter: AgentKey | null };

export const WAITLIST_REASONS = ["no_code", "bad_code", "used", "full"] as const;
export type WaitlistReason = (typeof WAITLIST_REASONS)[number];

export type Admission =
  | { readonly state: "stranger" }
  | { readonly state: "waitlisted"; readonly reason: WaitlistReason; readonly toldOn: LocalDate | null }
  | { readonly state: "consenting"; readonly code: InviteCode; readonly at: EpochMs }
  | { readonly state: "admitted"; readonly seat: Seat; readonly at: EpochMs }
  | { readonly state: "removed"; readonly at: EpochMs };

export const mayspend = (a: Admission): a is Extract<Admission, { state: "admitted" }> => a.state === "admitted";

export type PersonStatus = "active" | "blocked";

export function clip(text: string, max: number): string {
  const cut = text.slice(0, max - 1);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

const utf8 = new TextEncoder();

/** Cuts `text` to at most `maxBytes` of UTF-8, ending in "…", on a character boundary. */
export function clipBytes(text: string, maxBytes: number): string {
  if (utf8.encode(text).length <= maxBytes) return text;
  let used = utf8.encode("…").length;
  let out = "";
  for (const ch of text) {
    const n = utf8.encode(ch).length;
    if (used + n > maxBytes) break;
    used += n;
    out += ch;
  }
  return `${out}…`;
}

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
