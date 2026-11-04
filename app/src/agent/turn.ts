import { z } from "zod";
import {
  CHECKIN_KEY,
  LANGUAGES,
  TASK_KINDS,
  WAKEUP_KEY_PATTERN,
  assertNever,
  clip,
  intentOf,
  mayspend,
  parseWakeupKey,
  type Admission,
  type AgentEvent,
  type AgentEventKind,
  type AgentKey,
  type EpochMs,
  type EventKey,
  type FactCause,
  type Intent,
  type Language,
  type MicroUsd,
  type PersonStatus,
  type ReplyHandle,
  type TimeOfDay,
  type TimeZone,
  type WakeupKey,
} from "../domain";
import type { ActionRejection, LogRow, TurnOutcome } from "../ledger/ledger";
import { NOTICES, type FixedNotice, type Notices } from "../notices";
import type { PromptParts, PromptSection } from "../model/prompt";
import {
  admitReminder,
  checkinWakeup,
  remindersOverCap,
  isLate,
  retime,
  wakeupOrigin,
  type NewReminder,
  type NewWakeup,
  type PendingWakeup,
} from "../policy/schedule";
import { parseTimeZone, toLocal, weekday } from "../policy/time";
import {
  NO_TASKS,
  TASKS,
  linkOf,
  planTasks,
  purposeOf,
  taskEffects,
  taskOf,
  type AcceptReply,
  type TaskCommit,
  type TaskTarget,
  type TaskView,
  type UnaskedPurpose,
} from "./tasks";
import type { AdmissionCommit } from "./admission";

export const TURN = {
  recentNotes: 50,
  maxBatchMessages: 10,
  maxSendsPerTurn: 3,
  maxTextChars: 600,
  maxNoteChars: 300,
  maxLateNoticeChars: 200,
  maxActions: 6,
  maxClaimAttempts: 3,
  maxModelAttempts: 3,
  maxRequestedModelAttempts: 5,
} as const;

const Slug = z.string().regex(WAKEUP_KEY_PATTERN);

// The API doesn't enforce string length limits (the SDK moves them into descriptions), so a .max() here
// would fail the whole turn on one long text.
const atMost = (n: number) => `At most ${n} characters.`;

const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send"), text: z.string().min(1).describe(atMost(TURN.maxTextChars)) }),
  z.object({
    type: z.literal("schedule_wakeup"),
    key: Slug,
    at: z.string().describe("Local wall time, YYYY-MM-DDTHH:mm"),
    note: z.string().min(1).describe(`What your future self should do. ${atMost(TURN.maxNoteChars)}`),
    asked: z.boolean().describe("True only when the person explicitly asked you to remind them"),
    task: z.string().describe('The ref of the open task this wake-up follows up, or ""'),
  }),
  z.object({ type: z.literal("cancel_wakeup"), key: Slug }),
  z.object({ type: z.literal("remember"), note: z.string().min(1).describe(atMost(TURN.maxNoteChars)) }),
  z.object({ type: z.literal("quiet") }),
  z.object({
    type: z.literal("set_locale"),
    timeZone: z.string().describe("The person's IANA time zone, such as Asia/Bangkok or Europe/London"),
    language: z.enum(LANGUAGES).describe("The language of code-written notices"),
  }),
]);

const TaskOpSchema = z.object({
  op: z.enum(["open", "propose", "close"]),
  ref: Slug,
  kind: z.enum(TASK_KINDS),
  title: z.string().min(1).describe(atMost(TASKS.maxTitleChars)),
  plan: z.string().describe(`The whole plan, one step or time per line, when op is propose; otherwise "". ${atMost(TASKS.maxPlanChars)}`),
});

