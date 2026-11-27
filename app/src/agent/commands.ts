import type { AgentEvent } from "../domain";

export type Command =
  | { readonly kind: "claude" }
  | { readonly kind: "claude_remove" }
  | { readonly kind: "key" }
  | { readonly kind: "key_remove" }
  | { readonly kind: "key_cap"; readonly usd: number }
  | { readonly kind: "key_backup"; readonly on: boolean }
  /** A message code redacted because it looked like an API key; it never reaches a model. */
  | { readonly kind: "pasted_key" }
  | { readonly kind: "plan" }
  | { readonly kind: "feedback"; readonly submitted: boolean }
  | { readonly kind: "memory" }
  | { readonly kind: "memory_next" }
  | { readonly kind: "invite" }
  | { readonly kind: "join"; readonly code: string }
  | { readonly kind: "leave" };

const EXACT: ReadonlyMap<string, Command> = new Map(
  (["claude", "plan", "invite", "leave"] as const).map((kind): [string, Command] => [`/${kind}`, { kind }]),
);

const KEY: ReadonlyMap<string, Command> = new Map<string, Command>([
  ["/claude remove", { kind: "claude_remove" }],
  ["/key", { kind: "key" }],
  ["/key remove", { kind: "key_remove" }],
  ["/key backup on", { kind: "key_backup", on: true }],
  ["/key backup off", { kind: "key_backup", on: false }],
  ["/memory", { kind: "memory" }],
  ["/memory next", { kind: "memory_next" }],
]);

export function commandOf(e: AgentEvent): Command | null {
  if (e.kind !== "message" || e.edited) return null;
  const trimmed = e.text.trim();
  const feedback = /^\/feedback(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (feedback) return { kind: "feedback", submitted: feedback[1] !== undefined };
  if (e.redacted) return { kind: "pasted_key" };
  const text = trimmed.replace(/\s+/g, " ");
  const join = text.match(/^\/join ([A-Za-z0-9]{4,16})$/);
  const cap = text.match(/^\/key cap \$?(\d{1,4}(?:\.\d{1,2})?)$/);
  return EXACT.get(text) ?? KEY.get(text.toLowerCase()) ?? (join ? { kind: "join", code: join[1].toUpperCase() } : cap ? { kind: "key_cap", usd: Number(cap[1]) } : null);
}
