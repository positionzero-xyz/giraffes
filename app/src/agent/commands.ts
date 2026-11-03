import type { AgentEvent } from "../domain";

/** Texts that run without the model. Each is claimed as a batch of its own, so the model never sees one. */
export type Command = { readonly kind: "claude" };

const EXACT: ReadonlyMap<string, Command> = new Map([["/claude", { kind: "claude" }]]);

export function commandOf(e: AgentEvent): Command | null {
  if (e.kind !== "message") return null;
  return EXACT.get(e.text.trim()) ?? null;
}