export const TurnOutputSchema = z.object({
  actions: z.array(ActionSchema).describe(`At most ${TURN.maxActions} actions.`),
  lateNotice: z.string().describe(atMost(TURN.maxLateNoticeChars)).nullish(),
  tasks: z.array(TaskOpSchema).describe(`At most ${TASKS.maxOps}. Use [] when the turn is chat or a reminder.`),
  about: z.string().describe('The ref of the open task your messages this turn are about, or "".'),
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

export type TurnView = TaskView & {
  readonly admission: Admission;
  readonly tz: TimeZone;
  readonly language: Language;
  readonly status: PersonStatus;
  readonly statusAt: EpochMs;
  readonly checkinLocal: TimeOfDay;
  readonly summary: string;
  readonly notes: readonly string[];
  readonly recent: readonly TurnRow[];
  readonly pending: readonly PendingWakeup[];
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
    case "choice":
      return e.choice.kind === "accept"
        ? `The person tapped Accept on plan ${e.choice.proposal}.`
        : e.choice.kind === "consent"
          ? "The person agreed to the privacy notice."
          : "The person chose to use their own key as a backup.";
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

function renderTask(t: TurnView["openTasks"][number]): string {
  return `- ${t.ref} (${t.kind}): ${t.title}.${t.proposal ? ` Plan ${t.proposal} offered.` : ""}`;
}

/** What a turn prompt always keeps whole, so every route's budget can hold it. */
export const PROMPT_CAPS = { messageChars: 2_000, batchChars: 8_000 } as const;

function renderBatch(view: TurnView): string[] {
  let left: number = PROMPT_CAPS.batchChars;
  return view.batch.items.map((i) => {
    const line = renderEvent(i.event, view.tz);
    const cut = line.length > Math.min(PROMPT_CAPS.messageChars, left) ? clip(line, Math.max(1, Math.min(PROMPT_CAPS.messageChars, left))) : line;
    left = Math.max(0, left - cut.length);
    return cut;
  });
}

const keep = (title: string, lines: readonly string[]): PromptSection => ({ title, keep: lines, trim: [], dropRank: 0 });

/** The turn prompt as sections: the conversation, then notes, are what a smaller route's budget trims first. */
export function renderUser(view: TurnView): PromptParts {
  const conversation = view.recent.map((r) => `[${human(r.at, view.tz)}] ${SPEAKER[r.role]} ${r.text}`);
  return {
    sections: [
      keep("Now", [`${human(view.now, view.tz)} (${weekday(view.now, view.tz)}), ${view.tz}`, `Language for notices: ${view.language}`]),
      { title: "Memory", keep: [view.summary || "(nothing yet)"], trim: view.notes.map((n) => `- ${n}`), dropRank: 2 },
      keep("Pending wake-ups", view.pending.length ? view.pending.map((w) => renderPending(w, view.tz)) : ["(none)"]),
      keep("Open tasks", view.openTasks.length ? view.openTasks.map(renderTask) : ["(none)"]),
      keep(`Unasked messages left today: ${view.unaskedLeftToday}`, []),
      conversation.length ? { title: "Conversation", keep: [], trim: conversation, dropRank: 1 } : keep("Conversation", ["(no earlier messages)"]),
      keep("New", renderBatch(view)),
    ],
  };
}

export type NewTurn = TurnRow & { readonly eventKey: EventKey };

export type Outbound = {
  readonly texts: readonly [string, ...string[]];
  readonly intent: Intent;
  readonly triggerKind: AgentEventKind;
  readonly reply?: ReplyHandle;
  readonly link: TaskTarget | null;
  readonly purpose: UnaskedPurpose | null;
  /** The store binds an accept to the proposal it creates in the same transaction. */
  readonly choice: "accept_pending" | "consent" | null;
  readonly replyOnly: boolean;
};

/** A reminder the turn adds, with the task it follows up, which may be one opened in the same turn. */
export type ReminderAdd = NewReminder & { readonly task: TaskTarget | null };

export type Reachability = { readonly status: PersonStatus; readonly at: EpochMs };

export type TurnCommit = {
  readonly batchKeys: readonly [EventKey, ...EventKey[]];
  readonly outcome: TurnOutcome;
  readonly turns: readonly NewTurn[];
  readonly outbound: Outbound | null;
  readonly wakeupsCancel: readonly WakeupKey[];
  readonly wakeupsAdd: readonly ReminderAdd[];
  readonly wakeupsRetime: readonly { readonly key: WakeupKey; readonly dueAt: EpochMs }[];
  readonly locale: { readonly tz: TimeZone; readonly language: Language } | null;
  readonly notes: readonly string[];
  readonly tasks: TaskCommit;
  /** The event that caused this turn, which the store records as the cause of the facts it adds. */
  readonly trigger: FactCause;
  readonly reachability: Reachability | null;
  readonly ensureCheckin: NewWakeup | null;
  /** Set only for someone not admitted, by the admission planner. */
  readonly admission: AdmissionCommit | null;
  readonly rejected: readonly { readonly action: string; readonly reason: ActionRejection }[];
};

const REJECTION_NOTICE: Readonly<Record<ActionRejection, FixedNotice | null>> = {
  limit: "reminderLimit",
  past: "reminderPast",
  duplicate: "reminderDuplicate",
  too_far: "reminderTooFar",
  bad_time: "reminderBadTime",
  bad_key: "reminderNotSet",
  reserved_key: "checkinReserved",
  not_pending: "cancelNotFound",
  bad_zone: "badZone",
  too_many_sends: null,
  too_many_actions: "tooManyActions",
  too_long: null,
  task_limit: null,
  task_unknown: null,
  task_done: null,
  plan_empty: null,
  plan_too_thin: null,
  too_many_proposals: null,
  too_many_task_ops: null,
};

function actionLabel(a: TurnOutput["actions"][number]): string {
  return a.type === "schedule_wakeup" || a.type === "cancel_wakeup" ? `${a.type}:${a.key}` : a.type;
}

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
    const e = item.event;
    if ((e.kind === "message" || e.kind === "lifecycle" || e.kind === "choice") && e.reply) reply = e.reply;
  }
  return reply;
}

type OutboundTask = Pick<Outbound, "link" | "purpose" | "choice">;

function outbound(texts: readonly string[], intent: Intent, view: TurnView, task: OutboundTask): Outbound | null {
  const ts = nonEmpty(texts);
  if (ts === null) return null;
  const base = { texts: ts, intent, triggerKind: trigger(view).kind, ...task, replyOnly: false };
  const reply = intent === "reply" ? newestReply(view) : undefined;
  return reply ? { ...base, reply } : base;
}

function causeOf(view: TurnView): FactCause {
  return { key: view.batch.items[0].key, kind: trigger(view).kind, at: view.now };
}

function acceptNotice(t: Notices, r: AcceptReply): string {
  return r.kind === "accepted" ? t.planAccepted(r.title) : t.planChanged;
}

function personTurns(view: TurnView): NewTurn[] {
  const turns: NewTurn[] = [];
  for (const item of view.batch.items) {
    const e = item.event;
    if (e.kind === "message") turns.push({ role: "person", text: e.text, at: item.receivedAt, eventKey: item.key });
    if (e.kind === "choice") {
      const text =
        e.choice.kind === "accept"
          ? `[tapped Accept on plan ${e.choice.proposal}]`
          : e.choice.kind === "consent"
            ? "[agreed to the privacy notice]"
            : "[chose to use their key as a backup]";
      turns.push({ role: "person", text, at: item.receivedAt, eventKey: item.key });
    }
  }
  return turns;
}

function lifecycleEffects(view: TurnView): Pick<TurnCommit, "reachability" | "ensureCheckin"> {
  const e = trigger(view);
  const none = { reachability: null, ensureCheckin: null };
  const reachable = (at: EpochMs) => ({
    reachability: { status: "active" as const, at },
    ensureCheckin: mayspend(view.admission) ? checkinWakeup(view.now, view.tz, view.checkinLocal) : null,
  });
  switch (e.kind) {
    case "message":
    case "choice": {
      const at = Math.max(...view.batch.items.map((i) => i.receivedAt)) as EpochMs;
      return view.status === "blocked" && at >= view.statusAt ? reachable(at) : none;
    }
    case "lifecycle":
      if (e.at < view.statusAt) return none;
      return e.change === "follow" ? reachable(e.at) : { reachability: { status: "blocked", at: e.at }, ensureCheckin: null };
    case "wakeup":
    case "checkin":
      return none;
    default:
      return assertNever(e);
  }
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
    case "choice":
      return null;
    default:
      return assertNever(e);
  }
}

