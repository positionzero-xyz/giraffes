/**
 * Worker entry. Thin: authenticate and parse at the channel boundary, hand domain envelopes to the
 * right Agent, answer. No business logic, no model calls, no waiting on a turn.
 */
import { makeChannels } from "./channels/channel";
import { loadConfig, type Env } from "./config";
import { CHANNEL_IDS, type AgentKey, type ChannelId } from "./domain";

export { Agent } from "./agent/agent";

const WEBHOOK = new RegExp(`^/webhook/(${CHANNEL_IDS.join("|")})$`);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const config = loadConfig(env);
    const url = new URL(req.url);

    const hook = req.method === "POST" ? url.pathname.match(WEBHOOK) : null;
    if (hook) {
      const adapter = makeChannels(config)[hook[1] as ChannelId];
      const received = await adapter.receive(req);
      if (received.kind === "rejected") return new Response(null, { status: received.status });
      // Durable before 200. If any enqueue throws, answer 500: the channel redelivers, and
      // UNIQUE(event_key) turns the already-landed envelopes into no-ops.
      await Promise.all(received.envelopes.map((e) => agentStub(env, e.agent).enqueue(e)));
      return new Response("ok");
    }

    if (config.devMode && url.pathname.startsWith("/dev")) return devRoutes(req, env, url);
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export function agentStub(env: Env, key: AgentKey) {
  return env.AGENT.get(env.AGENT.idFromName(key));
}

/**
 * GET /dev                     → app/dev/chat.html (bundled as a text module)
 * GET /dev/transcript?user=u   → Agent.snapshot() for p:dev:u, as JSON; the page polls this every second
 * Sending goes through POST /webhook/dev like any channel, so dev exercises the real path.
 */
async function devRoutes(req: Request, env: Env, url: URL): Promise<Response> {
  void req; void env; void url;
  throw new Error("not implemented");
}
