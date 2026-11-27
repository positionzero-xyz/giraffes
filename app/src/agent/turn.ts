import { z } from "zod";
import {
  CHECKIN_KEY,
  LANGUAGES,
  REPEATS,
  TASK_KINDS,
  WAKEUP_KEY_PATTERN,
  assertNever,
  clip,
  clipBytes,
  intentOf,
  mayspend,
  parseTaskRef,
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
import { AGENT_SYSTEM } from "./prompt";
import { bytesOf, renderPrompt, type PromptParts, type PromptSection } from "../model/prompt";
import type { JsonSchema } from "../model/client";
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
  taskOpLabel,
  taskOf,
  type AcceptReply,
  type TaskCommit,
  type TaskTarget,
  type TaskView,
  type UnaskedPurpose,
} from "./tasks";
import type { AdmissionCommit } from "./admission";
import { FORGET_TEXT } from "./forget-text";

export const TURN = {
  recentNotes: 50,
  maxBatchMessages: 10,
  maxSendsPerTurn: 3,
  maxTextChars: 600,
  maxNoteBytes: 300,
  /** The newest message is always shown whole; the earlier ones in its batch are cut to these. */
  messageBytes: 2_000,
  batchBytes: 4_000,
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
const atMostBytes = (n: number) => `At most ${n} bytes of UTF-8: about ${n} English or ${Math.floor(n / 3)} Thai characters.`;

const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send"), text: z.string().min(1).describe(atMost(TURN.maxTextChars)) }),
  z.object({
    type: z.literal("schedule_wakeup"),
    key: Slug,
    at: z.string().describe("Local wall time, YYYY-MM-DDTHH:mm"),
    note: z.string().min(1).describe(`What your future self should do. ${atMostBytes(TURN.maxNoteBytes)}`),
    asked: z.boolean().describe("True only when the person explicitly asked you to remind them"),
    task: z.string().describe('The ref of the open task this wake-up follows up, or ""'),
    repeat: z
      .enum(REPEATS)
      .nullish()
      .describe("Only for a routine the person asked for: daily, weekdays (Monday to Friday) or weekly (the weekday of at). Omit for a one-off."),
  }),
  z.object({ type: z.literal("cancel_wakeup"), key: Slug }),
  z.object({ type: z.literal("remember"), note: z.string().min(1).describe(atMostBytes(TURN.maxNoteBytes)) }),
  z.object({ type: z.literal("quiet") }),
  z.object({
    type: z.literal("set_locale"),
    timeZone: z.string().describe("The person's IANA time zone, such as Asia/Bangkok or Europe/London"),
    language: z.enum(LANGUAGES).describe("The language of code-written notices"),
  }),
  z.object({ type: z.literal("forget") }),
]);

const TaskOpSchema = z.object({
  op: z.enum(["open", "propose", "close"]),
  ref: Slug,
  kind: z.enum(TASK_KINDS),
  title: z.string().min(1).describe(atMostBytes(TASKS.maxTitleBytes)),
  plan: z.string().describe(`The whole plan, one step or time per line, when op is propose; otherwise "". ${atMost(TASKS.maxPlanChars)}`),
});

const AGENT_ACTIONS: Readonly<Partial<Record<z.infer<typeof ActionSchema>["type"], string>>> = {
  schedule_wakeup: "Schedule a reminder, or a routine the person asked for, in their local time.",
  cancel_wakeup: "Cancel a pending wake-up by its key. Cancelling a routine's key ends the routine.",
  remember: "Keep a durable note about the person that will matter in a week.",
  set_locale: "Set the person's IANA time zone and the language of code-written notices.",
  forget: "The person asked you to forget, delete or stop remembering something. Code then tells them how to choose what goes; nothing else you do this turn is kept.",
};

export type AgentTool = { readonly name: string; readonly description: string; readonly inputSchema: JsonSchema };

type ObjectSchema = JsonSchema & { readonly properties: Record<string, unknown>; readonly required: readonly string[] };

// Plain JSON Schema, not the strict-mode form the parse routes need: an optional field stays optional for a tool call.
function toolSchema(o: z.ZodObject): ObjectSchema {
  const { $schema: _, ...schema } = z.toJSONSchema(o) as ObjectSchema;
  return schema;
}

const TASK_TOOL = "task";