export function planTurn(out: TurnOutput, given: TurnView): TurnCommit {
  const actions = out.actions.slice(0, TURN.maxActions);
  const setLocale = actions.findLast((a) => a.type === "set_locale");
  const language = setLocale?.language ?? given.language;
  const t = NOTICES[language];
  const zone = setLocale ? parseTimeZone(setLocale.timeZone) : null;
  const view: TurnView = { ...given, tz: zone ?? given.tz, language };
  const first = trigger(view);
  const intent = intentOf(first);
  const pending = new Map<WakeupKey, NewWakeup>(view.pending.map((w) => [w.key, w]));
  const sends: string[] = [];
  const notes: string[] = [];
  const cancelled = new Map<WakeupKey, NewWakeup>();
  const adds = new Map<WakeupKey, ReminderAdd>();
  const askedFor = new Set<WakeupKey>();
  const rejected: { action: string; reason: ActionRejection }[] = [];
  const notices = new Set<string>();
  const reject = (action: string, reason: ActionRejection, tellPerson: boolean) => {
    rejected.push({ action, reason });
    const notice = REJECTION_NOTICE[reason];
    if (tellPerson && notice !== null) notices.add(t[notice]);
  };
  const fit = (text: string, max: number, action: string): string => {
    if (text.length <= max) return text;
    reject(action, "too_long", false);
    return clip(text, max);
  };

  const fx = taskEffects(view);
  for (const r of fx.replies) notices.add(acceptNotice(t, r));
  const planned = planTasks(out.tasks, view, causeOf(view), fx.commit);
  const tasks = planned.commit;
  for (const r of planned.rejected) reject(r.action, r.reason, false);
  const sendCap = TURN.maxSendsPerTurn - (tasks.propose ? 1 : 0);

  for (const a of out.actions.slice(TURN.maxActions)) {
    reject(actionLabel(a), "too_many_actions", a.type === "cancel_wakeup" || a.type === "set_locale" || (a.type === "schedule_wakeup" && a.asked));
  }
  if (setLocale && zone === null) reject("set_locale", "bad_zone", true);
  const cancelsFirst = [...actions.filter((a) => a.type === "cancel_wakeup"), ...actions.filter((a) => a.type !== "cancel_wakeup")];
  for (const a of cancelsFirst) {
    switch (a.type) {
      case "send":
        if (sends.length < sendCap) sends.push(fit(a.text, TURN.maxTextChars, "send"));
        else reject("send", "too_many_sends", false);
        break;
      case "schedule_wakeup": {
        const origin = wakeupOrigin(first.kind, a.asked);
        const note = fit(a.note, TURN.maxNoteChars, actionLabel(a));
        const admission = admitReminder({ key: a.key, at: a.at, note, origin }, { now: view.now, tz: view.tz, pending });
        if (admission.ok) {
          adds.set(admission.wakeup.key, { ...admission.wakeup, task: taskOf(view, tasks, a.task) });
          pending.set(admission.wakeup.key, admission.wakeup);
          if (a.asked) askedFor.add(admission.wakeup.key);
        } else {
          reject(actionLabel(a), admission.reason, a.asked);
          const key = parseWakeupKey(a.key);
          const original = key === null ? undefined : cancelled.get(key);
          if (key !== null && original !== undefined && !adds.has(key)) {
            cancelled.delete(key);
            pending.set(key, original);
            if (a.asked) notices.add(t.reminderKept(human(original.dueAt, given.tz)));
          }
        }
        break;
      }
      case "cancel_wakeup": {
        const key = parseWakeupKey(a.key);
        const current = key === null ? undefined : pending.get(key);
        if (key === null || current === undefined || current.kind !== "reminder") {
          reject(actionLabel(a), key === CHECKIN_KEY ? "reserved_key" : "not_pending", true);
          break;
        }
        pending.delete(key);
        cancelled.set(key, current);
        break;
      }
      case "remember":
        notes.push(fit(a.note, TURN.maxNoteChars, "remember"));
        break;
      case "quiet":
      case "set_locale":
        break;
      default:
        assertNever(a);
    }
  }
  const fresh = [...adds.keys()].filter((key) => !cancelled.has(key));
  for (const key of fresh.slice(fresh.length - remindersOverCap(pending.values()))) {
    adds.delete(key);
    pending.delete(key);
    reject(`schedule_wakeup:${key}`, "limit", askedFor.has(key));
  }
  const wakeupsRetime =
    view.tz === given.tz
      ? []
      : [...pending.values()]
          .filter((w) => !adds.has(w.key))
          .map((w) => ({ key: w.key, dueAt: retime(w, given.tz, view.tz, view.now, view.checkinLocal) }));

  const agentTexts = [...sends];
  const late = lateTrigger(view);
  if (late && agentTexts.length > 0) {
    const given = out.lateNotice?.trim();
    const notice = given ? fit(given, TURN.maxLateNoticeChars, "late_notice") : t.lateFallback(human(late.dueAt, view.tz));
    agentTexts[0] = `${notice}\n${agentTexts[0]}`;
  }
  const noticeText = (agentTexts.length > 0 || intent === "reply") && notices.size > 0 ? [...notices].join("\n") : null;
  if (noticeText !== null && agentTexts.length >= sendCap) {
    agentTexts.pop();
    rejected.push({ action: "send", reason: "too_many_sends" });
  }
  const plan = tasks.propose?.text ?? null;
  const said = [...agentTexts, ...(noticeText === null ? [] : [noticeText]), ...(plan === null ? [] : [plan])];
  const requestedReminder = said.length === 0 ? textWithoutModel(view, null) : null;
  const texts = requestedReminder === null ? said : [requestedReminder];

  const effects = lifecycleEffects(view);
  const turns = personTurns(view);
  const note = said.length > 0 ? triggerNote(first, view.tz) : null;
  if (note !== null) turns.push({ role: "note", text: note, at: view.now, eventKey: view.batch.items[0].key });
  for (const text of agentTexts) turns.push({ role: "agent", text, at: view.now, eventKey: view.batch.items[0].key });
  if (noticeText !== null) turns.push({ role: "note", text: noticeText, at: view.now, eventKey: view.batch.items[0].key });
  if (plan !== null) turns.push({ role: "agent", text: plan, at: view.now, eventKey: view.batch.items[0].key });
  if (requestedReminder !== null) turns.push({ role: "note", text: requestedReminder, at: view.now, eventKey: view.batch.items[0].key });

  const locale = setLocale ? { tz: view.tz, language } : null;
  const changedTasks = tasks.open.length > 0 || tasks.facts.length > 0;
  const acted =
    texts.length > 0 || adds.size > 0 || cancelled.size > 0 || notes.length > 0 || effects.reachability !== null || locale !== null || changedTasks;
  const link = linkOf(view, tasks, out.about);
  return {
    batchKeys: batchKeys(view),
    outcome: acted ? "acted" : "quiet",
    turns,
    outbound: outbound(texts, intent, view, { link, purpose: purposeOf(view, tasks, link), choice: plan === null ? null : "accept_pending" }),
    wakeupsCancel: [...cancelled.keys()],
    wakeupsAdd: [...adds.values()],
    wakeupsRetime,
    locale,
    notes,
    tasks,
    trigger: causeOf(view),
    ...effects,
    admission: null,
    rejected,
  };
}

