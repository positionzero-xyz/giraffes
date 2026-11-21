import { z } from "zod";
import { eventKey, parseChoice, parseInviteCode, personAgentKey, type ChannelEvent, type EpochMs, type OutboundMessage } from "../domain";
import { CHANNEL_RETRY_MS, disabledChannel, sameSecret, type ChannelAdapter, type Delivery, type Received } from "./channel";

const Chat = z.object({ id: z.number().int(), type: z.string() });
const Update = z.object({
  update_id: z.number().int(),
  message: z.looseObject({ date: z.number(), chat: Chat, text: z.string().optional() }).optional(),
  my_chat_member: z
    .object({ date: z.number(), chat: Chat, new_chat_member: z.object({ status: z.string() }) })
    .optional(),
  callback_query: z
    .object({ id: z.string(), message: z.object({ chat: Chat }).optional(), data: z.string().optional() })
    .optional(),
});
type Update = z.infer<typeof Update>;

const MEDIA = ["photo", "sticker", "voice", "audio", "video", "video_note", "animation", "document", "location", "contact"] as const;

/** A tap carries no time of its own, so `now` stands in for it. */
function toEvent(u: Update, now: EpochMs): { readonly chatId: number; readonly at: EpochMs; readonly event: ChannelEvent } | null {
  const tap = u.callback_query;
  if (tap?.message?.chat.type === "private") {
    const choice = tap.data === undefined ? null : parseChoice(tap.data);
    return choice ? { chatId: tap.message.chat.id, at: now, event: { kind: "choice", choice, at: now } } : null;
  }
  if (u.message && u.message.chat.type === "private") {
    const m = u.message;
    const at = (m.date * 1000) as EpochMs;
    if (m.text === "/start" || m.text?.startsWith("/start ")) {
      const code = parseInviteCode(m.text.slice("/start".length));
      return { chatId: m.chat.id, at, event: code ? { kind: "lifecycle", change: "follow", at, code } : { kind: "lifecycle", change: "follow", at } };
    }
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

export const SEND_MESSAGE_MAX_CHARS = 4096;

export function telegramChannel(secrets: { botToken: string; webhookSecret: string } | null): ChannelAdapter {
  if (!secrets) return disabledChannel("telegram");
  const api = `https://api.telegram.org/bot${secrets.botToken}`;

  /** Stops the button's spinner. A failure is only cosmetic, so the tap is still handled. */
  async function answer(id: string): Promise<void> {
    try {
      const res = await fetch(`${api}/answerCallbackQuery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callback_query_id: id }),
      });
      if (!res.ok) console.warn("answerCallbackQuery failed", res.status);
    } catch (err) {
      console.warn("answerCallbackQuery failed", err);
    }
  }

  return {
    async receive(req: Request): Promise<Received> {
      const given = req.headers.get("x-telegram-bot-api-secret-token");
      if (given === null || !sameSecret(given, secrets.webhookSecret)) return { kind: "rejected", status: 401 };
      const update = Update.safeParse(await req.json().catch(() => null));
      const parsed = update.success ? toEvent(update.data, Date.now() as EpochMs) : null;
      if (!update.success || !parsed) return { kind: "accepted", envelopes: [], ignored: 1 };
      if (update.data.callback_query) await answer(update.data.callback_query.id);
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
     * Telegram's sendMessage has no idempotency key, so a crash after a send succeeds but before the row is
     * marked sent re-sends it on recovery.
     */
    async deliver(msg: OutboundMessage): Promise<Delivery> {
      try {
        const res = await fetch(`${api}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: msg.to.channelUserId,
            text: msg.texts.join("\n\n"),
            link_preview_options: { is_disabled: true },
            ...(msg.button ? { reply_markup: { inline_keyboard: [[{ text: msg.button.label, callback_data: msg.button.data }]] } } : {}),
          }),
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
