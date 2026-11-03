import type { AgentEvent } from "../domain";

export type Command =
  | { readonly kind: "claude" }
  | { readonly kind: "plan" }
  | { readonly kind: "invite" }
  | { readonly kind: "join"; readonly code: string }
  | { readonly kind: "leave" };

const EXACT: ReadonlyMap<string, Command> = new Map(
  (["claude", "plan", "invite", "leave"] as const).map((kind): [string, Command] => [`/${kind}`, { kind }]),
);

export function commandOf(e: AgentEvent): Command | null {
  if (e.kind !== "message") return null;
  const text = e.text.trim();
  const join = text.match(/^\/join\s+([A-Za-z0-9]{4,16})$/);
  return EXACT.get(text) ?? (join ? { kind: "join", code: join[1].toUpperCase() } : null);
}
