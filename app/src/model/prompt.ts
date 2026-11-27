/** A prompt as plain data, so it crosses a DO RPC, and so each route can fit it to its own budget. */
export type PromptSection = {
  readonly title: string;
  /** Always sent whole; the renderer caps them. */
  readonly keep: readonly string[];
  /** Oldest first. */
  readonly trim: readonly string[];
  /** Drop from the end to retain the start of a catch-up page. */
  readonly trimNewest?: boolean;
  /** Lower ranks lose lines first. */
  readonly dropRank: number;
  /** The conversation not yet in the summary, whose cut lines a turn log reports. */
  readonly history?: boolean;
};
export type PromptParts = { readonly sections: readonly PromptSection[] };

const utf8 = new TextEncoder();
export const bytesOf = (s: string): number => utf8.encode(s).length;

const SEPARATOR = "\n\n";
const cutLine = (n: number, newest: boolean | undefined) => `(${n} ${newest ? "later" : "earlier"} ${n === 1 ? "line" : "lines"} left out)`;

function renderSection(s: PromptSection, cut: number): string {
  const omitted = cut > 0 ? [cutLine(cut, s.trimNewest)] : [];
  const lines = s.trimNewest
    ? [...s.keep, ...s.trim.slice(0, s.trim.length - cut), ...omitted]
    : [...s.keep, ...omitted, ...s.trim.slice(cut)];
  return lines.length === 0 ? `## ${s.title}` : `## ${s.title}\n${lines.join("\n")}`;
}

export function renderPrompt(parts: PromptParts, cuts: readonly number[] = []): string {
  return parts.sections.map((s, i) => renderSection(s, cuts[i] ?? 0)).join(SEPARATOR);
}

/** Pure. Keeps every kept line, then drops trimmable lines lowest rank first until the prompt fits. */
export function fitPrompt(parts: PromptParts, budgetBytes: number): string {
  return fitSections(parts, budgetBytes).text;
}

/** `historyCut`: lines dropped from a history section. */
export function fitSections(parts: PromptParts, budgetBytes: number): { readonly text: string; readonly historyCut: number } {
  const cuts = fitCuts(parts, budgetBytes);
  return { text: renderPrompt(parts, cuts), historyCut: parts.sections.reduce((sum, s, i) => sum + (s.history ? cuts[i] : 0), 0) };
}

function fitCuts(parts: PromptParts, budgetBytes: number): number[] {
  const cuts = parts.sections.map(() => 0);
  let size = bytesOf(renderPrompt(parts));
  if (size <= budgetBytes) return cuts;
  const order = parts.sections.map((s, i) => ({ s, i })).sort((a, b) => a.s.dropRank - b.s.dropRank);
  for (const { s, i } of order) {
    while (size > budgetBytes && cuts[i] < s.trim.length) {
      const before = cuts[i] === 0 ? 0 : bytesOf(cutLine(cuts[i], s.trimNewest)) + 1;
      const dropped = s.trim[s.trimNewest ? s.trim.length - cuts[i] - 1 : cuts[i]];
      cuts[i]++;
      size += bytesOf(cutLine(cuts[i], s.trimNewest)) + 1 - before - (bytesOf(dropped) + 1);
    }
    if (size <= budgetBytes) break;
  }
  return cuts;
}
