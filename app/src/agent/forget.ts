import type { EpochMs, ForgetEpoch, InboundEnvelope } from "../domain";

/**
 * Where an event sits in its provider's own order. `seq` orders events that share one `at`: Telegram's update_id within
 * one second. It is null where the provider gives no order, so an event at the same time can't be told apart.
 */
export type ProviderOrder = { readonly at: EpochMs; readonly seq: number | null };

/** Work holds the epoch it started under; `live()` is false once a forget began after it, or while one is open. */
export type Claim = { readonly epoch: ForgetEpoch; readonly live: () => boolean };

export type ForgetState = { readonly epoch: ForgetEpoch; readonly op: string | null; readonly cutoff: ProviderOrder | null };

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

export function laterCutoff(a: ProviderOrder | null, b: ProviderOrder): ProviderOrder {
  return a === null || atOrBefore(a, b) ? b : a;
}
