import { z } from "zod";
import type { TurnRow } from "./turn";

const KEEP_TURNS = 30;
const FOLD_TURNS = 30;

/**
 * Compaction folds one page of the oldest turns once more than keep + fold are unfolded, and a turn prompt shows
 * every unfolded turn up to one page more than that, so a drain can add a page of turns before its compaction runs
 * without any turn falling between the summary and the prompt.
 */
export const COMPACTION = {
  foldTurns: FOLD_TURNS,
  triggerTurns: KEEP_TURNS + FOLD_TURNS,
  promptTurns: KEEP_TURNS + 2 * FOLD_TURNS,
  maxNotes: 40,
  foldNotes: 40,
  maxSummaryChars: 4_000,
} as const;

export const CompactionOutputSchema = z.object({ summary: z.string().min(1).max(COMPACTION.maxSummaryChars) });

export type CompactionInput = {
  readonly summary: string;
  readonly throughSeq: number;
  readonly turnCount: number;
  readonly oldestTurns: readonly (TurnRow & { readonly seq: number })[];
  readonly noteCount: number;
  readonly oldestNotes: readonly { readonly id: number; readonly text: string }[];
};

export type CompactionPlan = {
  readonly expectThroughSeq: number;
  readonly foldThroughSeq: number;
  readonly foldNoteIds: readonly number[];
  readonly user: string;
};

const SPEAKER: Readonly<Record<TurnRow["role"], string>> = { person: "Person", agent: "Assistant", note: "Note" };

export const compactionDue = (turnCount: number, noteCount: number): boolean =>
  turnCount > COMPACTION.triggerTurns || noteCount > COMPACTION.maxNotes;

export function planCompaction(input: CompactionInput): CompactionPlan | null {
  if (!compactionDue(input.turnCount, input.noteCount)) return null;
  const overTurns = input.turnCount > COMPACTION.triggerTurns;
  const overNotes = input.noteCount > COMPACTION.maxNotes;

  const folded = overTurns ? input.oldestTurns.slice(0, COMPACTION.foldTurns) : [];
  const foldedNotes = overNotes
    ? input.oldestNotes.slice(0, Math.min(COMPACTION.foldNotes, input.noteCount - COMPACTION.maxNotes / 2))
    : [];
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