/** The actions an agent session takes as tools; sending is its reply text, and quiet is an empty reply. */
export const AGENT_TOOLS: readonly AgentTool[] = [
  ...ActionSchema.options.flatMap((o) => {
    const description = AGENT_ACTIONS[o.shape.type.value];
    if (description === undefined) return [];
    const { properties, required, ...rest } = toolSchema(o);
    const { type: _, ...fields } = properties;
    return [{ name: o.shape.type.value, description, inputSchema: { ...rest, properties: fields, required: required.filter((k) => k !== "type") } }];
  }),
  {
    name: TASK_TOOL,
    description: "Open a task, propose its whole plan, or close one the person dropped. Opening a task that is already open only marks your reply as about it.",
    inputSchema: toolSchema(TaskOpSchema),
  },
];

const AgentCall = z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) });
const RefusedCalls = z.array(AgentCall.extend({ problems: z.array(z.string()) })).optional();
const AgentReply = z.object({ text: z.string(), calls: z.array(AgentCall), refusedCalls: RefusedCalls });

/** An agent session's reply as a turn output, for the same checks as any other; null when the box sent something else. */
export function turnFromAgent(raw: unknown): unknown {
  const reply = AgentReply.safeParse(raw);
  if (!reply.success) return null;
  const text = reply.data.text.trim();
  const tasks: z.infer<typeof TaskOpSchema>[] = [];
  const refusedCalls = [...(reply.data.refusedCalls ?? [])];
  for (const call of reply.data.calls) {
    if (call.name !== TASK_TOOL) continue;
    const task = TaskOpSchema.safeParse(call.input);
    if (task.success) tasks.push(task.data);
    else refusedCalls.push({ ...call, problems: task.error.issues.map((issue) => issue.message) });
  }
  return {
    actions: [...reply.data.calls.filter((c) => c.name !== TASK_TOOL).map((c) => ({ ...c.input, type: c.name })), text ? { type: "send", text } : { type: "quiet" }],
    refusedCalls,
    tasks,
    about: tasks.at(-1)?.ref ?? "",
  };
}

function refusedLabel(name: string, input: Record<string, unknown>, key: WakeupKey | null): string {
  if (name === TASK_TOOL) {
    const op = TaskOpSchema.shape.op.safeParse(input.op);
    const ref = typeof input.ref === "string" ? parseTaskRef(input.ref) : null;
    return op.success && ref !== null ? taskOpLabel(op.data, ref) : name;
  }
  return key === null ? name : `${name}:${key}`;
}

export const TurnOutputSchema = z.object({
  actions: z.array(ActionSchema).describe(`At most ${TURN.maxActions} actions.`),
  lateNotice: z.string().describe(atMost(TURN.maxLateNoticeChars)).nullish(),
  tasks: z.array(TaskOpSchema).describe(`At most ${TASKS.maxOps}. Use [] when the turn is chat or a reminder.`),
  about: z.string().describe('The ref of the open task your messages this turn are about, or "".'),
});
export const BoxTurnOutputSchema = TurnOutputSchema.extend({ refusedCalls: RefusedCalls });
export type TurnOutput = z.infer<typeof BoxTurnOutputSchema>;

export type InboxItem = {
  readonly key: EventKey;
  readonly event: AgentEvent;
  readonly attempts: number;
  readonly receivedAt: EpochMs;
  readonly catchUp?: "earlier" | "joined";
};

export type Batch = { readonly items: readonly [InboxItem, ...InboxItem[]] };

export type TurnRow = { readonly role: "person" | "agent" | "note"; readonly text: string; readonly at: EpochMs };
export type SeqTurn = TurnRow & { readonly seq: number };
export type BoxReplyBackfill = { readonly seq: number; readonly notice: string | null };

/** Claude Code keeps the system prompt a session started with, so a memory change has to reach a resumed session in a message. */
export type BoxSession = { readonly id: string | null; readonly seenSeq: number; readonly memory: string; readonly replyBackfill: readonly BoxReplyBackfill[] };
export type BoxSessionSeen = { readonly id: string | null; readonly sentThrough: number; readonly memory: string };

