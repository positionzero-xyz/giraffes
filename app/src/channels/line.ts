/**
 * LINE Messaging API, 1:1 only in week 1. LINE wire types live in this file and nowhere else.
 */
import { z } from "zod";
import { eventKey, personAgentKey, type ChannelEvent, type EpochMs, type InboundEnvelope, type OutboundMessage } from "../domain";
import { CHANNEL_RETRY_MS, disabledChannel, sameSecret, type ChannelAdapter, type Delivery, type Received } from "./channel";

const API = "https://api.line.me/v2/bot/message";
/** LINE says a reply token is good for about one minute. We stop trusting it earlier. */
const REPLY_TOKEN_TTL_MS = 60_000;
const REPLY_TOKEN_SAFETY_MS = 10_000;
/** A reply or push carries at most 5 message objects; each text at most 5,000 characters. */
const MAX_MESSAGES = 5;
const MAX_TEXT = 5000;

const WebhookBody = z.object({ events: z.array(z.unknown()) });
const WebhookEvent = z.object({
  type: z.string(),
  webhookEventId: z.string().min(1),
  timestamp: z.number(),
  source: z.object({ type: z.string(), userId: z.string().regex(/^U[0-9a-f]{32}$/).optional() }),
  replyToken: z.string().optional(),
  message: z.object({ type: z.string(), text: z.string().optional() }).optional(),
});
type WebhookEvent = z.infer<typeof WebhookEvent>;

async function signature(secret: string, body: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return btoa(String.fromCharCode(...mac));
}

function toEvent(e: WebhookEvent): ChannelEvent | null {
  const at = e.timestamp as EpochMs;
  const reply = e.replyToken ? { token: e.replyToken, expiresAt: (e.timestamp + REPLY_TOKEN_TTL_MS) as EpochMs } : undefined;
  switch (e.type) {
    case "message": {
      if (!e.message) return null;
      const text = e.message.type === "text" && e.message.text ? e.message.text : `[sent a ${e.message.type}]`;
      return reply ? { kind: "message", text, reply } : { kind: "message", text };
    }
    case "follow":
      return reply ? { kind: "lifecycle", change: "follow", at, reply } : { kind: "lifecycle", change: "follow", at };
    case "unfollow": // on LINE, unfollowing is blocking
      return { kind: "lifecycle", change: "block", at };
    default:
      return null;
  }
}

export function lineChannel(secrets: { channelSecret: string; accessToken: string } | null): ChannelAdapter {
  if (!secrets) return disabledChannel("line");
  const auth = { authorization: `Bearer ${secrets.accessToken}`, "content-type": "application/json" };

  return {
    async receive(req: Request): Promise<Received> {
      const raw = await req.arrayBuffer();
      const given = req.headers.get("x-line-signature");
      if (given === null || !sameSecret(given, await signature(secrets.channelSecret, raw))) return { kind: "rejected", status: 401 };

      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return { kind: "accepted", envelopes: [], ignored: 1 };
      }
      const body = WebhookBody.safeParse(json);
      if (!body.success) return { kind: "accepted", envelopes: [], ignored: 1 };

      const envelopes: InboundEnvelope[] = [];
      for (const item of body.data.events) {
        const e = WebhookEvent.safeParse(item);
        const userId = e.success && e.data.source.type === "user" ? e.data.source.userId : undefined;
        const event = e.success && userId ? toEvent(e.data) : null;
        if (!e.success || !userId || !event) continue; // groups arrive in week 3; other kinds aren't handled
        const identity = { channel: "line", channelUserId: userId } as const;
        envelopes.push({
          agent: personAgentKey(identity),
          identity,
          key: eventKey.line(e.data.webhookEventId),
          receivedAt: e.data.timestamp as EpochMs,
          event,
        });
      }
      return { kind: "accepted", envelopes, ignored: body.data.events.length - envelopes.length };
    },

    async deliver(msg: OutboundMessage, now: EpochMs): Promise<Delivery> {
      // The planner caps texts per turn, so truncation here is a guard, not a path.
      const messages = msg.texts.slice(0, MAX_MESSAGES).map((text) => ({ type: "text", text: text.slice(0, MAX_TEXT) }));
      try {
        if (msg.reply && !msg.inDoubt && now < msg.reply.expiresAt - REPLY_TOKEN_SAFETY_MS) {
          const res = await fetch(`${API}/reply`, { method: "POST", headers: auth, body: JSON.stringify({ replyToken: msg.reply.token, messages }) });
          if (res.ok) return { kind: "sent", via: "reply" };
          // 400 is an invalid or used token: pushing still reaches the person. Anything else is final.
          if (res.status !== 400) return classify(res.status, await res.text());
        }
        // Billed, and idempotent per X-Line-Retry-Key, so a resend after a crash is deduplicated by LINE.
        const res = await fetch(`${API}/push`, {
          method: "POST",
          headers: { ...auth, "x-line-retry-key": msg.id },
          body: JSON.stringify({ to: msg.to.channelUserId, messages }),
        });
        if (res.ok || res.status === 409) return { kind: "sent", via: "push" };
        return classify(res.status, await res.text());
      } catch (err) {
        return { kind: "retry", afterMs: CHANNEL_RETRY_MS, detail: String(err) };
      }
    },
  };
}

function classify(status: number, body: string): Delivery {
  // A 429 is either the per-second rate limit (try again) or the month's message quota (it won't clear).
  if (status === 429 && body.includes("monthly limit")) return { kind: "failed", detail: `quota: ${body}` };
  if (status === 429 || status >= 500) return { kind: "retry", afterMs: CHANNEL_RETRY_MS, detail: `${status} ${body}` };
  return { kind: "failed", detail: `${status} ${body}` };
}
