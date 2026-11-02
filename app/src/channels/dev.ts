/**
 * Dev channel: drive the whole loop locally with no external accounts.
 *
 * Inbound: POST /webhook/dev  { user: string, text: string, id: string }   (id is client-generated)
 * Outbound: nothing to call. The agent's outbox and `turn` table *are* the mailbox; the dev page polls
 * GET /dev/transcript?user=… which reads `Agent.snapshot()`. So `deliver` always succeeds and the dev
 * channel exercises exactly the same outbox, budget and quiet-hours path as LINE.
 */
import { eventKey, type EpochMs, type OutboundMessage } from "../domain";
import { disabledChannel, type ChannelAdapter, type Delivery, type Received } from "./channel";

export function devChannel(devMode: boolean): ChannelAdapter {
  if (!devMode) return disabledChannel("dev");
  return {
    async receive(req: Request): Promise<Received> {
      // TODO: parse { user, text, id }; text === "/follow" | "/block" → lifecycle (to exercise those paths);
      //       reply handle with a 60 s expiry so the reply-vs-push branch is visible in the transcript.
      void eventKey;
      throw new Error("not implemented");
    },
    async deliver(_msg: OutboundMessage, _now: EpochMs): Promise<Delivery> {
      return { kind: "sent", via: "push" };
    },
  };
}
