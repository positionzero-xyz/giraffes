import { z } from "zod";
import { eventKey, personAgentKey, type ChannelEvent, type EpochMs, type Identity, type OutboundMessage } from "../domain";
import { disabledChannel, type ChannelAdapter, type Delivery, type Received } from "./channel";

const REPLY_TTL_MS = 60_000;

const DevUser = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const DevBody = z.object({
  user: DevUser,
  text: z.string().min(1).max(4000),
  id: z.string().min(1).max(100),
  at: z.number().int().positive().optional(),
});

export function devIdentity(user: string): Identity | null {
  return DevUser.safeParse(user).success ? { channel: "dev", channelUserId: user } : null;
}

export function devChannel(devMode: boolean): ChannelAdapter {
  if (!devMode) return disabledChannel("dev");
  return {
    async receive(req: Request): Promise<Received> {
      const parsed = DevBody.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return { kind: "accepted", envelopes: [], ignored: 1 };
      const { user, text, id } = parsed.data;
      const at = (parsed.data.at ?? Date.now()) as EpochMs;
      const reply = { token: `dev:${id}`, expiresAt: (at + REPLY_TTL_MS) as EpochMs };
      const event: ChannelEvent =
        text === "/block"
          ? { kind: "lifecycle", change: "block", at }
          : text === "/follow"
            ? { kind: "lifecycle", change: "follow", at, reply }
            : { kind: "message", text, reply };
      const identity: Identity = { channel: "dev", channelUserId: user };
      return {
        kind: "accepted",
        envelopes: [{ agent: personAgentKey(identity), identity, key: eventKey.dev(id), receivedAt: at, event }],
        ignored: 0,
      };
    },
    async deliver(msg: OutboundMessage, now: EpochMs): Promise<Delivery> {
      const fresh = msg.reply !== undefined && !msg.inDoubt && now < msg.reply.expiresAt;
      return { kind: "sent", via: fresh ? "reply" : "push" };
    },
  };
}