export type TurnView = TaskView & {
  readonly admission: Admission;
  readonly tz: TimeZone;
  readonly language: Language;
  readonly status: PersonStatus;
  readonly statusAt: EpochMs;
  readonly checkinLocal: TimeOfDay;
  readonly summary: string;
  readonly notes: readonly string[];
  /** The newest turns not yet in the summary. */
  readonly recent: readonly SeqTurn[];
  /** Turns not yet in the summary that are older than `recent` and so not shown. */
  readonly historyLeftOut: number;
  readonly pending: readonly PendingWakeup[];
  readonly unaskedLeftToday: number;
};

const human = (t: EpochMs, tz: TimeZone) => toLocal(t, tz).replace("T", " ");

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function lateLine(e: { readonly dueAt: EpochMs; readonly firedAt: EpochMs }, tz: TimeZone, askForLateNotice: boolean): string {
  if (!isLate(e)) return "";
  const instruction = askForLateNotice ? " Put one short line saying so in lateNotice." : "";
  return `\nLATE by ${duration(e.firedAt - e.dueAt)}: it was due ${human(e.dueAt, tz)}.${instruction}`;
}

function renderEvent(e: AgentEvent, tz: TimeZone, askForLateNotice: boolean): string {
  switch (e.kind) {
    case "message": {
      const quote = e.quote?.kind === "text" ? `\nEarlier message being replied to (context, not a request): ${JSON.stringify(e.quote.text)}` : "";
      const line = e.edited ? `Person edited their earlier message. Corrected text: ${e.text}` : `Person: ${e.text}`;
      return `${line}${quote}`;
    }
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
      const repeats = e.repeat ? ` It repeats ${e.repeat.every} at ${e.repeat.anchor.slice(11)}, and the next one is already scheduled.` : "";
      return `Your wake-up "${e.key}" fired: ${e.note}. Due ${human(e.dueAt, tz)}.${asked}${repeats}${lateLine(e, tz, askForLateNotice)}`;
    }
    case "checkin":
      return `Daily check-in.${lateLine(e, tz, askForLateNotice)}`;
    default:
      return assertNever(e);
  }
}

