import type {
  EpochMs,
  FactCause,
  ProposalId,
  TaskFact,
  TaskId,
  TaskKind,
  TaskRef,
  TaskStatus,
} from "../domain";
import type { Batch } from "./turn";

export const TASKS = {
  maxOps: 3,
  maxOpen: 20,
  maxTitleChars: 80,
  maxPlanChars: 1500,
  minPlanLines: 2,
  minPlanChars: 80,
  typedAcceptWithinMs: 48 * 60 * 60 * 1000,
} as const;

/** One task op as the model returns it. Every field is always present, so the schema stays plain. */
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

/** A proposal an accept tap in the batch names, as the store holds it. */
export type TappedProposal = {
  readonly id: ProposalId;
  readonly task: TaskId;
  readonly version: number;
  readonly status: ProposalStatus;
  readonly taskStatus: TaskStatus;
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

/** What code tells the person about a tap or a typed accept, in the same reply. */
export type AcceptReply = { readonly kind: "accepted"; readonly title: string } | { readonly kind: "plan_changed" };

export type TaskEffects = { readonly commit: TaskCommit; readonly replies: readonly AcceptReply[] };

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
  void view;
  throw new Error("not implemented");
}

/** Checks the model's task ops against the open tasks after `taskEffects`, and returns both merged. */
export function planTasks(
  ops: readonly TaskOp[],
  view: TaskView,
  cause: FactCause,
  after: TaskCommit,
): { readonly commit: TaskCommit; readonly rejected: readonly { readonly action: string; readonly reason: TaskRejection | "too_long" }[] } {
  void ops;
  void view;
  void cause;
  void after;
  throw new Error("not implemented");
}

/**
 * The outbound message's task, by fixed precedence: the task proposed this turn, then the firing wake-up's task
 * if still open, then the model's `about` if it names an open task, one opened this turn or one completed this turn.
 */
export function linkOf(view: TaskView, tasks: TaskCommit, about: string): TaskTarget | null {
  void view;
  void tasks;
  void about;
  throw new Error("not implemented");
}

/** Code decides purpose; the model never labels it. */
export function purposeOf(view: TaskView, tasks: TaskCommit, link: TaskTarget | null): UnaskedPurpose | null {
  void view;
  void tasks;
  void link;
  throw new Error("not implemented");
}

/** Typed acceptance: a closed vocabulary in English and Thai, after polite particles and punctuation are stripped. */
export function isPlainAccept(text: string): boolean {
  void text;
  throw new Error("not implemented");
}

/** The status transition, in one place. completed, closed and expired are final. */
export function nextStatus(s: TaskStatus, f: TaskFact["kind"]): TaskStatus {
  void s;
  void f;
  throw new Error("not implemented");
}
