import {
  FACTS,
  assertNever,
  clip,
  clipBytes,
  intentOf,
  parseTaskRef,
  type EpochMs,
  type FactCause,
  type FactKind,
  type ProposalId,
  type TaskFact,
  type TaskId,
  type TaskKind,
  type TaskRef,
  type TaskStatus,
} from "../domain";
import type { Batch } from "./turn";

export const TASKS = {
  maxOps: 3,
  maxOpen: 20,
  maxTitleBytes: 80,
  maxPlanChars: 1500,
  minPlanLines: 2,
  minPlanChars: 80,
  acceptWithinMs: 48 * 60 * 60 * 1000,
} as const;

export type TaskOp = {
  readonly op: "open" | "propose" | "close";
  readonly ref: string;
  readonly kind: TaskKind;
  readonly title: string;
  readonly plan: string;
};

export type OpenTask = {
  readonly id: TaskId;
  readonly ref: TaskRef;
  readonly kind: TaskKind;
  readonly title: string;
  readonly proposal: ProposalId | null;
};

/** The open proposal on the newest agent message that was delivered. */
export type AcceptableProposal = { readonly id: ProposalId; readonly task: TaskId; readonly version: number; readonly sentAt: EpochMs };

export const PROPOSAL_STATUSES = ["open", "accepted", "superseded", "closed"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export type TappedProposal = {
  readonly id: ProposalId;
  readonly task: TaskId;
  readonly version: number;
  readonly status: ProposalStatus;
  readonly taskStatus: TaskStatus;
  readonly sentAt: EpochMs | null;
};

export type TaskView = {
  readonly now: EpochMs;
  readonly batch: Batch;
  readonly openTasks: readonly OpenTask[];
  readonly acceptable: AcceptableProposal | null;
  readonly tapped: readonly TappedProposal[];
};

export type TaskTarget = { readonly ref: TaskRef } | { readonly id: TaskId };
export type TaskFactInput = { readonly target: TaskTarget; readonly fact: TaskFact };

export type TaskCommit = {
  readonly open: readonly { readonly ref: TaskRef; readonly kind: TaskKind; readonly title: string }[];
  /** The store binds it to this turn's outbox row and supersedes the task's open proposal. */
  readonly propose: { readonly ref: TaskRef; readonly text: string } | null;
  readonly facts: readonly TaskFactInput[];
};

export const NO_TASKS: TaskCommit = { open: [], propose: null, facts: [] };

export type AcceptReply = { readonly kind: "accepted"; readonly title: string } | { readonly kind: "plan_changed" };

export type TaskEffects = { readonly commit: TaskCommit; readonly replies: readonly AcceptReply[] };

function withinAcceptWindow(sentAt: EpochMs | null, acceptedAt: EpochMs): boolean {
  const second = (t: EpochMs) => Math.floor(t / 1000);
  return sentAt !== null && second(sentAt) <= second(acceptedAt) && acceptedAt - sentAt <= TASKS.acceptWithinMs;
}

export const TASK_REJECTIONS = [
  "task_limit",
  "task_unknown",
  "task_done",
  "plan_empty",
  "plan_too_thin",
  "too_many_proposals",
  "too_many_task_ops",
] as const;
export type TaskRejection = (typeof TASK_REJECTIONS)[number];

export const UNASKED_PURPOSES = ["task_followup", "bookkeeping", "unlinked"] as const;
export type UnaskedPurpose = (typeof UNASKED_PURPOSES)[number];

/**
 * Facts code derives from the batch without the model: accept taps and typed accepts. It runs whether or not
 * the model answers, so a refused, failed or poisoned turn still records them.
 */
export function taskEffects(view: TaskView): TaskEffects {
  const facts: TaskFactInput[] = [];
  const replies: AcceptReply[] = [];
  const decided = new Set<ProposalId>();
  const titleOf = (task: TaskId) => view.openTasks.find((t) => t.id === task)?.title ?? "";
  const accept = (p: { readonly id: ProposalId; readonly task: TaskId; readonly version: number }, via: "tap" | "typed", cause: FactCause) => {
    decided.add(p.id);
    facts.push({ target: { id: p.task }, fact: { kind: "plan_accepted", ref: p.id, detail: { via, version: p.version }, cause } });
  };

  for (const item of view.batch.items) {
    const e = item.event;
    if (e.kind !== "choice" || e.choice.kind !== "accept") continue;
    const named = e.choice.proposal;
    const p = view.tapped.find((x) => x.id === named);
    if (!p || decided.has(p.id)) continue;
    const cause: FactCause = { key: item.key, kind: "choice", at: e.at };
    const tapInWindow = withinAcceptWindow(p.sentAt, e.at);
    if ((p.status === "open" || p.status === "closed") && !tapInWindow) {
      decided.add(p.id);
      if (p.status === "open") replies.push({ kind: "plan_changed" });
      continue;
    }
    switch (p.status) {
      case "open":
        accept(p, "tap", cause);
        replies.push({ kind: "accepted", title: titleOf(p.task) });
        break;
      case "closed":
        accept(p, "tap", cause);
        break;
      case "superseded":
        decided.add(p.id);
        replies.push({ kind: "plan_changed" });
        break;
      case "accepted":
        break;
      default:
        assertNever(p.status);
    }
  }

  const [first, ...rest] = view.batch.items;
  const a = view.acceptable;
  if (
    a !== null &&
    first.event.kind === "message" &&
    !decided.has(a.id) &&
    withinAcceptWindow(a.sentAt, first.receivedAt) &&
    isPlainAccept(first.event.text) &&
    !rest.some((i) => i.event.kind === "message" && rejectsOrAmends(i.event.text))
  ) {
    accept(a, "typed", { key: first.key, kind: "message", at: first.receivedAt });
    replies.push({ kind: "accepted", title: titleOf(a.task) });
  }
  return { commit: { ...NO_TASKS, facts }, replies };
}

type Finished = { readonly ids: ReadonlySet<TaskId>; readonly refs: ReadonlySet<TaskRef> };

function finishedBy(tasks: TaskCommit): Finished {
  const ids = new Set<TaskId>();
  const refs = new Set<TaskRef>();
  for (const { target, fact } of tasks.facts) {
    if (nextStatus("open", fact.kind) === "open") continue;
    if ("id" in target) ids.add(target.id);
    else refs.add(target.ref);
  }
  return { ids, refs };
}

const isFinished = (f: Finished, t: { readonly id: TaskId; readonly ref: TaskRef }) => f.ids.has(t.id) || f.refs.has(t.ref);

const isThin = (plan: string) => plan.length < TASKS.minPlanChars || plan.split("\n").filter((l) => l.trim() !== "").length < TASKS.minPlanLines;

export type TaskOpRejection = { readonly action: string; readonly reason: TaskRejection | "too_long" };

/** Checks the model's task ops against the open tasks after `taskEffects`, and returns both merged. */
export const taskOpLabel = (op: TaskOp["op"], ref: string): string => `task_${op}:${ref}`;

function nearTaskRef(a: TaskRef, b: TaskRef): boolean {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return i < a.length && (a.slice(i + 1) === b.slice(i + 1) ||
      (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)));
  }
  if (a.length === b.length + 1) return a.slice(i + 1) === b.slice(i);
  return b.length === a.length + 1 && a.slice(i) === b.slice(i + 1);
}

