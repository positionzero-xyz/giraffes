import { diagnostic } from "../diagnostics";
import type { ChannelId, EpochMs, Identity, InboundEnvelope, OutboundMessage, OutboxId } from "../domain";
import type { Config, OperatorChat } from "../config";
import type { Ledger } from "../ledger/ledger";
import { utcMonth } from "../policy/time";
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

export type OperatorAlertDelivery = Delivery
  | { readonly kind: "chat_unavailable"; readonly detail: string }
  | { readonly kind: "chat_migrated"; readonly chatId: string; readonly detail: string };

export interface ChannelAdapter {
  receive(req: Request): Promise<Received>;
  /** `live`, when given, is asked right before every request after the first; the caller asks it before calling. */
  deliver(msg: OutboundMessage, now: EpochMs, live?: () => boolean): Promise<Delivery>;
  deliverOperatorAlert?(msg: OutboundMessage, now: EpochMs): Promise<OperatorAlertDelivery>;
  /** A sign that a reply is being made. It is not a message, so it spends no reply token; it fades unless shown again within `everyMs`. Never throws. */
  readonly working?: { readonly everyMs: number; show(to: Identity): Promise<void> };
}

/** Shows `to` that a reply is being made while `run` runs. */
export async function whileWorking<T>(channel: ChannelAdapter, to: Identity, run: () => Promise<T>): Promise<T> {
  const working = channel.working;
  if (!working) return run();
  const shows = [working.show(to)];
  const timer = setInterval(() => shows.push(working.show(to)), working.everyMs);
  try {
    return await run();
  } finally {
    clearInterval(timer);
    // A sign that lands after the reply would linger as if another reply were coming.
    await Promise.all(shows);
  }
}

export type ChannelRegistry = { readonly [K in ChannelId]: ChannelAdapter };

export function makeChannels(config: Config, ledger?: Pick<Ledger, "recordLineReply">): ChannelRegistry {
  return {
    line: lineChannel(config.line, ledger ? (at) => ledger.recordLineReply(utcMonth(at)) : undefined),
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

/** Chat apps show text as written, so the Markdown a model still writes is turned into plain text. */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => (label === url ? url : `${label} (${url})`))
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "$1");
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
export const CHANNEL_API_TIMEOUT_MS = 10_000;
