import { diagnostic } from "./diagnostics";
import { z } from "zod";
import chatPage from "../dev/chat.html";
import keyPage from "./access/page.html";
import { readTicket } from "./access/key";
import type { KeysConfig } from "./access/access";
import { boundedRequestBody } from "./body";
import { PROVIDER_IDS, PROVIDERS } from "./model/providers";
import { NOTICES } from "./notices";
import { DONE_PATH, parseEvent, verifySignature } from "./billing/stripe";
import { makeChannels, tellOperator } from "./channels/channel";
import { devIdentity } from "./channels/dev";
import { lineQuota } from "./channels/line";
import { loadConfig, type Config, type Env } from "./config";
import { CHANNEL_IDS, parseWakeupKey, personAgentKey, type AgentKey, type ChannelId, type EpochMs } from "./domain";
import { d1Ledger } from "./ledger/ledger";
import { alertsDue, quotaAlert } from "./policy/quota";
import { utcMonth } from "./policy/time";

export { Agent } from "./agent/agent";

const WEBHOOK = new RegExp(`^/webhook/(${CHANNEL_IDS.join("|")})$`);
const isChannelId = (s: string): s is ChannelId => CHANNEL_IDS.some((id) => id === s);

const DONE_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Giraffes</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<p>All done. You can go back to the chat.</p></body></html>`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await routeRequest(req, env);
    } catch {
      diagnostic("request_failed");
      return new Response("internal error", { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    try {
      const config = loadConfig(env);
      if (config.line) await checkLineQuota(config, config.line.accessToken, env, controller.scheduledTime as EpochMs);
    } catch {
      diagnostic("line_quota_unavailable");
      throw new Error("LINE quota check failed");
    }
  },
} satisfies ExportedHandler<Env>;

async function routeRequest(req: Request, env: Env): Promise<Response> {
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

  if (config.keys.on && url.pathname === "/key") {
    if (req.method === "GET") return new Response(KEY_PAGE, { headers: KEY_PAGE_HEADERS });
    if (req.method === "POST") return keyForm(req, env, config.keys);
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
  if (config.devMode && config.model.backend === "scripted" && req.method === "POST" && url.pathname === "/dev/release") return release(req, env);
  if (config.devMode && config.model.backend === "scripted" && req.method === "POST" && url.pathname === "/dev/forget") return forget(req, env);
  if (config.devMode && req.method === "POST" && url.pathname === "/dev/remove") return remove(req, env);
  if (config.devMode && req.method === "POST" && url.pathname === "/dev/fire") return fire(req, env);
  return new Response("not found", { status: 404 });
}

async function checkLineQuota(config: Config, accessToken: string, env: Env, now: EpochMs): Promise<void> {
  const ledger = d1Ledger(env.LEDGER);
  const reading = { at: now, month: utcMonth(now), ...(await lineQuota(accessToken)) };
  await ledger.recordLineQuota(reading);
  for (const percent of alertsDue(reading, await ledger.lineQuotaAlerts(reading.month))) {
    const text = quotaAlert(reading, percent);
    const via = config.operatorChat === null ? "log" : await tellOperator(makeChannels(config), config.operatorChat, text, now);
    if (via === "log") diagnostic("line_quota", percent);
    if (via !== null) await ledger.lineQuotaAlerted(reading.month, percent, via, now);
  }
}

const KEY_PAGE = keyPage.replace(
  "__DATA__",
  JSON.stringify({
    providers: PROVIDER_IDS.map((id) => ({
      id,
      label: PROVIDERS[id].label,
      models: Object.entries(PROVIDERS[id].models).map(([model, m]) => ({ id: model, name: m.name, pick: m.pick })),
      custom: PROVIDERS[id].baseUrl === null,
      signup: PROVIDERS[id].signup,
    })),
    text: { en: NOTICES.en.keyPage, th: NOTICES.th.keyPage },
  }).replaceAll("<", "\\u003c"),
);

const KEY_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const MAX_KEY_FORM_BYTES = 4096;
const KeyForm = z.object({
  ticket: z.string().max(300),
  provider: z.string().max(40),
  model: z.string().max(200),
  baseUrl: z.string().max(300),
  key: z.string().max(600),
});

async function keyForm(req: Request, env: Env, keys: Extract<KeysConfig, { on: true }>): Promise<Response> {
  const body = await boundedRequestBody(req, MAX_KEY_FORM_BYTES);
  if (body === null) return Response.json({ ok: false, error: "bad_form" }, { status: 413 });
  let raw: unknown = null;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch {}
  const form = KeyForm.safeParse(raw);
  if (!form.success) return Response.json({ ok: false, error: "bad_form" }, { status: 400 });
  const ticket = await readTicket(keys.secrets, form.data.ticket, Date.now() as EpochMs);
  if (!ticket) return Response.json({ ok: false, error: "expired" }, { status: 401 });
  const { ticket: _, ...fields } = form.data;
  const result = await env.AGENT.get(env.AGENT.idFromString(ticket.doId)).connectKey(ticket.nonceHash, fields);
  return Response.json(result, { status: result.ok ? 200 : 422 });
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
      diagnostic("stripe_event_rejected");
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

const DevUser = z.object({ user: z.string() });

async function release(req: Request, env: Env): Promise<Response> {
  const body = DevUser.safeParse(await req.json().catch(() => null));
  const identity = body.success ? devIdentity(body.data.user) : null;
  if (!identity) return new Response("body must be {user}", { status: 400 });
  await agentStub(env, personAgentKey(identity)).releaseScript();
  return new Response("ok");
}

const DevForget = z.object({ user: z.string(), op: z.string().optional() });

/** Dev only: without `op`, opens a forget at the time of the request; with it, ends that forget. */
async function forget(req: Request, env: Env): Promise<Response> {
  const body = DevForget.safeParse(await req.json().catch(() => null));
  const identity = body.success ? devIdentity(body.data.user) : null;
  if (!body.success || !identity) return new Response("body must be {user, op?}", { status: 400 });
  const stub = agentStub(env, personAgentKey(identity));
  if (body.data.op === undefined) return Response.json(await stub.beginForget({ at: Date.now() as EpochMs, seq: null }));
  return Response.json({ ended: await stub.endForget(body.data.op) });
}

const Fire = z.object({ user: z.string(), key: z.string() });

async function fire(req: Request, env: Env): Promise<Response> {
  const body = Fire.safeParse(await req.json().catch(() => null));
  const identity = body.success ? devIdentity(body.data.user) : null;
  const key = body.success ? parseWakeupKey(body.data.key) : null;
  if (!identity || !key) return new Response("body must be {user, key}", { status: 400 });
  const fired = await agentStub(env, personAgentKey(identity)).fireNow(key);
  return fired ? new Response("ok") : new Response("no pending wake-up with that key", { status: 404 });
}

const Removal = z.object({ agent: z.string().regex(/^p:(line|telegram|dev):[^:]+$/) });

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
