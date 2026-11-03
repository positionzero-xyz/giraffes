import chatPage from "../dev/chat.html";
import { DONE_PATH, parseEvent, verifySignature } from "./billing/stripe";
import { makeChannels } from "./channels/channel";
import { devIdentity } from "./channels/dev";
import { loadConfig, type Config, type Env } from "./config";
import { CHANNEL_IDS, personAgentKey, type AgentKey, type ChannelId, type EpochMs } from "./domain";

export { Agent } from "./agent/agent";

const WEBHOOK = new RegExp(`^/webhook/(${CHANNEL_IDS.join("|")})$`);
const isChannelId = (s: string): s is ChannelId => CHANNEL_IDS.some((id) => id === s);

const DONE_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Giraffes</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<p>All done. You can go back to the chat.</p></body></html>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const config = loadConfig(env);
    const url = new URL(req.url);

    const channel = req.method === "POST" ? url.pathname.match(WEBHOOK)?.[1] : undefined;
    if (channel !== undefined && isChannelId(channel)) {
      const adapter = makeChannels(config)[channel];
      const received = await adapter.receive(req);
      if (received.kind === "rejected") return new Response(null, { status: received.status });
      await Promise.all(received.envelopes.map((e) => agentStub(env, e.agent).enqueue(e)));
      return new Response("ok");
    }

    if (config.billing.on) {
      if (req.method === "POST" && url.pathname === "/webhook/stripe") return stripeWebhook(req, env, config.billing);
      if (req.method === "GET" && url.pathname === DONE_PATH) return new Response(DONE_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
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

/** 400 for anything Stripe should see failing; 200 for events that aren't ours, so Stripe stops resending them. */
async function stripeWebhook(req: Request, env: Env, billing: Extract<Config["billing"], { on: true }>): Promise<Response> {
  const payload = await req.text();
  if (!(await verifySignature(payload, req.headers.get("stripe-signature"), billing.stripe.webhookSecret, Date.now() as EpochMs))) {
    return new Response("bad signature", { status: 400 });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const parsed = parseEvent(raw, billing.stripe, billing.rules);
  switch (parsed.kind) {
    case "invalid":
      console.warn("stripe event rejected", parsed.reason);
      return new Response(parsed.reason, { status: 400 });
    case "ignored":
      return new Response(`ignored: ${parsed.reason}`);
    case "event":
      return new Response(await agentStub(env, parsed.event.subscription.owner).billingEvent(parsed.event));
  }
}

async function transcript(env: Env, url: URL): Promise<Response> {
  const identity = devIdentity(url.searchParams.get("user") ?? "");
  if (!identity) return new Response("user must match [A-Za-z0-9_-]{1,64}", { status: 400 });
  return Response.json(await agentStub(env, personAgentKey(identity)).snapshot());
}
