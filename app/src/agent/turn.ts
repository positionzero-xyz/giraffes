import { z } from "zod";
import {
  CHECKIN_KEY,
  TASK_KINDS,
  TASK_STATUSES,
  WAKEUP_KEY_PATTERN,
  assertNever,
  intentOf,
  parseWakeupKey,
  type AgentEvent,
  type AgentEventKind,
  type AgentKey,
  type EpochMs,
  type EventKey,
  type Intent,
  type MicroUsd,
  type PersonStatus,
  type ReplyHandle,
  type TaskLabel,
  type TimeOfDay,
  type TimeZone,
  type WakeupKey,
} from "../domain";
import { modelCallRow, type LogRow, type TurnOutcome } from "../ledger/ledger";
import type { ModelId, Usage } from "../model/model";
import {
  admitReminder,
  checkinWakeup,
  isLate,
  wakeupOrigin,
  type NewReminder,
  type NewWakeup,
  type PendingWakeup,
  type ReminderRejection,
} from "../policy/schedule";
import { toLocal, weekday } from "../policy/time";

export const TURN = {
  recentTurns: 30,
  maxBatchMessages: 10,
  maxSendsPerTurn: 3,
  maxTextChars: 2000,
  maxNoteChars: 500,
  maxActions: 8,
  maxAttempts: 3,
} as const;

const Slug = z.string().regex(WAKEUP_KEY_PATTERN);

const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send"), text: z.string().min(1).max(TURN.maxTextChars) }),
  z.object({
    type: z.literal("schedule_wakeup"),
    key: Slug,
    at: z.string().describe("Local wall time, YYYY-MM-DDTHH:mm"),
    note: z.string().min(1).max(TURN.maxNoteChars).describe("What your future self should do"),
    asked: z.boolean().describe("True only when the person explicitly asked you to remind them"),
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
    status: z.enum(TASK_STATUSES),
  }),
});
export type TurnOutput = z.infer<typeof TurnOutputSchema>;

export type InboxItem = {
  readonly key: EventKey;
  readonly event: AgentEvent;
  readonly attempts: number;
  readonly receivedAt: EpochMs;
};

export type Batch = { readonly items: readonly [InboxItem, ...InboxItem[]] };

export type TurnRow = { readonly role: "person" | "agent" | "note"; readonly text: string; readonly at: EpochMs };

export type TurnView = {
  readonly now: EpochMs;
  readonly tz: TimeZone;
  readonly status: PersonStatus;
  readonly statusAt: EpochMs;
  readonly checkinLocal: TimeOfDay;
  readonly summary: string;
  readonly notes: readonly string[];
  readonly recent: readonly TurnRow[];
  readonly pending: readonly PendingWakeup[];
  readonly batch: Batch;
  readonly unaskedLeftToday: number;
};

const human = (t: EpochMs, tz: TimeZone) => toLocal(t, tz).replace("T", " ");

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function lateLine(e: { readonly dueAt: EpochMs; readonly firedAt: EpochMs }, tz: TimeZone): string {
  if (!isLate(e)) return "";
  return `\nLATE by ${duration(e.firedAt - e.dueAt)}: it was due ${human(e.dueAt, tz)}. Put one short line saying so in lateNotice.`;
}

function renderEvent(e: AgentEvent, tz: TimeZone): string {
  switch (e.kind) {
    case "message":
      return `Person: ${e.text}`;
    case "lifecycle":
      return e.change === "follow"
        ? "The person just added you (or came back). Greet briefly; say what you can do."
        : "The person blocked you.";
    case "wakeup": {
      const asked = e.origin === "person" ? " The person asked for this reminder." : "";
      return `Your wake-up "${e.key}" fired: ${e.note}. Due ${human(e.dueAt, tz)}.${asked}${lateLine(e, tz)}`;
    }
    case "checkin":
      return `Daily check-in.${lateLine(e, tz)}`;
    default:
      return assertNever(e);
  }
}

function renderPending(w: PendingWakeup, tz: TimeZone): string {
  switch (w.kind) {
    case "reminder": {
      const asked = w.origin === "person" ? " (asked for by the person)" : "";
      return `- ${w.key} · ${human(w.dueAt, tz)} · ${w.note}${asked}`;
    }
    case "checkin":
      return `- daily check-in at ${human(w.dueAt, tz)}`;
    default:
      return assertNever(w);
  }
}

