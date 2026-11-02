/**
 * The agent turn as pure functions: what the model sees, what it may return, and how its output becomes
 * one atomic `TurnCommit`. No I/O. The Agent loads a `TurnView`, makes one model call, and hands the
 * output to `planTurn`; whatever comes back is applied in a single SQLite transaction or not at all.
 *
 * `TurnOutputSchema` is the model's contract. The Agent passes it to the model client and hands the
 * parsed value straight back to `planTurn`; no other module reads model output.
 */
import { z } from "zod";
import {
  TASK_KINDS,
  intentOf,
  type AgentEvent,
  type AgentKey,
  type EpochMs,
  type MicroUsd,
  type EventKey,
  type Intent,
  type PersonStatus,
  type ReplyHandle,
  type TaskLabel,
  type TimeZone,
  type WakeupKey,
} from "../domain";
import type { LogRow, TurnOutcome } from "../ledger/ledger";
import type { ModelId, Usage } from "../model/model";
import { admitReminder, isLate, type NewWakeup, type PendingWakeup } from "../policy/schedule";

export const TURN = {
  recentTurns: 30,
  maxBatchMessages: 10,
  maxSendsPerTurn: 3,
  maxTextChars: 2000,
  maxNoteChars: 500,
  maxActions: 8,
  /** Claim attempts before an event is declared poison (crashes, not model failures). */
  maxAttempts: 3,
} as const;

// ---------------------------------------------------------------------------------------------
// Model output schema (structured output via zodOutputFormat)

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send"), text: z.string().min(1).max(TURN.maxTextChars) }),
  z.object({
    type: z.literal("schedule_wakeup"),
    key: Slug,
    at: z.string().describe("Local wall time, YYYY-MM-DDTHH:mm"),
    note: z.string().min(1).max(TURN.maxNoteChars).describe("What your future self should do"),
  }),
  z.object({ type: z.literal("cancel_wakeup"), key: Slug }),
  z.object({ type: z.literal("remember"), note: z.string().min(1).max(TURN.maxNoteChars) }),
  z.object({ type: z.literal("quiet") }),
]);

export const TurnOutputSchema = z.object({
  actions: z.array(ActionSchema).max(TURN.maxActions),
  lateNotice: z.string().max(300).optional(),
  task: z.object({
    kind: z.enum(TASK_KINDS),
    key: Slug,
    status: z.enum(["none", "started", "progressed", "completed", "failed"]),
  }),
});
export type TurnOutput = z.infer<typeof TurnOutputSchema>;

// ---------------------------------------------------------------------------------------------
// Inputs

export type InboxItem = { readonly key: EventKey; readonly event: AgentEvent; readonly attempts: number };

/**
 * What one turn is about. Invariant (enforced by the store's `claimBatch`): either exactly one
 * non-message event, or 1..maxBatchMessages consecutive message events.
 */
export type Batch = { readonly items: readonly [InboxItem, ...InboxItem[]] };

export type TurnRow = { readonly role: "person" | "agent" | "note"; readonly text: string; readonly at: EpochMs };

/** Everything a turn reads. Loaded by the Agent in one synchronous read, so it is a consistent snapshot. */
export type TurnView = {
  readonly now: EpochMs;
  readonly tz: TimeZone;
  readonly status: PersonStatus;
  readonly summary: string;
  readonly notes: readonly string[];
  /** The last TURN.recentTurns rows, oldest first. Bounded even if compaction lags. */
  readonly recent: readonly TurnRow[];
  /** Includes the check-in, so the model can see when it will next wake. */
  readonly pending: readonly PendingWakeup[];
  readonly batch: Batch;
  readonly unaskedLeftToday: number;
};

/** The user message. Deterministic given the view; system prompt is the constant in prompt.ts. */
export function renderUser(view: TurnView): string {
  // TODO: sections, in this order (stable order helps the model, not the cache):
  //   ## Now            local time + weekday + zone
  //   ## Memory         summary, then notes as bullets
  //   ## Pending wake-ups   key · local time · note   (and "daily check-in at HH:mm")
  //   ## Unasked messages left today: N
  //   ## Conversation   recent turns, "Person:" / "You:" / "(note)" prefixes, local timestamps
  //   ## New            each batch event rendered by kind:
  //       message   → Person: <text>
  //       wakeup    → Your wake-up "<key>" fired: <note>. Due <local>. [LATE by Xh Ym: due <local>.]
  //       checkin   → Daily check-in. [LATE …]
  //       lifecycle follow → The person just added you (or came back). Greet briefly; say what you can do.
  throw new Error("not implemented");
}

// ---------------------------------------------------------------------------------------------
// Output

export type NewTurn = TurnRow & { readonly eventKey: EventKey };

export type Outbound = {
  readonly texts: readonly [string, ...string[]];
  readonly intent: Intent;
  readonly reply?: ReplyHandle;
};