export type NoModelReason =
  | { readonly kind: "block" }
  | { readonly kind: "ignored" }
  | { readonly kind: "stale_lifecycle" }
  | { readonly kind: "over_cap"; readonly scope: "byok" | "included" | "included_ceiling"; readonly capUsd: string; readonly alreadyToldToday: boolean }
  | { readonly kind: "no_access"; readonly text: string; readonly alreadyToldToday: boolean }
  | { readonly kind: "lapsed"; readonly alreadyToldToday: boolean }
  | { readonly kind: "model_failed" }
  | { readonly kind: "poison" }
  | { readonly kind: "command"; readonly text: string; readonly note: string }
  | { readonly kind: "admission"; readonly commit: AdmissionCommit; readonly text: string | null; readonly consent: boolean };

export function bypassModel(view: TurnView): Extract<NoModelReason, { kind: "block" | "stale_lifecycle" }> | null {
  const e = trigger(view);
  if (e.kind !== "lifecycle") return null;
  if (e.at < view.statusAt) return { kind: "stale_lifecycle" };
  return e.change === "block" ? { kind: "block" } : null;
}

function textWithoutModel(view: TurnView, notice: string | null): string | null {
  const e = trigger(view);
  if (e.kind === "message") return notice;
  if (e.kind !== "wakeup" || e.origin !== "person") return null;
  const t = NOTICES[view.language];
  const late = isLate(e) ? `${t.lateFallback(human(e.dueAt, view.tz))}\n` : "";
  return `${late}${t.reminder(e.note)}`;
}