const SPEAKER: Readonly<Record<TurnRow["role"], string>> = { person: "Person:", agent: "You:", note: "(note)" };

export function renderUser(view: TurnView): string {
  const memory = [view.summary || "(nothing yet)", ...view.notes.map((n) => `- ${n}`)].join("\n");
  const pending = view.pending.length ? view.pending.map((w) => renderPending(w, view.tz)).join("\n") : "(none)";
  const conversation = view.recent.length
    ? view.recent.map((r) => `[${human(r.at, view.tz)}] ${SPEAKER[r.role]} ${r.text}`).join("\n")
    : "(no earlier messages)";
  return [
    `## Now\n${human(view.now, view.tz)} (${weekday(view.now, view.tz)}), ${view.tz}`,
    `## Memory\n${memory}`,
    `## Pending wake-ups\n${pending}`,
    `## Unasked messages left today: ${view.unaskedLeftToday}`,
    `## Conversation\n${conversation}`,
    `## New\n${view.batch.items.map((i) => renderEvent(i.event, view.tz)).join("\n")}`,
  ].join("\n\n");
}

export type NewTurn = TurnRow & { readonly eventKey: EventKey };

export type Outbound = {
  readonly texts: readonly [string, ...string[]];
  readonly intent: Intent;
  readonly triggerKind: AgentEventKind;
  readonly reply?: ReplyHandle;
};

export type Reachability = { readonly status: PersonStatus; readonly at: EpochMs };

export type TurnCommit = {
  readonly batchKeys: readonly [EventKey, ...EventKey[]];
  readonly outcome: TurnOutcome;
  readonly turns: readonly NewTurn[];
  readonly outbound: Outbound | null;
  readonly wakeupsCancel: readonly WakeupKey[];
  readonly wakeupsAdd: readonly NewReminder[];
  readonly notes: readonly string[];
  readonly task: TaskLabel | null;
  readonly reachability: Reachability | null;
  readonly ensureCheckin: NewWakeup | null;
  readonly rejected: readonly { readonly action: string; readonly reason: string }[];
};

export const NOTICE = {
  reminderLimit: "(I can hold 20 reminders at most. Cancel one and ask again.)",
  reminderPast: "(That time has already passed, so I didn't set it.)",
  lateFallback: (dueLocal: string) => `Sorry, this is late. It was due at ${dueLocal}.`,
  monthlyLimit: "I've reached my usage limit for this month, so I can't help until it resets on the 1st.",
  failed: "Sorry, I couldn't process that. Could you say it again?",
} as const;

const REJECTION_NOTICE: Readonly<Record<ReminderRejection, string | null>> = {
  limit: NOTICE.reminderLimit,
  past: NOTICE.reminderPast,
  duplicate: null,
  too_far: null,
  bad_time: null,
  bad_key: null,
  reserved_key: null,
};

function nonEmpty<T>(xs: readonly T[]): readonly [T, ...T[]] | null {
  const [first, ...rest] = xs;
  return first === undefined ? null : [first, ...rest];
}

const trigger = (view: TurnView): AgentEvent => view.batch.items[0].event;

function batchKeys(view: TurnView): readonly [EventKey, ...EventKey[]] {
  const [first, ...rest] = view.batch.items;
  return [first.key, ...rest.map((i) => i.key)];
}

const NO_COST = 0 as MicroUsd;

function newestReply(view: TurnView): ReplyHandle | undefined {
  let reply: ReplyHandle | undefined;
  for (const item of view.batch.items) {
    if ((item.event.kind === "message" || item.event.kind === "lifecycle") && item.event.reply) reply = item.event.reply;
  }
  return reply;
}

function outbound(texts: readonly string[], intent: Intent, view: TurnView): Outbound | null {
  const ts = nonEmpty(texts);
  if (ts === null) return null;
  const triggerKind = trigger(view).kind;
  const reply = intent === "reply" ? newestReply(view) : undefined;
  return reply ? { texts: ts, intent, triggerKind, reply } : { texts: ts, intent, triggerKind };
}

function personTurns(view: TurnView): NewTurn[] {
  const turns: NewTurn[] = [];
  for (const item of view.batch.items) {
    if (item.event.kind === "message") {
      turns.push({ role: "person", text: item.event.text, at: item.receivedAt, eventKey: item.key });
    }
  }
  return turns;
}

