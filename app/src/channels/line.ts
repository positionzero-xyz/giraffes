/**
 * LINE Messaging API, 1:1 only in week 1. LINE wire types live in this file and nowhere else.
 */
import { eventKey, personAgentKey, type EpochMs, type OutboundMessage, type ReplyHandle } from "../domain";
import { disabledChannel, type ChannelAdapter, type Delivery, type Received } from "./channel";

/** LINE says a reply token is good for about one minute. We stop trusting it earlier. */
const REPLY_TOKEN_TTL_MS = 60_000;
const REPLY_TOKEN_SAFETY_MS = 10_000;
/** A reply or push carries at most 5 message objects; each text at most 5,000 characters. */
const MAX_MESSAGES = 5;
const MAX_TEXT = 5000;

export function lineChannel(secrets: { channelSecret: string; accessToken: string } | null): ChannelAdapter {
  if (!secrets) return disabledChannel("line");
  return {
    async receive(req: Request): Promise<Received> {
      // TODO:
      //   raw = await req.arrayBuffer()
      //   sig = req.headers.get("x-line-signature") ?? → rejected 401
      //   expected = base64(HMAC-SHA256(channelSecret, raw))   via crypto.subtle.importKey/sign
      //   constant-time compare (crypto.subtle.timingSafeEqual) else → rejected 401
      //   body = JSON.parse(text(raw)); for each e of body.events:
      //     if e.source.type !== "user" → ignored++  (groups arrive in week 3)
      //     identity = { channel: "line", channelUserId: e.source.userId }
      //     key = eventKey.line(e.webhookEventId)      // same on redelivery (deliveryContext.isRedelivery)
      //     reply = e.replyToken ? { token, expiresAt: e.timestamp + REPLY_TOKEN_TTL_MS } : undefined
      //     e.type "message" && message.type "text" → { kind: "message", text, reply }
      //     e.type "message" other types            → { kind: "message", text: "[sent a sticker|image|…]", reply }
      //     e.type "follow"                         → { kind: "lifecycle", change: "follow", reply }
      //     e.type "unfollow"                       → { kind: "lifecycle", change: "block" }   // LINE unfollow = block
      //     else → ignored++
      //   receivedAt = e.timestamp (LINE's clock), so ordering and reply-token expiry use the same source
      void eventKey; void personAgentKey;
      throw new Error("not implemented");
    },

    async deliver(msg: OutboundMessage, now: EpochMs): Promise<Delivery> {
      // TODO:
      //   messages = chunk(msg.texts, MAX_TEXT).slice(0, MAX_MESSAGES)  (the planner caps texts per turn, so
      //              truncation here is a guard, not a path)
      //   if (msg.reply && !msg.inDoubt && now < msg.reply.expiresAt - REPLY_TOKEN_SAFETY_MS):
      //     POST /v2/bot/message/reply { replyToken, messages }       — free
      //     200 → sent(reply); 400 "Invalid reply token" → fall through to push; 429/5xx → retry
      //   POST /v2/bot/message/push { to: msg.to.channelUserId, messages }
      //        headers: Authorization Bearer, X-Line-Retry-Key: msg.id    — billed, idempotent
      //     200 → sent(push)
      //     409 (retry key already accepted) → sent(push)               // the crash-retry case
      //     429 quota exhausted ("You have reached your monthly limit") → failed (log + operator alert)
      //     429 rate limit / 5xx → retry(backoff)
      //     403/400 → failed
      void REPLY_TOKEN_SAFETY_MS;
      throw new Error("not implemented");
    },
  };
}

export type { ReplyHandle };