/**
 * A turn the model doesn't answer. An accept the person tapped or typed still commits and is confirmed,
 * because the evidence is theirs, not the model's.
 */
export function planWithoutModel(view: TurnView, why: NoModelReason): TurnCommit {
  const t: Notices = NOTICES[view.language];
  const fx = taskEffects(view);
  let outcome: TurnOutcome;
  let text: string | null = null;
  let note: string | null = null;
  switch (why.kind) {
    case "block":
    case "ignored":
      outcome = "no_model";
      break;
    case "stale_lifecycle":
      outcome = "stale";
      break;
    case "over_cap": {
      outcome = "refused_budget";
      const notice = why.scope === "byok" ? t.ownCapReached(why.capUsd) : why.scope === "included" ? t.includedCapReached : t.monthlyLimit;
      text = textWithoutModel(view, why.alreadyToldToday ? null : notice);
      break;
    }
    case "no_access":
      outcome = "no_access";
      text = textWithoutModel(view, why.alreadyToldToday ? null : why.text);
      break;
    case "lapsed":
      outcome = "lapsed";
      text = textWithoutModel(view, why.alreadyToldToday ? null : t.lapsed);
      break;
    case "model_failed":
    case "poison":
      outcome = why.kind;
      text = textWithoutModel(view, t.failed);
      break;
    case "command":
      outcome = "no_model";
      text = why.text;
      note = why.note;
      break;
    case "admission":
      return planAdmissionTurn(view, why);
    default:
      return assertNever(why);
  }
  const confirmed = fx.replies.map((r) => acceptNotice(t, r));
  const joined = (lead: string | null) => [lead, ...confirmed].filter((x) => x !== null).join("\n") || null;
  const said = joined(text);
  const turns = personTurns(view);
  const kept = joined(note ?? text);
  if (kept !== null) turns.push({ role: "note", text: kept, at: view.now, eventKey: view.batch.items[0].key });
  return {
    batchKeys: batchKeys(view),
    outcome,
    turns,
    outbound: outbound(said === null ? [] : [said], intentOf(trigger(view)), view, {
      link: null,
      purpose: purposeOf(view, fx.commit, null),
      choice: null,
    }),
    wakeupsCancel: [],
    wakeupsAdd: [],
    wakeupsRetime: [],
    locale: null,
    notes: [],
    tasks: fx.commit,
    trigger: causeOf(view),
    ...lifecycleEffects(view),
    admission: null,
    rejected: [],
  };
}

