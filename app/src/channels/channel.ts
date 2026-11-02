/**
 * The channel port. An adapter owns everything about one messaging platform: webhook authentication,
 * payload shapes, identity extraction, reply-vs-push, idempotency headers, and error classification.
 * The core sees only `InboundEnvelope` in and `OutboundMessage` out.
 *
 * Two methods. Adding a channel means writing these two and adding its id to CHANNEL_IDS; the mapped
 * `ChannelRegistry` type then fails the build until `makeChannels` provides it.
 */
import type { ChannelId, EpochMs, InboundEnvelope, OutboundMessage } from "../domain";
import type { Config } from "../config";
import { lineChannel } from "./line";
import { telegramChannel } from "./telegram";
import { devChannel } from "./dev";

export type Received =
  /** `ignored` counts well-formed events the MVP doesn't handle (group messages, stickers-only, edits). */
  | { readonly kind: "accepted"; readonly envelopes: readonly InboundEnvelope[]; readonly ignored: number }
  | { readonly kind: "rejected"; readonly status: 401 | 404 };

export type Delivery =
  | { readonly kind: "sent"; readonly via: "reply" | "push" }
  /** Transient (429, 5xx, network). The outbox retries after `afterMs` with the same OutboxId. */
  | { readonly kind: "retry"; readonly afterMs: number; readonly detail: string }
  /** Permanent for this message (400, oversize). Dropped and logged. */
  | { readonly kind: "failed"; readonly detail: string }
  /** The platform says the person blocked the bot (Telegram 403). The agent treats it as a block event. */
  | { readonly kind: "recipient_gone" };

export interface ChannelAdapter {
  /**
   * Authenticate and parse one webhook request. Reads the raw body exactly once (signatures cover the
   * raw bytes). Never throws on a malformed payload; unknown shapes are counted in `ignored`.
   */
  receive(req: Request): Promise<Received>;
  /**
   * Send one outbox row. Must be safe to call again with the same `msg.id` after a crash: either the
   * platform dedupes (LINE push with X-Line-Retry-Key) or the adapter documents the duplicate risk
   * (Telegram). When `msg.inDoubt`, the adapter must not use a non-idempotent path it could have
   * used before (LINE: skip the reply token, push with the retry key).
   */
  deliver(msg: OutboundMessage, now: EpochMs): Promise<Delivery>;
}

export type ChannelRegistry = { readonly [K in ChannelId]: ChannelAdapter };

export function makeChannels(config: Config): ChannelRegistry {
  return {
    line: lineChannel(config.line),
    telegram: telegramChannel(config.telegram),
    dev: devChannel(config.devMode),
  };
}

/** Adapter used when a channel's secrets are absent: every webhook is 404, every delivery fails loudly. */
export function disabledChannel(id: ChannelId): ChannelAdapter {
  return {
    receive: async () => ({ kind: "rejected", status: 404 }),
    deliver: async () => ({ kind: "failed", detail: `channel ${id} not configured` }),
  };
}
