/** A prompt as plain data, so it crosses a DO RPC, and so each route can fit it to its own budget. */
export type PromptSection = {
  readonly title: string;
  /** Always sent whole; the renderer caps them. */
  readonly keep: readonly string[];
  /** Oldest first; dropped from the start when the prompt is over budget. */
  readonly trim: readonly string[];
  /** Lower ranks lose lines first. */
  readonly dropRank: number;
};
export type PromptParts = { readonly sections: readonly PromptSection[] };

const utf8 = new TextEncoder();
export const bytesOf = (s: string): number => utf8.encode(s).length;

const SEPARATOR = "\n\n";
const cutLine = (n: number) => `(${n} earlier ${n === 1 ? "line" : "lines"} left out)`;

function renderSection(s: PromptSection, cut: number): string {
  const lines = [...s.keep, ...(cut > 0 ? [cutLine(cut)] : []), ...s.trim.slice(cut)];
  return lines.length === 0 ? `## ${s.title}` : `## ${s.title}\n${lines.join("\n")}`;
}

export function renderPrompt(parts: PromptParts, cuts: readonly number[] = []): string {
  return parts.sections.map((s, i) => renderSection(s, cuts[i] ?? 0)).join(SEPARATOR);
}

/** Pure. Keeps every kept line, then drops trimmable lines oldest first, lowest rank first, until the prompt fits. */
export function fitPrompt(parts: PromptParts, budgetBytes: number): string {
  throw new Error("not implemented");
}
