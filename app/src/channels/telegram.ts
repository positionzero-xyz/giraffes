/**
 * Telegram Bot API, private chats only in week 1. Telegram wire types live in this file and nowhere else.
 */
import { eventKey, type EpochMs, type OutboundMessage } from "../domain";
import { disabledChannel, type ChannelAdapter, type Delivery, type Received } from "./channel";

export function telegramChannel(secrets: { botToken: string; webhookSecret: string } | null): ChannelAdapter {
  if (!secrets) return disabledChannel("telegram");
  return {
    async receive(req: Request): Promise<Received> {
      // TODO:
      //   header X-Telegram-Bot-Api-Secret-Token must equal webhookSecret (constant-time) else rejected 401
      //   update = await req.json(); key = eventKey.telegram(update.update_id)
      //   update.message && chat.type === "private":
      //     text === "/start" (or "/start <payload>") → lifecycle follow   (week 3: payload carries an invite code)
      //     text                                       → message
      //     non-text                                   → message "[sent a photo|…]"
      //   update.my_chat_member && chat.type === "private":
      //     new_chat_member.status === "kicked"        → lifecycle block
      //     new_chat_member.status === "member" && old was "kicked" → lifecycle follow
      //   else ignored++
      //   identity.channelUserId = String(from.id)  (equals the private chat id)
      //   No reply handle: Telegram has no free-reply concept.
      void eventKey;
      throw new Error("not implemented");
    },

    async deliver(msg: OutboundMessage, _now: EpochMs): Promise<Delivery> {
      // TODO:
      //   for each text: POST /bot{token}/sendMessage { chat_id, text }
      //   403 "bot was blocked by the user" → recipient_gone
      //   429 → retry(parameters.retry_after * 1000); 5xx → retry(backoff); 400 → failed
      //
      //   Telegram has no idempotency key. A crash after sendMessage succeeded but before the outbox row
      //   was marked sent re-sends on recovery (msg.inDoubt = true): the person may see a duplicate.
      //   We accept a rare duplicate over a lost reminder. A multi-text row that failed midway resends
      //   from the first text; texts per turn are capped at 3 to keep that small.
      throw new Error("not implemented");
    },
  };
}