function lifecycleEffects(view: TurnView): Pick<TurnCommit, "reachability" | "ensureCheckin"> {
  const e = trigger(view);
  if (e.kind !== "lifecycle" || e.at < view.statusAt) return { reachability: null, ensureCheckin: null };
  return e.change === "follow"
    ? { reachability: { status: "active", at: e.at }, ensureCheckin: checkinWakeup(view.now, view.tz, view.checkinLocal) }
    : { reachability: { status: "blocked", at: e.at }, ensureCheckin: null };
}

function lateTrigger(view: TurnView): { readonly dueAt: EpochMs } | null {
  const e = trigger(view);
  return (e.kind === "wakeup" || e.kind === "checkin") && isLate(e) ? e : null;
}

function triggerNote(e: AgentEvent, tz: TimeZone): string | null {
  switch (e.kind) {
    case "wakeup":
      return `Wake-up "${e.key}" (due ${human(e.dueAt, tz)}): ${e.note}`;
    case "checkin":
      return "Daily check-in";
    case "message":
    case "lifecycle":
      return null;
    default:
      return assertNever(e);
  }
}

export function planTurn(out: TurnOutput, view: TurnView): TurnCommit {
  const first = trigger(view);
  const intent = intentOf(first);
  const pending = new Map<WakeupKey, NewWakeup>(view.pending.map((w) => [w.key, w]));
  const sends: string[] = [];
  const notes: string[] = [];
  const cancels: WakeupKey[] = [];
  const adds = new Map<WakeupKey, NewReminder>();
  const rejected: { action: string; reason: string }[] = [];
  const notices = new Set<string>();

  for (const a of out.actions) {
    switch (a.type) {
      case "send":
        if (sends.length < TURN.maxSendsPerTurn) sends.push(a.text);
        else rejected.push({ action: "send", reason: "too_many_sends" });
        break;
      case "schedule_wakeup": {
        const origin = wakeupOrigin(first.kind, a.asked);
        const admission = admitReminder({ key: a.key, at: a.at, note: a.note, origin }, { now: view.now, tz: view.tz, pending });
        if (admission.ok) {
          adds.set(admission.wakeup.key, admission.wakeup);
          pending.set(admission.wakeup.key, admission.wakeup);
        } else {
          rejected.push({ action: `schedule_wakeup:${a.key}`, reason: admission.reason });
          const notice = REJECTION_NOTICE[admission.reason];
          if (notice !== null) notices.add(notice);
        }
        break;
      }
      case "cancel_wakeup": {
        const key = parseWakeupKey(a.key);
        const current = key === null ? undefined : pending.get(key);
        if (key === null || current === undefined || current.kind !== "reminder") {
          rejected.push({ action: `cancel_wakeup:${a.key}`, reason: key === CHECKIN_KEY ? "reserved_key" : "not_pending" });
          break;
        }
        pending.delete(key);
        if (!adds.delete(key)) cancels.push(key);
        break;
      }
      case "remember":
        notes.push(a.note);
        break;
      case "quiet":
        break;
      default:
        assertNever(a);
    }
  }

  const agentTexts = [...sends];
  const late = lateTrigger(view);
  if (late && agentTexts.length > 0) {
    const notice = out.lateNotice?.trim() || NOTICE.lateFallback(human(late.dueAt, view.tz));
    agentTexts[0] = `${notice}\n${agentTexts[0]}`;
  }
  const noticeText = intent === "reply" && notices.size > 0 ? [...notices].join("\n") : null;
  if (noticeText !== null && agentTexts.length >= TURN.maxSendsPerTurn) {
    agentTexts.pop();
    rejected.push({ action: "send", reason: "too_many_sends" });
  }
  const texts = noticeText === null ? agentTexts : [...agentTexts, noticeText];

  const effects = lifecycleEffects(view);
  const turns = personTurns(view);
  const note = texts.length > 0 ? triggerNote(first, view.tz) : null;
  if (note !== null) turns.push({ role: "note", text: note, at: view.now, eventKey: view.batch.items[0].key });
  for (const text of agentTexts) turns.push({ role: "agent", text, at: view.now, eventKey: view.batch.items[0].key });
  if (noticeText !== null) turns.push({ role: "note", text: noticeText, at: view.now, eventKey: view.batch.items[0].key });

  const acted = texts.length > 0 || adds.size > 0 || cancels.length > 0 || notes.length > 0 || effects.reachability !== null;
  return {
    batchKeys: batchKeys(view),
    outcome: acted ? "acted" : "quiet",
    turns,
    outbound: outbound(texts, intent, view),
    wakeupsCancel: cancels,
    wakeupsAdd: [...adds.values()],
    notes,
    task: out.task,
    ...effects,
    rejected,
  };
}

