import { z } from "zod";
import { eventKey, personAgentKey, type ChannelEvent, type EpochMs, type OutboundMessage } from "../domain";
import { CHANNEL_RETRY_MS, disabledChannel, sameSecret, type ChannelAdapter, type Delivery, type Received } from "./channel";

const Chat = z.object({ id: z.number().int(), type: z.string() });
const Update = z.object({
  update_id: z.number().int(),
  message: z.looseObject({ date: z.number(), chat: Chat, text: z.string().optional() }).optional(),
  my_chat_member: z
    .object({ date: z.number(), chat: Chat, new_chat_member: z.object({ status: z.string() }) })
    .optional(),
});
type Update = z.infer<typeof Update>;

const MEDIA = ["photo", "sticker", "voice", "audio", "video", "video_note", "animation", "document", "location", "contact"] as const;

function toEvent(u: Update): { readonly chatId: number; readonly at: EpochMs; readonly event: ChannelEvent } | null {
  if (u.message && u.message.chat.type === "private") {
    const m = u.message;
    const at = (m.date * 1000) as EpochMs;
    if (m.text === "/start" || m.text?.startsWith("/start ")) return { chatId: m.chat.id, at, event: { kind: "lifecycle", change: "follow", at } };
    const text = m.text ?? `[sent a ${MEDIA.find((k) => k in m) ?? "message"}]`;
    return { chatId: m.chat.id, at, event: { kind: "message", text } };
  }
  const member = u.my_chat_member;
  if (member && member.chat.type === "private") {
    const at = (member.date * 1000) as EpochMs;
    const status = member.new_chat_member.status;
    if (status === "kicked") return { chatId: member.chat.id, at, event: { kind: "lifecycle", change: "block", at } };
    if (status === "member") return { chatId: member.chat.id, at, event: { kind: "lifecycle", change: "follow", at } };
  }
  return null;
}

const SendError = z.object({ parameters: z.object({ retry_after: z.number() }).optional() });

/** sendMessage's text limit. The turn caps keep a whole outbox row under it; channels.test.ts pins that. */
export const MAX_TEXT = 4096;

export function telegramChannel(secrets: { botToken: string; webhookSecret: string } | null): ChannelAdapter {
  if (!secrets) return disabledChannel("telegram");
  const api = `https://api.telegram.org/bot${secrets.botToken}`;

  return {
    async receive(req: Request): Promise<Received> {
      const given = req.headers.get("x-telegram-bot-api-secret-token");
      if (given === null || !sameSecret(given, secrets.webhookSecret)) return { kind: "rejected", status: 401 };
      const update = Update.safeParse(await req.json().catch(() => null));
      const parsed = update.success ? toEvent(update.data) : null;
      if (!update.success || !parsed) return { kind: "accepted", envelopes: [], ignored: 1 };
      // In a private chat the chat id is the person's user id.
      const identity = { channel: "telegram", channelUserId: String(parsed.chatId) } as const;
      return {
        kind: "accepted",
        envelopes: [
          { agent: personAgentKey(identity), identity, key: eventKey.telegram(update.data.update_id), receivedAt: parsed.at, event: parsed.event },
        ],
        ignored: 0,
      };
    },

    /**
     * One sendMessage per row, so a retry never repeats part of it. Telegram has no idempotency key: a
     * crash after sendMessage succeeded but before the outbox row was marked sent re-sends on recovery,
     * and the person may see a duplicate.
     */
    async deliver(msg: OutboundMessage): Promise<Delivery> {
      try {
        const res = await fetch(`${api}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: msg.to.channelUserId, text: msg.texts.join("\n\n") }),
        });
        if (res.ok) return { kind: "sent", via: "push" };
        const body: unknown = await res.json().catch(() => null);
        const detail = `${res.status} ${JSON.stringify(body)}`;
        if (res.status === 403) return { kind: "recipient_gone" };
        if (res.status === 429) {
          const retryAfter = SendError.safeParse(body).data?.parameters?.retry_after;
          return { kind: "retry", afterMs: retryAfter === undefined ? CHANNEL_RETRY_MS : retryAfter * 1000, detail };
        }
        if (res.status >= 500) return { kind: "retry", afterMs: CHANNEL_RETRY_MS, detail };
        return { kind: "failed", detail };
      } catch (err) {
        return { kind: "retry", afterMs: CHANNEL_RETRY_MS, detail: String(err) };
      }
    },
  };
}
