import type { AgentEvent } from "../domain";

export type Command =
  | { readonly kind: "claude" }
  | { readonly kind: "key" }
  | { readonly kind: "key_remove" }
  | { readonly kind: "key_cap"; readonly usd: number }
  | { readonly kind: "key_backup"; readonly on: boolean }
  /** A message code redacted because it looked like an API key; it never reaches a model. */
  | { readonly kind: "pasted_key" }
  | { readonly kind: "plan" }
  | { readonly kind: "invite" }
  | { readonly kind: "join"; readonly code: string }
  | { readonly kind: "leave" };

const EXACT: ReadonlyMap<string, Command> = new Map(
  (["claude", "plan", "invite", "leave"] as const).map((kind): [string, Command] => [`/${kind}`, { kind }]),
);

const KEY: ReadonlyMap<string, Command> = new Map<string, Command>([
  ["/key", { kind: "key" }],
  ["/key remove", { kind: "key_remove" }],
  ["/key backup on", { kind: "key_backup", on: true }],
  ["/key backup off", { kind: "key_backup", on: false }],
]);

export function commandOf(e: AgentEvent): Command | null {
  if (e.kind !== "message") return null;
  if (e.redacted) return { kind: "pasted_key" };
  const text = e.text.trim().replace(/\s+/g, " ");
  const join = text.match(/^\/join ([A-Za-z0-9]{4,16})$/);
  const cap = text.match(/^\/key cap \$?(\d{1,4}(?:\.\d{1,2})?)$/);
  return EXACT.get(text) ?? KEY.get(text.toLowerCase()) ?? (join ? { kind: "join", code: join[1].toUpperCase() } : cap ? { kind: "key_cap", usd: Number(cap[1]) } : null);
}