const nearbyRefs = (ref: TaskRef, open: Iterable<TaskRef>) => [...open].filter((candidate) => nearTaskRef(ref, candidate));

export function planTasks(
  ops: readonly TaskOp[],
  view: TaskView,
  cause: FactCause,
  after: TaskCommit,
): { readonly commit: TaskCommit; readonly rejected: readonly TaskOpRejection[] } {
  const rejected: TaskOpRejection[] = [];
  const reject = (o: TaskOp, reason: TaskOpRejection["reason"]) => rejected.push({ action: taskOpLabel(o.op, o.ref), reason });
  const finished = finishedBy(after);
  const open = new Set(view.openTasks.filter((t) => !isFinished(finished, t)).map((t) => t.ref));
  const done = new Set(view.openTasks.filter((t) => isFinished(finished, t)).map((t) => t.ref));
  const opened = [...after.open];
  const facts = [...after.facts];
  let propose = after.propose;

  const ensureOpen = (o: TaskOp, ref: TaskRef): boolean => {
    if (done.has(ref)) {
      reject(o, "task_done");
      return false;
    }
    if (open.has(ref) || opened.some((t) => t.ref === ref)) return true;
    if (open.size + opened.length >= TASKS.maxOpen) {
      reject(o, "task_limit");
      return false;
    }
    const title = o.title.trim() || ref;
    opened.push({ ref, kind: o.kind, title: clipBytes(title, TASKS.maxTitleBytes) });
    return true;
  };

  ops.forEach((o, i) => {
    if (i >= TASKS.maxOps) return reject(o, "too_many_task_ops");
    let ref = parseTaskRef(o.ref);
    if (ref === null) return reject(o, "task_unknown");
    if (o.op !== "close" && !open.has(ref) && !done.has(ref) && !opened.some((t) => t.ref === ref)) {
      const matches = nearbyRefs(ref, open);
      if (matches.length > 1) return reject(o, "task_unknown");
      if (matches.length === 1) ref = matches[0];
    }
    switch (o.op) {
      case "open":
        ensureOpen(o, ref);
        return;
      case "propose": {
        if (propose !== null) return reject(o, "too_many_proposals");
        if (!ensureOpen(o, ref)) return;
        const plan = o.plan.trim();
        if (plan === "") return reject(o, "plan_empty");
        if (isThin(plan)) return reject(o, "plan_too_thin");
        if (plan.length > TASKS.maxPlanChars) reject(o, "too_long");
        propose = { ref, text: plan.length > TASKS.maxPlanChars ? clip(plan, TASKS.maxPlanChars) : plan };
        return;
      }
      case "close":
        if (done.has(ref)) return reject(o, "task_done");
        if (!open.has(ref) && !opened.some((t) => t.ref === ref)) return reject(o, "task_unknown");
        facts.push({ target: { ref }, fact: { kind: "closed", ref: "", detail: {}, cause } });
        return;
      default:
        return assertNever(o.op);
    }
  });
  return { commit: { open: opened, propose, facts }, rejected };
}

