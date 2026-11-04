import { z } from "zod";
import chatPage from "../dev/chat.html";
import { DONE_PATH, parseEvent, verifySignature } from "./billing/stripe";
import { makeChannels } from "./channels/channel";
import { devIdentity } from "./channels/dev";
import { lineQuota } from "./channels/line";
import { loadConfig, type Config, type Env, type OperatorChat } from "./config";
import { CHANNEL_IDS, personAgentKey, type AgentKey, type ChannelId, type EpochMs, type OutboxId } from "./domain";
import { d1Ledger } from "./ledger/ledger";
import { alertsDue, quotaAlert } from "./policy/quota";
import { SPEND } from "./policy/spend";
import { utcMonth } from "./policy/time";

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
    if (config.devMode && config.model.backend === "scripted" && req.method === "POST" && url.pathname === "/dev/script") return script(req, env);
    if (config.devMode && req.method === "POST" && url.pathname === "/dev/remove") return remove(req, env);
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const config = loadConfig(env);
    if (config.line) await checkLineQuota(config, config.line.accessToken, env, controller.scheduledTime as EpochMs);
  },
} satisfies ExportedHandler<Env>;

async function checkLineQuota(config: Config, accessToken: string, env: Env, now: EpochMs): Promise<void> {
  const ledger = d1Ledger(env.LEDGER, SPEND.globalCeilingMicro);
  const reading = { at: now, month: utcMonth(now), ...(await lineQuota(accessToken)) };
  await ledger.recordLineQuota(reading);
  for (const percent of alertsDue(reading, await ledger.lineQuotaAlerts(reading.month))) {
    const via = await tellOperator(config, quotaAlert(reading, percent), now);
    if (via !== null) await ledger.lineQuotaAlerted(reading.month, percent, via, now);
  }
}

/** Null when the alert didn't go out, so the next hour tries again. */
async function tellOperator(config: Config, text: string, now: EpochMs): Promise<OperatorChat["channel"] | "log" | null> {
  const to = config.operatorChat;
  if (to === null) {
    console.warn(text);
    return "log";
  }
  const sent = await makeChannels(config)[to.channel].deliver({ id: crypto.randomUUID() as OutboxId, to, texts: [text], intent: "requested" }, now);
  if (sent.kind === "sent") return to.channel;
  console.warn("operator alert not sent", sent.kind);
  return null;
}

export function agentStub(env: Env, key: AgentKey) {
  return env.AGENT.get(env.AGENT.idFromName(key));
}

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
  const parsed = parseEvent(raw);
  switch (parsed.kind) {
    case "invalid":
      console.warn("stripe event rejected", parsed.reason);
      return new Response(parsed.reason, { status: 400 });
    case "ignored":
      return new Response(`ignored: ${parsed.reason}`);
    case "event":
      return new Response(await agentStub(env, parsed.event.owner).billingEvent(parsed.event));
  }
}

const Script = z.object({ user: z.string(), turns: z.array(z.unknown()), compaction: z.array(z.unknown()).default([]) });

async function script(req: Request, env: Env): Promise<Response> {
  const body = Script.safeParse(await req.json().catch(() => null));
  const identity = body.success ? devIdentity(body.data.user) : null;
  if (!body.success || !identity) return new Response("body must be {user, turns, compaction?}", { status: 400 });
  await agentStub(env, personAgentKey(identity)).script(body.data.turns, body.data.compaction);
  return new Response("ok");
}

const Removal = z.object({ agent: z.string().regex(/^p:(line|telegram|dev):[^:]+$/) });

/** Takes a person out of the beta, by agent key. Dev only until there is an operator route with its own auth. */
async function remove(req: Request, env: Env): Promise<Response> {
  const body = Removal.safeParse(await req.json().catch(() => null));
  if (!body.success) return new Response("body must be {agent: p:<channel>:<id>}", { status: 400 });
  await agentStub(env, body.data.agent as AgentKey).remove();
  return new Response("ok");
}

async function transcript(env: Env, url: URL): Promise<Response> {
  const identity = devIdentity(url.searchParams.get("user") ?? "");
  if (!identity) return new Response("user must match [A-Za-z0-9_-]{1,64}", { status: 400 });
  return Response.json(await agentStub(env, personAgentKey(identity)).snapshot());
}
