import { diagnostic } from "../diagnostics";
import type { ChannelId, EpochMs, InboundEnvelope, OutboundMessage, OutboxId } from "../domain";
import type { Config, OperatorChat } from "../config";
import { lineChannel } from "./line";
import { SEND_MESSAGE_MAX_CHARS, telegramChannel } from "./telegram";
import { devChannel } from "./dev";

export type Received =
  | { readonly kind: "accepted"; readonly envelopes: readonly InboundEnvelope[]; readonly ignored: number }
  | { readonly kind: "rejected"; readonly status: 401 | 404 | 413 };

export type Delivery =
  | { readonly kind: "sent"; readonly via: "reply" | "push" }
  | { readonly kind: "retry"; readonly afterMs: number; readonly detail: string }
  | { readonly kind: "in_doubt"; readonly afterMs: number; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "recipient_gone" }
  /** `live` turned false before a later request of this delivery, which was then not sent. */
  | { readonly kind: "fenced" };

export interface ChannelAdapter {
  receive(req: Request): Promise<Received>;
  /** `live`, when given, is asked right before every request after the first; the caller asks it before calling. */
  deliver(msg: OutboundMessage, now: EpochMs, live?: () => boolean): Promise<Delivery>;
}

export type ChannelRegistry = { readonly [K in ChannelId]: ChannelAdapter };

export function makeChannels(config: Config): ChannelRegistry {
  return {
    line: lineChannel(config.line),
    telegram: telegramChannel(config.telegram),
    dev: devChannel(config.devMode),
  };
}

export async function tellOperator(channels: ChannelRegistry, to: OperatorChat, text: string, now: EpochMs, continuation = ""): Promise<OperatorChat["channel"] | null> {
  const maxChars = SEND_MESSAGE_MAX_CHARS - continuation.length;
  const messages = to.channel === "telegram" ? (text.match(new RegExp(`.{1,${maxChars}}`, "gsu")) ?? []) : [text];
  for (const [i, part] of messages.entries()) {
    const message = i === 0 ? part : continuation + part;
    const sent = await channels[to.channel].deliver({ id: crypto.randomUUID() as OutboxId, to, texts: [message], intent: "requested" }, now);
    if (sent.kind !== "sent") {
      diagnostic("operator_alert_failed");
      return null;
    }
  }
  return to.channel;
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
