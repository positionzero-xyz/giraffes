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

const SPEAKER: Readonly<Record<TurnRow["role"], string>> = { person: "Person", agent: "Assistant", note: "Note" };

/** null when under both thresholds. */
export function planCompaction(input: CompactionInput): CompactionPlan | null {
  const overTurns = input.turns.length > COMPACTION.triggerTurns;
  const overNotes = input.notes.length > COMPACTION.maxNotes;
  if (!overTurns && !overNotes) return null;

  const folded = overTurns ? input.turns.slice(0, input.turns.length - COMPACTION.keepTurns) : [];
  const foldedNotes = overNotes ? input.notes.slice(0, input.notes.length - COMPACTION.maxNotes / 2) : [];
  const lastFolded = folded.at(-1);
  const turnsText = folded.map((t) => `[${new Date(t.at).toISOString().slice(0, 16)}Z] ${SPEAKER[t.role]}: ${t.text}`);
  return {
    expectThroughSeq: input.throughSeq,
    foldThroughSeq: lastFolded ? lastFolded.seq : input.throughSeq,
    foldNoteIds: foldedNotes.map((n) => n.id),
    user: [
      `Current summary:\n${input.summary || "(empty)"}`,
      `Turns being removed:\n${turnsText.join("\n") || "(none)"}`,
      `Notes being folded:\n${foldedNotes.map((n) => `- ${n.text}`).join("\n") || "(none)"}`,
    ].join("\n\n"),
  };
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
