import { z } from "zod";
import { TURN, type TurnRow } from "./turn";

export const COMPACTION = {
  triggerTurns: 60,
  keepTurns: TURN.recentTurns,
  maxNotes: 40,
} as const;

export const CompactionOutputSchema = z.object({ summary: z.string().min(1).max(12_000) });

export type CompactionInput = {
  readonly summary: string;
  readonly throughSeq: number;
  readonly turns: readonly (TurnRow & { readonly seq: number })[];
  readonly notes: readonly { readonly id: number; readonly text: string }[];
};

export type CompactionPlan = {
  readonly expectThroughSeq: number;
  readonly foldThroughSeq: number;
  readonly foldNoteIds: readonly number[];
  readonly user: string;
};

const SPEAKER: Readonly<Record<TurnRow["role"], string>> = { person: "Person", agent: "Assistant", note: "Note" };

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