/**
 * The outbound message's task, by fixed precedence: the task proposed this turn, then the firing wake-up's task
 * if still open, then the model's `about` if it names an open task, one opened this turn or one finished this turn.
 */
export function linkOf(view: TaskView, tasks: TaskCommit, about: string): TaskTarget | null {
  if (tasks.propose) return { ref: tasks.propose.ref };
  const finished = finishedBy(tasks);
  const e = view.batch.items[0].event;
  if (e.kind === "wakeup" && e.task !== null) {
    const task = view.openTasks.find((t) => t.id === e.task);
    if (task && !isFinished(finished, task)) return { id: task.id };
  }
  const ref = parseTaskRef(about);
  if (ref === null) return null;
  if (tasks.open.some((t) => t.ref === ref)) return { ref };
  const known = view.openTasks.find((t) => t.ref === ref);
  if (known) return isFinished(finished, known) ? { id: known.id } : { ref };
  const matches = nearbyRefs(ref, view.openTasks.filter((t) => !isFinished(finished, t)).map((t) => t.ref));
  return matches.length === 1 ? { ref: matches[0] } : null;
}

/** The task a ref the model named stands for: one opened this turn, or one still open after it. */
export function taskOf(view: TaskView, tasks: TaskCommit, raw: string): TaskTarget | null {
  const ref = parseTaskRef(raw);
  if (ref === null) return null;
  if (tasks.open.some((t) => t.ref === ref)) return { ref };
  const known = view.openTasks.find((t) => t.ref === ref);
  return known && !isFinished(finishedBy(tasks), known) ? { id: known.id } : null;
}

/**
 * Code decides purpose; the model never labels it. Only an unasked message has one: a check code scheduled is
 * bookkeeping, a message on a task still open after this turn is a follow-up, one on a task that finished is
 * bookkeeping, and one with no task is unlinked.
 */
export function purposeOf(view: TaskView, tasks: TaskCommit, link: TaskTarget | null): UnaskedPurpose | null {
  const e = view.batch.items[0].event;
  if (intentOf(e) !== "unasked") return null;
  if (e.kind === "wakeup" && e.bookkeeping) return "bookkeeping";
  if (link === null) return "unlinked";
  if ("ref" in link && tasks.open.some((t) => t.ref === link.ref)) return "task_followup";
  const finished = finishedBy(tasks);
  const task = view.openTasks.find((t) => ("id" in link ? t.id === link.id : t.ref === link.ref));
  return task && !isFinished(finished, task) ? "task_followup" : "bookkeeping";
}

const ACCEPT_WORDS: ReadonlySet<string> = new Set([
  ...["ok", "okay", "okey", "oke", "k", "kk", "yes", "yep", "yeah", "yup", "sure", "good", "great", "perfect", "deal", "agreed"],
  ...["accept", "accepted", "sounds good", "looks good", "go", "go ahead", "do it", "lets do it", "lets go", "👍", "👌"],
  ...["โอเค", "โอเคเลย", "ตกลง", "ได้", "ได้เลย", "เอา", "เอาเลย", "ใช่", "จัดไป", "ดีเลย"],
]);
const ROMAN_PARTICLES: ReadonlySet<string> = new Set(["ka", "kha", "krub", "krab", "khrap", "na", "naa", "ja", "jaa", "please", "pls", "thanks", "thx"]);
const THAI_PARTICLES = ["นะคะ", "นะครับ", "ค่ะ", "คะ", "ค่า", "ค้า", "ครับ", "คับ", "จ้ะ", "จ้า", "ฮะ", "นะ"] as const;

const AMEND_WORDS: ReadonlySet<string> = new Set(["but", "no", "not", "change", "instead"]);
const THAI_AMEND = ["แต่", "ไม่", "เปลี่ยน"] as const;

/** A later message in an accepting batch that takes the yes back or changes the plan: one closed list in both languages. */
export function rejectsOrAmends(text: string): boolean {
  const words = text.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u);
  return words.some((w) => AMEND_WORDS.has(w)) || THAI_AMEND.some((w) => text.includes(w));
}

/** Typed acceptance: a closed vocabulary in English and Thai, after polite particles and punctuation are stripped. */
export function isPlainAccept(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[.,!?~…:;"()-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "");
  while (tokens.length > 1 && ROMAN_PARTICLES.has(tokens[tokens.length - 1])) tokens.pop();
  let s = tokens.join(" ");
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const p of THAI_PARTICLES) {
      if (s.length > p.length && s.endsWith(p)) {
        s = s.slice(0, -p.length).trim();
        stripped = true;
      }
    }
  }
  return ACCEPT_WORDS.has(s);
}

/** The status transition, in one place. completed, closed and expired are final. */
export function nextStatus(s: TaskStatus, f: FactKind): TaskStatus {
  if (s !== "open") return s;
  if (FACTS[f].completes) return "completed";
  return f === "closed" || f === "expired" ? f : "open";
}

