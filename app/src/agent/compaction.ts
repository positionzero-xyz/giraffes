import { z } from "zod";
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
  maxSummaryBytes: 4_000,
} as const;

export const CompactionOutputSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe(`At most ${COMPACTION.maxSummaryBytes} bytes of UTF-8: about ${COMPACTION.maxSummaryBytes} English or ${Math.floor(COMPACTION.maxSummaryBytes / 3)} Thai characters.`)
    .refine((s) => bytesOf(s) <= COMPACTION.maxSummaryBytes, `At most ${COMPACTION.maxSummaryBytes} bytes of UTF-8.`),
});

export type CompactionInput = {
  readonly summary: string;
  readonly throughSeq: number;
  /** Turns not yet in the summary. */
  readonly turnCount: number;
  /**
   * Oldest first. Rows at or below `throughSeq` are long ones a placeholder stands for, kept until a page can take them.
   * A transient row is from a turn the person asked not to be remembered.
   */
  readonly oldestTurns: readonly (TurnRow & { readonly seq: number; readonly transient: boolean })[];
  readonly noteCount: number;
  readonly oldestNotes: readonly { readonly id: number; readonly text: string }[];
};

export type CompactionPlan = {
  readonly expectThroughSeq: number;
  readonly foldThroughSeq: number;
  /** The turns the model saw whole; only these rows are deleted. */
  readonly foldSeqs: readonly number[];
  readonly foldNoteIds: readonly number[];
  readonly prompt: PromptParts;
};

const SPEAKER: Readonly<Record<TurnRow["role"], string>> = { person: "Person", agent: "Assistant", note: "Note" };

export const compactionDue = (turnCount: number, noteCount: number): boolean =>
  turnCount > COMPACTION.triggerTurns || noteCount > COMPACTION.maxNotes;

const section = (title: string, lines: readonly string[]): PromptSection => ({ title, keep: lines.length ? lines : ["(none)"], trim: [], dropRank: 0 });
const stamp = (t: TurnRow) => new Date(t.at).toISOString().slice(0, 16);
const turnLine = (t: TurnRow, text: string = t.text) => `[${stamp(t)}Z] ${SPEAKER[t.role]}: ${text}`;
const placeholder = (t: TurnRow) => turnLine(t, `[long message on ${stamp(t).slice(0, 10)}, ${bytesOf(t.text)} bytes, not summarized]`);

/**
 * Folds whole turns, oldest first, then whole notes, until `budgetBytes` is full, so everything the model is asked to
 * fold is exactly what it saw. A turn too big for even an empty page is folded as a placeholder line, and its row is
 * kept for a later page that can take it. A transient turn is deleted with the page and never shown to the model.
 * `force`: the next turn's history doesn't fit, so fold even below the trigger.
 */
export function planCompaction(input: CompactionInput, budgetBytes: number, force = false): CompactionPlan | null {
  const overTurns = input.turnCount > COMPACTION.triggerTurns || (force && input.turnCount > 0);
  const overNotes = input.noteCount > COMPACTION.maxNotes;
  if (!overTurns && !overNotes) return null;
  const maxTurns = force ? Math.min(COMPACTION.foldTurns, input.turnCount) : Math.min(COMPACTION.foldTurns, input.turnCount - KEEP_TURNS);
  const maxNotes = overNotes ? Math.min(COMPACTION.foldNotes, input.noteCount - COMPACTION.maxNotes / 2) : 0;

  const turnLines: string[] = [];
  const noteLines: string[] = [];
  const promptOf = (turns: readonly string[] = turnLines): PromptParts => ({
    sections: [section("Current summary", [input.summary || "(empty)"]), section("Turns being removed", turns), section("Notes being folded", noteLines)],
  });
  const fits = (turns: readonly string[] = turnLines) => bytesOf(renderPrompt(promptOf(turns))) <= budgetBytes;

  const foldSeqs: number[] = [];
  let foldThroughSeq = input.throughSeq;
  let taken = 0;
  for (const t of overTurns ? input.oldestTurns : []) {
    const old = t.seq <= input.throughSeq;
    if (!old && taken >= maxTurns) break;
    if (!t.transient) turnLines.push(turnLine(t));
    if (t.transient || fits()) {
      foldSeqs.push(t.seq);
    } else {
      turnLines.pop();
      if (old) continue;
      if (fits([turnLine(t)])) break;
      turnLines.push(placeholder(t));
      if (!fits()) {
        turnLines.pop();
        break;
      }
    }
    if (!old) {
      taken++;
      foldThroughSeq = t.seq;
    }
  }

  const foldNoteIds: number[] = [];
  for (const n of input.oldestNotes.slice(0, maxNotes)) {
    noteLines.push(`- ${n.text}`);
    if (!fits()) {
      noteLines.pop();
      break;
    }
    foldNoteIds.push(n.id);
  }
  if (foldThroughSeq === input.throughSeq && foldSeqs.length === 0 && foldNoteIds.length === 0) return null;
  return { expectThroughSeq: input.throughSeq, foldThroughSeq, foldSeqs, foldNoteIds, prompt: promptOf() };
}

export type CompactionCommit = {
  readonly expectThroughSeq: number;
  readonly summary: string;
  readonly throughSeq: number;
  readonly deleteSeqs: readonly number[];
  readonly deleteNoteIds: readonly number[];
};

export function compactionCommit(plan: CompactionPlan, out: z.infer<typeof CompactionOutputSchema>): CompactionCommit {
  return {
    expectThroughSeq: plan.expectThroughSeq,
    summary: out.summary,
    throughSeq: plan.foldThroughSeq,
    deleteSeqs: plan.foldSeqs,
    deleteNoteIds: plan.foldNoteIds,
  };
}