function planAdmissionTurn(view: TurnView, why: Extract<NoModelReason, { kind: "admission" }>): TurnCommit {
  const out = outbound(why.text === null ? [] : [why.text], "reply", view, { link: null, purpose: null, choice: why.consent ? "consent" : null });
  return {
    batchKeys: batchKeys(view),
    outcome: "not_admitted",
    turns: [],
    outbound: out && { ...out, replyOnly: true },
    wakeupsCancel: [],
    wakeupsAdd: [],
    wakeupsRetime: [],
    locale: null,
    notes: [],
    tasks: NO_TASKS,
    trigger: causeOf(view),
    reachability: lifecycleEffects(view).reachability,
    ensureCheckin: null,
    admission: why.commit,
    rejected: [],
  };
}

/** What a turn's model call cost; its model_call rows were written when each attempt settled. */
export type TurnCall = { readonly kind: "served"; readonly costMicro: MicroUsd } | { readonly kind: "none" };

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
      outcome: commit.outcome,
      refusedForBudget: commit.outcome === "refused_budget",
      costMicro: call.kind === "served" ? call.costMicro : NO_COST,
      attempts: Math.max(...view.batch.items.map((i) => i.attempts)),
      startedAt: input.startedAt,
      finishedAt: input.now,
    },
  ];
  rows.push(
    ...commit.rejected.map((r, i): LogRow => ({ stream: "rejection", id: `${turnId}|${i}`, agent, turnId, action: r.action, reason: r.reason, at: input.now })),
  );
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
