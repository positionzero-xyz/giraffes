/**
 * Worker entry. Thin: authenticate and parse at the channel boundary, hand domain envelopes to the
 * right Agent, answer. No business logic, no model calls, no waiting on a turn.
 */
import chatPage from "../dev/chat.html";
import { makeChannels } from "./channels/channel";
import { devIdentity } from "./channels/dev";
import { loadConfig, type Env } from "./config";
import { CHANNEL_IDS, personAgentKey, type AgentKey, type ChannelId } from "./domain";

export { Agent } from "./agent/agent";

const WEBHOOK = new RegExp(`^/webhook/(${CHANNEL_IDS.join("|")})$`);
const isChannelId = (s: string): s is ChannelId => CHANNEL_IDS.some((id) => id === s);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const config = loadConfig(env);
    const url = new URL(req.url);

    const channel = req.method === "POST" ? url.pathname.match(WEBHOOK)?.[1] : undefined;
    if (channel !== undefined && isChannelId(channel)) {
      const adapter = makeChannels(config)[channel];
      const received = await adapter.receive(req);
      if (received.kind === "rejected") return new Response(null, { status: received.status });
      // Durable before 200. If any enqueue throws, answer 500: the channel redelivers, and
      // UNIQUE(event_key) turns the already-landed envelopes into no-ops.
      await Promise.all(received.envelopes.map((e) => agentStub(env, e.agent).enqueue(e)));
      return new Response("ok");
    }

    if (config.devMode && req.method === "GET") {
      if (url.pathname === "/dev") return new Response(chatPage, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/dev/transcript") return transcript(env, url);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export function agentStub(env: Env, key: AgentKey) {
  return env.AGENT.get(env.AGENT.idFromName(key));
}

/** GET /dev/transcript?user=u → Agent.snapshot() for p:dev:u. The dev page polls it every second. */
async function transcript(env: Env, url: URL): Promise<Response> {
  const identity = devIdentity(url.searchParams.get("user") ?? "");
  if (!identity) return new Response("user must match [A-Za-z0-9_-]{1,64}", { status: 400 });
  return Response.json(await agentStub(env, personAgentKey(identity)).snapshot());
}