/**
 * Everything one turn changes. Applied by `AgentStore.commitTurn` in one transaction together with
 * marking the batch done, settling the spend reservation, and writing the turn's log rows.
 */
export type TurnCommit = {
  readonly batchKeys: readonly [EventKey, ...EventKey[]];
  readonly outcome: TurnOutcome;
  readonly turns: readonly NewTurn[];
  readonly outbound: Outbound | null;
  /** Applied before `wakeupsAdd`, so cancel-then-schedule of one key reschedules. */
  readonly wakeupsCancel: readonly WakeupKey[];
  readonly wakeupsAdd: readonly NewWakeup[];
  readonly notes: readonly string[];
  readonly task: TaskLabel | null;
  readonly status: PersonStatus | null;
  /** Insert the daily check-in if none is pending (follow). */
  readonly ensureCheckin: boolean;
  /** Actions code refused, for the turn log. The person sees a notice for the ones that matter. */
  readonly rejected: readonly { readonly action: string; readonly reason: string }[];
};

/**
 * Validate and convert model output. Never throws on model content; every bad action becomes a
 * rejection. Rules, applied in action order with a running copy of `pending`:
 *   send            → collected; at most maxSendsPerTurn, extras rejected
 *   schedule_wakeup → admitReminder(); quiet-hours due time admitted with a notice; others rejected
 *                     with a notice ("I can hold 20 reminders at most", "that time has passed")
 *   cancel_wakeup   → must name a pending reminder key; the check-in key is refused
 *   remember        → collected
 *   quiet           → only meaningful alone; ignored when mixed with other actions
 * Then:
 *   intent  = intentOf(first event)        (code decides reply vs unasked)
 *   reply   = newest message's ReplyHandle (freshest token) when intent is reply
 *   late    = any wakeup/checkin event with isLate(); if late and there are texts, prepend
 *             out.lateNotice ?? NOTICE.lateFallback(dueLocal)
 *   notices = appended as a final text (counts toward maxSendsPerTurn; a send is dropped first)
 *   turns   = person texts from message events, then agent texts as sent, then notes for notices
 *   outcome = "acted" if anything applied, else "quiet"
 *   follow  -> status "active", ensureCheckin true (the welcome text is the model's)
 */
export function planTurn(out: TurnOutput, view: TurnView): TurnCommit {
  void admitReminder; void isLate; void intentOf;
  throw new Error("not implemented");
}

/**
 * A turn that doesn't call the model, or whose model call failed. Still commits, so the batch is done
 * and the person's words are recorded.
 *   block          → status blocked, no outbound, outcome no_model
 *   refused_budget → message events: one fixed reply ("I've reached my limit for this month…") at
 *                    most once per local day (caller passes `alreadyToldToday`); proactive events: nothing
 *   model_failed   → message events: fixed "Sorry, I couldn't process that, can you say it again?";
 *                    proactive events: nothing (the wake-up is lost, and logged)
 *   poison         → like model_failed, outcome poison
 */
export function planWithoutModel(
  view: TurnView,
  why:
    | { readonly kind: "block" }
    | { readonly kind: "refused_budget"; readonly alreadyToldToday: boolean }
    | { readonly kind: "model_failed" }
    | { readonly kind: "poison" },
): TurnCommit {
  throw new Error("not implemented");
}

/**
 * The turn's log rows, written in the same transaction as the commit (log_outbox, then D1).
 *   turn       always, id `<agent>|<first batch key>`
 *   model_call when a call was made (settled / refused_*)
 *   lifecycle  for follow/block events
 * Unasked-message rows are written later, at delivery, because only delivery knows sent vs dropped.
 */
export function logsForTurn(input: {
  readonly agent: AgentKey;
  readonly commit: TurnCommit;
  readonly view: TurnView;
  readonly call:
    | { readonly kind: "settled"; readonly reservationId: string; readonly model: ModelId; readonly estimate: MicroUsd; readonly cost: MicroUsd; readonly usage: Usage | null }
    | { readonly kind: "refused"; readonly scope: "user_cap" | "global_ceiling"; readonly model: ModelId; readonly estimate: MicroUsd }
    | { readonly kind: "none" };
  readonly startedAt: EpochMs;
  readonly now: EpochMs;
}): LogRow[] {
  throw new Error("not implemented");
}

/**
 * Fixed texts code adds on its own. English-only in week 1 (see RATIONALE open questions).
 */
export const NOTICE = {
  quietDeferred: (localTime: string) =>
    `(I don't send messages between 22:00 and 08:00, so this reminder will come at ${localTime}.)`,
  reminderLimit: "(I can hold 20 reminders at most. Cancel one and ask again.)",
  reminderPast: "(That time has already passed, so I didn't set it.)",
  lateFallback: (dueLocal: string) => `Sorry, this is late. It was due at ${dueLocal}.`,
  monthlyLimit: "I've reached my usage limit for this month, so I can't help until it resets on the 1st.",
  failed: "Sorry, I couldn't process that. Could you say it again?",
} as const;
