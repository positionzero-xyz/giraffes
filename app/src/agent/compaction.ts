import { z } from "zod";
import { clip } from "../domain";
import { bytesOf, renderPrompt, type PromptParts, type PromptSection } from "../model/prompt";
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
  /** Every section is kept whole: the page was sized to the budget, so the model sees exactly what is folded. */
  readonly prompt: PromptParts;
};

const LINE_CHARS = 2_000;

const SPEAKER: Readonly<Record<TurnRow["role"], string>> = { person: "Person", agent: "Assistant", note: "Note" };

export const compactionDue = (turnCount: number, noteCount: number): boolean =>
  turnCount > COMPACTION.triggerTurns || noteCount > COMPACTION.maxNotes;

const section = (title: string, lines: readonly string[]): PromptSection => ({ title, keep: lines.length ? lines : ["(none)"], trim: [], dropRank: 0 });
const cap = (s: string) => (s.length > LINE_CHARS ? clip(s, LINE_CHARS) : s);
const turnLine = (t: TurnRow) => cap(`[${new Date(t.at).toISOString().slice(0, 16)}Z] ${SPEAKER[t.role]}: ${t.text}`);

/** Folds as many of the oldest turns as fit `budgetBytes` (at least one), so the folded range is exactly what the model saw. */
export function planCompaction(input: CompactionInput, budgetBytes: number): CompactionPlan | null {
  if (!compactionDue(input.turnCount, input.noteCount)) return null;
  const overTurns = input.turnCount > COMPACTION.triggerTurns;
  const overNotes = input.noteCount > COMPACTION.maxNotes;

  const foldedNotes = overNotes
    ? input.oldestNotes.slice(0, Math.min(COMPACTION.foldNotes, input.noteCount - COMPACTION.maxNotes / 2))
    : [];
  const page = overTurns ? input.oldestTurns.slice(0, COMPACTION.foldTurns) : [];
  const promptOf = (turns: readonly (TurnRow & { readonly seq: number })[]): PromptParts => ({
    sections: [
      section("Current summary", [input.summary || "(empty)"]),
      section("Turns being removed", turns.map(turnLine)),
      section("Notes being folded", foldedNotes.map((n) => `- ${cap(n.text)}`)),
    ],
  });
  let folded = page;
  while (folded.length > 1 && bytesOf(renderPrompt(promptOf(folded))) > budgetBytes) folded = folded.slice(0, -1);
  const lastFolded = folded.at(-1);
  return {
    expectThroughSeq: input.throughSeq,
    foldThroughSeq: lastFolded ? lastFolded.seq : input.throughSeq,
    foldNoteIds: foldedNotes.map((n) => n.id),
    prompt: promptOf(folded),
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
