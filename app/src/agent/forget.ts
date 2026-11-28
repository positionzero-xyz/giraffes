import type { EpochMs, ForgetEpoch, InboundEnvelope } from "../domain";

/**
 * Where an event sits in its provider's own order. `seq` orders events that share one `at`: Telegram's update_id within
 * one second. It is null where the provider gives no order, so an event at the same time can't be told apart.
 */
export type ProviderOrder = { readonly at: EpochMs; readonly seq: number | null };

/** Work holds the epoch it started under; `live()` is false once a forget began after it, or while one is open. */
export type Claim = { readonly epoch: ForgetEpoch; readonly live: () => boolean };

export type ForgetState = {
  readonly epoch: ForgetEpoch;
  readonly op: string | null;
  readonly cutoff: ProviderOrder | null;
  readonly completedAt: EpochMs | null;
};

/**
 * The provider's own place for an event, read from the fields each channel fills in: LINE's signed event time, Telegram's
 * message date with its update_id, the dev channel's time. A Telegram tap carries no time of its own, so it has none and
 * only the epoch its button names can let it through.
 */
export function providerOrder(e: InboundEnvelope): ProviderOrder | null {
  if (e.identity.channel !== "telegram") return { at: e.receivedAt, seq: null };
  if (e.event.kind === "choice") return null;
  const updateId = /^tg:(\d+)$/.exec(e.key)?.[1];
  return { at: e.receivedAt, seq: updateId === undefined ? null : Number(updateId) };
}

/** True when `o` is at or before the cutoff. Without an order between two events at the same time, the later one counts as before. */
export function atOrBefore(o: ProviderOrder, cutoff: ProviderOrder): boolean {
  if (o.at !== cutoff.at) return o.at < cutoff.at;
  return o.seq === null || cutoff.seq === null || o.seq <= cutoff.seq;
}

/** An event the person's last forget already covers, refused before its body is stored. */
export function coveredByForget(e: InboundEnvelope, state: ForgetState): boolean {
  if (e.event.kind === "choice" && (e.event.epoch ?? 0) !== state.epoch) return true;
  const order = providerOrder(e);
  return order !== null && state.cutoff !== null && atOrBefore(order, state.cutoff);
}

/** Quotes have no update ID to order them within the cutoff's second. Older inbox rows may have no quote date. */
export function quoteAfterForget(at: EpochMs, state: ForgetState): boolean {
  return Number.isSafeInteger(at) && at > Math.max(state.cutoff?.at ?? 0, state.completedAt ?? 0);
}

export function laterCutoff(a: ProviderOrder | null, b: ProviderOrder): ProviderOrder {
  return a === null || atOrBefore(a, b) ? b : a;
}

/** What a `/forget` message asks for. Only the code and the numbers are read; any other words are dropped. */
export type ForgetCommand =
  | { readonly kind: "start" }
  | { readonly kind: "all" }
  | { readonly kind: "next" }
  | { readonly kind: "status" }
  | { readonly kind: "choose"; readonly code: string; readonly numbers: readonly number[] }
  | { readonly kind: "help" };

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE = /^#[A-Z0-9]{6}$/;

/** A fresh confirmation code, such as "#K7Q2MX": a `#` no plain word starts with, and six letters and digits. */
export function newForgetCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `#${Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("")}`;
}

export function forgetCommandOf(text: string): ForgetCommand | null {
  const words = text.trim().split(/\s+/);
  if (words[0]?.toLowerCase() !== "/forget") return null;
  const rest = words.slice(1);
  const one = rest.length === 1 ? rest[0].toLowerCase() : null;
  if (one === "all" || one === "next" || one === "status") return { kind: one };
  if (!rest[0]?.startsWith("#")) return { kind: "start" };
  const code = rest[0].toUpperCase();
  const picks = rest.slice(1).join(" ").toLowerCase();
  if (!CODE.test(code) || picks === "") return { kind: "help" };
  if (picks === "done") return { kind: "choose", code, numbers: [] };
  const numbers = picks.split(/[\s,]+/).filter((n) => n !== "");
  if (!numbers.every((n) => /^\d{1,4}$/.test(n))) return { kind: "help" };
  return { kind: "choose", code, numbers: [...new Set(numbers.map(Number))].sort((a, b) => a - b) };
}
