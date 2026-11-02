/**
 * Memory compaction as pure functions. The conversation never resets: recent turns stay verbatim, older
 * turns and surplus notes are folded into one summary by a cheap model call.
 *
 * Runs after the inbox is empty, never ahead of a reply. If it is refused for budget or fails, nothing
 * breaks: the turn prompt always takes only the last TURN.recentTurns rows, so the prompt stays bounded
 * and the backlog is folded on a later drain.
 *
 * Idempotent and crash-safe: the plan records the `through_turn_seq` it started from, and the commit
 * applies only if memory still says that (compare-and-set). A crash mid-call leaves memory untouched; a
 * second run recomputes the same plan.
 */
import { z } from "zod";
import type { EpochMs } from "../domain";
import type { TurnRow } from "./turn";
import { TURN } from "./turn";

export const COMPACTION = {
  /** Compact when verbatim turns exceed this… */
  triggerTurns: 60,
  /** …folding all but the newest TURN.recentTurns. */
  keepTurns: TURN.recentTurns,
  maxNotes: 40,
} as const;

export const CompactionOutputSchema = z.object({ summary: z.string().min(1).max(12_000) });

export type CompactionInput = {
  readonly summary: string;
  readonly throughSeq: number;
  /** All verbatim turns, oldest first, with their seq. */
  readonly turns: readonly (TurnRow & { readonly seq: number })[];
  readonly notes: readonly { readonly id: number; readonly text: string }[];
};

export type CompactionPlan = {
  readonly expectThroughSeq: number;
  readonly foldThroughSeq: number;
  readonly foldNoteIds: readonly number[];
  readonly user: string; // with COMPACTION_SYSTEM from prompt.ts
};

/** null when under both thresholds. */
export function planCompaction(input: CompactionInput, now: EpochMs): CompactionPlan | null {
  // TODO: if turns.length <= triggerTurns && notes.length <= maxNotes → null
  //       foldThroughSeq = turns[turns.length - keepTurns - 1].seq   (or throughSeq if not over turn limit)
  //       foldNoteIds = oldest (notes.length - maxNotes / 2) notes when over the note cap
  //       user = "Current summary:\n…\n\nTurns being removed:\n…\n\nNotes being folded:\n…"
  throw new Error("not implemented");
}

export type CompactionCommit = {
  readonly expectThroughSeq: number;
  readonly summary: string;
  readonly throughSeq: number;
  readonly deleteNoteIds: readonly number[];
};

export function compactionCommit(plan: CompactionPlan, out: z.infer<typeof CompactionOutputSchema>): CompactionCommit {
  return {
    expectThroughSeq: plan.expectThroughSeq,
    summary: out.summary,
    throughSeq: plan.foldThroughSeq,
    deleteNoteIds: plan.foldNoteIds,
  };
}