export type NoModelReason =
  | { readonly kind: "block" }
  | { readonly kind: "stale_lifecycle" }
  | { readonly kind: "refused_budget"; readonly alreadyToldToday: boolean }
  | { readonly kind: "model_failed" }
  | { readonly kind: "poison" };

export function bypassModel(view: TurnView): Extract<NoModelReason, { kind: "block" | "stale_lifecycle" }> | null {
  const e = trigger(view);
  if (e.kind !== "lifecycle") return null;
  if (e.at < view.statusAt) return { kind: "stale_lifecycle" };
  return e.change === "block" ? { kind: "block" } : null;
}

export function planWithoutModel(view: TurnView, why: NoModelReason): TurnCommit {
  const answersPerson = trigger(view).kind === "message";
  let outcome: TurnOutcome;
  let text: string | null = null;
  switch (why.kind) {
    case "block":
      outcome = "no_model";
      break;
    case "stale_lifecycle":
      outcome = "stale";
      break;
    case "refused_budget":
      outcome = "refused_budget";
      if (answersPerson && !why.alreadyToldToday) text = NOTICE.monthlyLimit;
      break;
    case "model_failed":
    case "poison":
      outcome = why.kind;
      if (answersPerson) text = NOTICE.failed;
      break;
    default:
      return assertNever(why);
  }
  const turns = personTurns(view);
  if (text !== null) turns.push({ role: "note", text, at: view.now, eventKey: view.batch.items[0].key });
  return {
    batchKeys: batchKeys(view),
    outcome,
    turns,
    outbound: outbound(text === null ? [] : [text], "reply", view),
    wakeupsCancel: [],
    wakeupsAdd: [],
    notes: [],
    task: null,
    ...lifecycleEffects(view),
    rejected: [],
  };
}

export type TurnCall =
  | {
      readonly kind: "settled";
      readonly reservationId: string;
      readonly model: ModelId;
      readonly estimate: MicroUsd;
      readonly cost: MicroUsd;
      readonly usage: Usage | null;
    }
  | { readonly kind: "refused"; readonly scope: "user_cap" | "global_ceiling"; readonly model: ModelId; readonly estimate: MicroUsd }
  | { readonly kind: "none" };

export function logsForTurn(input: {
  readonly agent: AgentKey;
  readonly commit: TurnCommit;
  readonly view: TurnView;
  readonly call: TurnCall;
  readonly startedAt: EpochMs;
  readonly now: EpochMs;
}): LogRow[] {
  const { agent, commit, view, call } = input;
  const turnId = `${agent}|${commit.batchKeys[0]}`;
  const rows: LogRow[] = [
    {
      stream: "turn",
      id: turnId,
      agent,
      eventKind: trigger(view).kind,
      batchSize: view.batch.items.length,
      taskKind: commit.task?.kind ?? null,
      taskKey: commit.task?.key ?? null,
      taskStatus: commit.task?.status ?? "none",
      outcome: commit.outcome,
      refusedForBudget: commit.outcome === "refused_budget",
      costMicro: call.kind === "settled" ? call.cost : NO_COST,
      attempts: Math.max(...view.batch.items.map((i) => i.attempts)),
      startedAt: input.startedAt,
      finishedAt: input.now,
    },
  ];
  switch (call.kind) {
    case "settled":
      rows.push(
        modelCallRow({
          id: call.reservationId,
          agent,
          purpose: "turn",
          model: call.model,
          status: "settled",
          estimate: call.estimate,
          cost: call.cost,
          usage: call.usage,
          at: input.now,
        }),
      );
      break;
    case "refused":
      rows.push(
        modelCallRow({
          id: `refused:${turnId}`,
          agent,
          purpose: "turn",
          model: call.model,
          status: call.scope === "user_cap" ? "refused_user_cap" : "refused_global_ceiling",
          estimate: call.estimate,
          cost: NO_COST,
          usage: null,
          at: input.now,
        }),
      );
      break;
    case "none":
      break;
    default:
      assertNever(call);
  }
  if (commit.reachability !== null) {
    rows.push({
      stream: "lifecycle",
      id: commit.batchKeys[0],
      agent,
      change: commit.reachability.status === "active" ? "follow" : "block",
      source: "channel",
      at: commit.reachability.at,
    });
  }
  return rows;
}
