import type { ChannelId, EpochMs, InboundEnvelope, OutboundMessage } from "../domain";
import type { Config } from "../config";
import { lineChannel } from "./line";
import { telegramChannel } from "./telegram";
import { devChannel } from "./dev";

export type Received =
  | { readonly kind: "accepted"; readonly envelopes: readonly InboundEnvelope[]; readonly ignored: number }
  | { readonly kind: "rejected"; readonly status: 401 | 404 };

export type Delivery =
  | { readonly kind: "sent"; readonly via: "reply" | "push" }
  | { readonly kind: "retry"; readonly afterMs: number; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "recipient_gone" };

export interface ChannelAdapter {
  receive(req: Request): Promise<Received>;
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

export function disabledChannel(id: ChannelId): ChannelAdapter {
  return {
    receive: async () => ({ kind: "rejected", status: 404 }),
    deliver: async () => ({ kind: "failed", detail: `channel ${id} not configured` }),
  };
}

export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

export const CHANNEL_RETRY_MS = 30_000;