function renderPending(w: PendingWakeup, tz: TimeZone): string {
  switch (w.kind) {
    case "reminder": {
      const asked = w.origin === "person" ? " (asked for by the person)" : "";
      const repeats = w.repeat ? ` · repeats ${w.repeat.every}` : "";
      return `- ${w.key} · ${human(w.dueAt, tz)}${repeats} · ${w.note}${asked}`;
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

/** The newest event whole; earlier ones cut so they share `batchBytes`. A batch too long for a route is never sent. */
function batchLines(view: TurnView, askForLateNotice: boolean): { readonly text: string; readonly whole: boolean }[] {
  const items = view.batch.items;
  let left: number = TURN.batchBytes;
  return items.map((i, at) => {
    const line = renderEvent(i.event, view.tz, askForLateNotice);
    const sent = i.catchUp ? `[Sent ${human(i.receivedAt, view.tz)}] ` : "";
    if (at === items.length - 1) return { text: sent + line, whole: true };
    const share = i.catchUp ? Math.floor(left / (items.length - at - 1)) : left;
    const cut = clipBytes(line, Math.max(4, Math.min(TURN.messageBytes, share)));
    left = Math.max(0, left - bytesOf(cut));
    return { text: sent + cut, whole: cut === line };
  });
}

const batchWhole = (view: TurnView): readonly boolean[] => batchLines(view, false).map((line) => line.whole);

const keep = (title: string, lines: readonly string[]): PromptSection => ({ title, keep: lines, trim: [], dropRank: 0 });
const newSection = (view: TurnView, askForLateNotice: boolean) => {
  const lines = batchLines(view, askForLateNotice).map((line) => line.text);
  if (view.batch.items[0].catchUp) {
    lines.unshift("The AI connection just became available. Answer these requests together, and answer repeats once. Resolve relative reminder times from when the request was first sent, using the timestamps below. If the requested time has passed, say so and do not schedule it.");
  }
  return keep("New", lines);
};
const conversationLines = (rows: readonly TurnRow[], tz: TimeZone): string[] => rows.map((r) => `[${human(r.at, tz)}] ${SPEAKER[r.role]} ${r.text}`);
const nowSection = (view: TurnView) => keep("Now", [`${human(view.now, view.tz)} (${weekday(view.now, view.tz)}), ${view.tz}`, `Language for notices: ${view.language}`]);
const lookAhead = (view: TurnView): PromptSection[] => [
  keep("Pending wake-ups", view.pending.length ? view.pending.map((w) => renderPending(w, view.tz)) : ["(none)"]),
  keep("Open tasks", view.openTasks.length ? view.openTasks.map(renderTask) : ["(none)"]),
  keep(`Unasked messages left today: ${view.unaskedLeftToday}`, []),
];

/** The turn prompt as sections: the conversation, then notes, are what a smaller route's budget trims first. */
export function renderUser(view: TurnView): PromptParts {
  const conversation = conversationLines(view.recent, view.tz);
  return {
    sections: [
      nowSection(view),
      { title: "Memory", keep: [view.summary || "(nothing yet)"], trim: view.notes.map((n) => `- ${n}`), dropRank: 2 },
      ...lookAhead(view),
      conversation.length ? { title: "Conversation", keep: [], trim: conversation, dropRank: 1, history: true } : keep("Conversation", ["(no earlier messages)"]),
      newSection(view, true),
    ],
  };
}

export function memoryBlock(summary: string, notes: readonly string[]): string {
  const lines = memoryLines(summary, notes);
  return lines.length === 0 ? "" : renderPrompt({ sections: [keep("Memory", lines)] });
}

const memoryLines = (summary: string, notes: readonly string[]): string[] => [...(summary ? [summary] : []), ...notes.map((n) => `- ${n}`)];

export function memoryHeldAfter(view: TurnView, commit: TurnCommit): string {
  return memoryBlock(view.summary, [...view.notes, ...commit.notes].slice(-TURN.recentNotes));
}

type BoxPrompt = PromptParts & {
  readonly sentThrough: number;
  readonly historySeqs?: readonly number[];
};

export type BoxTurnPrompt = {
  readonly append: string;
  readonly session: string | null;
  readonly turn: BoxPrompt;
  readonly fresh: BoxPrompt;
};

export function renderBoxTurn(
  view: TurnView,
  held: BoxSession | null,
  overflow?: { readonly unseen: readonly SeqTurn[]; readonly fresh: readonly SeqTurn[] },
): BoxTurnPrompt {
  const memory = memoryBlock(view.summary, view.notes);
  const seen = held?.seenSeq ?? 0;
  const replies = new Map(held?.replyBackfill.map((r) => [r.seq, r]));
  const pending = overflow?.unseen ?? view.recent.filter((r) => r.seq > seen);
  const unseen = pending.flatMap((r): SeqTurn[] => {
    const reply = replies.get(r.seq);
    if (!reply) return [r];
    return reply.notice === null ? [] : [{ ...r, role: "note", text: reply.notice }];
  });
  const conversation = (rows: readonly SeqTurn[]): PromptSection[] =>
    rows.length ? [{ title: "Conversation you haven't seen", keep: [], trim: conversationLines(rows, view.tz), dropRank: 1, history: true, trimNewest: overflow !== undefined }] : [];
  const lines = memoryLines(view.summary, view.notes);
  const update = memory !== (held?.memory ?? "") ? [keep("Memory (replaces the memory you had)", lines.length ? lines : ["(empty)"])] : [];
  const parts = (rows: readonly SeqTurn[], extra: readonly PromptSection[], sentThrough: number): BoxPrompt => ({
    sections: [nowSection(view), ...extra, ...lookAhead(view), ...conversation(rows), newSection(view, false)],
    sentThrough,
    ...(overflow ? { historySeqs: rows.map((r) => r.seq) } : {}),
  });
  const fresh = overflow?.fresh ?? view.recent;
  const sentThrough = Math.max(seen, pending.at(-1)?.seq ?? 0);
  return {
    append: memory ? `${AGENT_SYSTEM}\n\n${memory}` : AGENT_SYSTEM,
    session: held?.id ?? null,
    turn: parts(unseen, update, sentThrough),
    fresh: parts(fresh, [], overflow ? fresh.at(-1)?.seq ?? 0 : sentThrough),
  };
}

/** A turn that isn't the person's own chat, such as a group's, runs in a session of its own that nothing records. */
export function oneOffBoxTurn(prompt: PromptParts): BoxTurnPrompt {
  const parts = { ...prompt, sentThrough: 0 };
  return { append: AGENT_SYSTEM, session: null, turn: parts, fresh: parts };
}

export type NewTurn = TurnRow & {
  readonly eventKey: EventKey;
  readonly boxView?: { readonly kind: "input" } | { readonly kind: "reply"; readonly notice: string | null };
};

/** Why a message goes out. Only an unasked one carries a purpose, the reason code had to send it. */
export type Asked = { readonly intent: Exclude<Intent, "unasked"> } | { readonly intent: "unasked"; readonly purpose: UnaskedPurpose };

export type Outbound = Asked & {
  readonly texts: readonly [string, ...string[]];
  readonly triggerKind: AgentEventKind;
  readonly reply?: ReplyHandle;
  readonly link: TaskTarget | null;
  /** The store binds an accept to the proposal it creates in the same transaction. */
  readonly choice: "accept_pending" | "consent" | null;
  readonly replyOnly: boolean;
};

const askedOf = (intent: Intent, purpose: UnaskedPurpose | null): Asked => (intent === "unasked" ? { intent, purpose: purpose ?? "unlinked" } : { intent });

/** A reminder the turn adds, with the task it follows up, which may be one opened in the same turn. */
export type ReminderAdd = NewReminder & { readonly task: TaskTarget | null };

export type Reachability = { readonly status: PersonStatus; readonly at: EpochMs };

export type TurnCommit = {
  readonly batchKeys: readonly [EventKey, ...EventKey[]];
  readonly outcome: TurnOutcome;
  readonly waitForAccess?: { readonly kind: "connection" } | { readonly kind: "budget"; readonly budget: string };
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
  tool_refused: "reminderNotSet",
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
    if (item.catchUp === "earlier") continue;
    const e = item.event;
    if ((e.kind === "message" || e.kind === "lifecycle" || e.kind === "choice") && e.reply) reply = e.reply;
  }
  return reply;
}

type OutboundTask = Pick<Outbound, "link" | "choice">;

function outbound(texts: readonly string[], asked: Asked, view: TurnView, task: OutboundTask): Outbound | null {
  const ts = nonEmpty(texts);
  if (ts === null) return null;
  const base = { ...asked, texts: ts, triggerKind: trigger(view).kind, ...task, replyOnly: false };
  const reply = asked.intent === "reply" ? newestReply(view) : undefined;
  return reply ? { ...base, reply } : base;
}

function causeOf(view: TurnView): FactCause {
  return { key: view.batch.items[0].key, kind: trigger(view).kind, at: view.now };
}

function acceptNotice(t: Notices, r: AcceptReply): string {
  return r.kind === "accepted" ? t.planAccepted(r.title) : t.planChanged;
}

function personTurns(view: TurnView, boxView?: NewTurn["boxView"]): NewTurn[] {
  const turns: NewTurn[] = [];
  const whole = batchWhole(view);
  for (const [at, item] of view.batch.items.entries()) {
    const seenWhole = boxView !== undefined && whole[at] === true ? boxView : undefined;
    const e = item.event;
    if (e.kind === "message") turns.push({ role: "person", text: e.text, at: item.receivedAt, eventKey: item.key, boxView: seenWhole });
    if (e.kind === "choice") {
      const text =
        e.choice.kind === "accept"
          ? `[tapped Accept on plan ${e.choice.proposal}]`
          : e.choice.kind === "consent"
            ? "[agreed to the privacy notice]"
            : "[chose to use their key as a backup]";
      turns.push({ role: "person", text, at: item.receivedAt, eventKey: item.key, boxView: seenWhole });
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
  if (out.actions.some((a) => a.type === "forget")) return planWithoutModel(given, { kind: "forget_offer" });
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
  const keepCancelled = (key: WakeupKey | null, asked: boolean) => {
    if (key === null || adds.has(key)) return;
    const original = cancelled.get(key);
    if (original === undefined) return;
    cancelled.delete(key);
    pending.set(key, original);
    if (asked) notices.add(t.reminderKept(human(original.dueAt, given.tz)));
  };
  const fit = (text: string, max: number, action: string): string => {
    if (text.length <= max) return text;
    reject(action, "too_long", false);
    return clip(text, max);
  };
  const fitBytes = (text: string, max: number, action: string): string => {
    const cut = clipBytes(text, max);
    if (cut !== text) reject(action, "too_long", false);
    return cut;
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
        const note = fitBytes(a.note, TURN.maxNoteBytes, actionLabel(a));
        const admission = admitReminder({ key: a.key, at: a.at, note, origin, repeat: a.repeat ?? null }, { now: view.now, tz: view.tz, pending });
        if (admission.ok) {
          adds.set(admission.wakeup.key, { ...admission.wakeup, task: taskOf(view, tasks, a.task) });
          pending.set(admission.wakeup.key, admission.wakeup);
          if (a.asked) askedFor.add(admission.wakeup.key);
        } else {
          reject(actionLabel(a), admission.reason, a.asked);
          keepCancelled(parseWakeupKey(a.key), a.asked);
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
        notes.push(fitBytes(a.note, TURN.maxNoteBytes, "remember"));
        break;
      case "quiet":
      case "set_locale":
      case "forget":
        break;
      default:
        assertNever(a);
    }
  }
  for (const { name, input } of out.refusedCalls ?? []) {
    const isSchedule = name === "schedule_wakeup";
    const key = (isSchedule || name === "cancel_wakeup") && typeof input.key === "string" ? parseWakeupKey(input.key) : null;
    const asked = isSchedule && input.asked === true;
    const replacement = key !== null && adds.has(key);
    reject(refusedLabel(name, input, key), "tool_refused", asked && !replacement);
    if (asked && replacement) notices.add(t.reminderAttemptFailed);
    if (isSchedule) keepCancelled(key, asked);
  }
  const fresh = [...adds.keys()].filter((key) => !cancelled.has(key));
  for (const key of fresh.slice(Math.max(0, fresh.length - remindersOverCap(pending.values())))) {
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
  let lateNotice: string | null = null;
  if (late && agentTexts.length > 0) {
    const written = out.lateNotice?.trim();
    lateNotice = written ? fit(written, TURN.maxLateNoticeChars, "late_notice") : t.lateFallback(human(late.dueAt, view.tz));
    agentTexts[0] = `${lateNotice}\n${agentTexts[0]}`;
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
  const [lead, ...rest] = texts;
  const delivered = view.batch.items[0].catchUp && lead !== undefined ? [`${t.catchUp}\n${lead}`, ...rest] : texts;

  const effects = lifecycleEffects(view);
  const input = { kind: "input" } as const;
  const turns = personTurns(view, input);
  const note = said.length > 0 ? triggerNote(first, view.tz) : null;
  if (note !== null) turns.push({ role: "note", text: note, at: view.now, eventKey: view.batch.items[0].key, boxView: batchWhole(view)[0] === true ? input : undefined });
  for (const [i, text] of agentTexts.entries()) {
    turns.push({ role: "agent", text, at: view.now, eventKey: view.batch.items[0].key, boxView: { kind: "reply", notice: i === 0 ? lateNotice : null } });
  }
  if (noticeText !== null) turns.push({ role: "note", text: noticeText, at: view.now, eventKey: view.batch.items[0].key });
  if (plan !== null) turns.push({ role: "agent", text: plan, at: view.now, eventKey: view.batch.items[0].key, boxView: { kind: "reply", notice: null } });
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
    outbound: outbound(delivered, askedOf(intent, purposeOf(view, tasks, link)), view, { link, choice: plan === null ? null : "accept_pending" }),
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
  | { readonly kind: "over_cap"; readonly scope: "byok" | "included" | "included_ceiling"; readonly capUsd: string; readonly alreadyToldToday: boolean; readonly catchUpBudget?: string | null }
  | { readonly kind: "no_access"; readonly text: string; readonly alreadyToldToday: boolean; readonly waitForConnection?: boolean }
  | { readonly kind: "lapsed"; readonly alreadyToldToday: boolean }
  | { readonly kind: "model_failed" }
  | { readonly kind: "too_long" }
  | { readonly kind: "poison" }
  | { readonly kind: "command"; readonly text: string; readonly note: string }
  | { readonly kind: "feedback"; readonly text: string }
  /** The model flagged a forget: only the fixed offer goes out, and nothing else the turn did is kept. */
  | { readonly kind: "forget_offer" }
  | { readonly kind: "admission"; readonly commit: AdmissionCommit; readonly text: string | null; readonly consent: boolean };

export function bypassModel(view: TurnView): Extract<NoModelReason, { kind: "block" | "stale_lifecycle" }> | null {
  const e = trigger(view);
  if (e.kind !== "lifecycle") return null;
  if (e.at < view.statusAt) return { kind: "stale_lifecycle" };
  return e.change === "block" ? { kind: "block" } : null;
}

/** What the person must do before anyone answers, which a follow needs too: it is the first thing a new person sends. */
function accessNotice(view: TurnView, notice: string | null): string | null {
  const e = trigger(view);
  return e.kind === "lifecycle" && e.change === "follow" ? notice : textWithoutModel(view, notice);
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
  const replyOutsideBeta = why.kind === "command" && !mayspend(view.admission);
  const keepInHistory = why.kind !== "feedback" && !replyOutsideBeta;
  const waitForAccess: TurnCommit["waitForAccess"] =
    why.kind === "no_access" && why.waitForConnection ? { kind: "connection" }
    : why.kind === "over_cap" && why.catchUpBudget != null ? { kind: "budget", budget: why.catchUpBudget }
    : undefined;
  const fx = keepInHistory && why.kind !== "forget_offer" ? taskEffects(view) : { commit: NO_TASKS, replies: [] };
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
      text = accessNotice(view, why.alreadyToldToday ? null : notice);
      break;
    }
    case "no_access":
      outcome = "no_access";
      text = accessNotice(view, why.alreadyToldToday ? null : why.text);
      break;
    case "lapsed":
      outcome = "lapsed";
      text = accessNotice(view, why.alreadyToldToday ? null : t.lapsed);
      break;
    case "model_failed":
    case "poison":
      outcome = why.kind;
      text = textWithoutModel(view, t.failed);
      break;
    case "too_long":
      outcome = "too_long";
      text = textWithoutModel(view, t.tooLong);
      break;
    case "command":
      outcome = "no_model";
      text = why.text;
      note = why.note;
      break;
    case "feedback":
      outcome = "no_model";
      text = why.text;
      break;
    case "forget_offer":
      outcome = "no_model";
      text = FORGET_TEXT[view.language].offer;
      break;
    case "admission":
      return planAdmissionTurn(view, why);
    default:
      return assertNever(why);
  }
  const confirmed = fx.replies.map((r) => acceptNotice(t, r));
  const joined = (lead: string | null) => [lead, ...confirmed].filter((x) => x !== null).join("\n") || null;
  const said = joined(text);
  const turns = keepInHistory && !waitForAccess ? personTurns(view) : [];
  const kept = joined(note ?? text);
  if (keepInHistory && kept !== null) turns.push({ role: "note", text: kept, at: view.now, eventKey: view.batch.items[0].key });
  const out = outbound(said === null ? [] : [said], askedOf(intentOf(trigger(view)), purposeOf(view, fx.commit, null)), view, { link: null, choice: null });
  return {
    batchKeys: batchKeys(view),
    outcome,
    ...(waitForAccess ? { waitForAccess } : {}),
    turns,
    outbound: out && replyOutsideBeta ? { ...out, replyOnly: true } : out,
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
  const out = outbound(why.text === null ? [] : [why.text], { intent: "reply" }, view, { link: null, choice: why.consent ? "consent" : null });
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

/**
 * What a turn's model call cost; its model_call rows were written when each attempt settled. `historyTrimmed`: some
 * turn not yet in the summary was left out of the prompt.
 */
export type TurnCall = { readonly kind: "served"; readonly costMicro: MicroUsd; readonly historyTrimmed: boolean } | { readonly kind: "none" };

export function logsForTurn(input: {
  readonly agent: AgentKey;
  readonly commit: TurnCommit;
  readonly view: TurnView;
  readonly call: TurnCall;
  readonly startedAt: EpochMs;
  readonly now: EpochMs;
}): LogRow[] {
  const { agent, commit, view, call } = input;
  const first = view.batch.items[0];
  const turnId = first.catchUp ? `${agent}|${first.key}|catch-up:${input.startedAt}:${commit.outcome}` : `${agent}|${first.key}`;
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
      historyTrimmed: call.kind === "served" && call.historyTrimmed,
      attempts: Math.max(...view.batch.items.map((i) => i.attempts)),
      startedAt: input.startedAt,
      finishedAt: input.now,
    },
  ];
  rows.push(
    ...commit.rejected.map((r, i): LogRow => ({ stream: "rejection", id: `${turnId}|${i}`, agent, turnId, reason: r.reason, at: input.now })),
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
