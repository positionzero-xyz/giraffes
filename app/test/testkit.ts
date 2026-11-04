/**
 * Scenarios use dates in 2099. The runtime fires a stored alarm on its own once the real clock passes
 * it, which would race the test's explicit runs; far-future fake times keep every alarm in the future.
 */
import { createHmac } from "node:crypto";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import worker from "../src/worker";
import { d1Billing, type BillingStore } from "../src/billing/store";
import type { CheckoutId, CheckoutRequest, StripeApi, StripeReply } from "../src/billing/stripe";
import { loadConfig, type BillingConfig, type Env } from "../src/config";
import type { Agent, AgentSnapshot, BillingDeps, BoxDeps } from "../src/agent/agent";
import { boxClient } from "../src/box/client";
import type { BoxHost, HostResult } from "../src/box/host";
import { boxName, type BoxName } from "../src/box/names";
import type { ChannelAdapter } from "../src/channels/channel";
import { eventKey, parseChoice, personAgentKey, type EpochMs, type Identity, type LocalDateTime, type MicroUsd } from "../src/domain";
import type { LeaseAnswer, Ledger, LogRow } from "../src/ledger/ledger";
import { scripted, type ScriptStep, type ScriptedModel } from "../src/model/scripted";
import type { QuotaReading } from "../src/policy/quota";
import { SPEND } from "../src/policy/spend";
import { DEFAULT_TIME_ZONE, fromLocal, toLocal } from "../src/policy/time";

export { scripted };

export const local = (s: string): EpochMs => fromLocal(s as LocalDateTime, DEFAULT_TIME_ZONE);
export const wall = (t: EpochMs): string => toLocal(t, DEFAULT_TIME_ZONE);

export type FakeClock = { now(): EpochMs; set(t: EpochMs): void };

export function fakeClock(start: EpochMs): FakeClock {
  let t = start;
  return {
    now: () => t,
    set(next) {
      t = next;
    },
  };
}

export type MemoryLedger = Ledger & {
  /** The latest LINE quota reading, as the hourly check would have recorded it. */
  lineQuotaReading: { readonly at: EpochMs; readonly month: string; readonly limit: number | null; readonly used: number } | null;
  readonly rows: readonly LogRow[];
  readonly boxes: ReadonlyMap<string, { readonly name: string; readonly host: string }>;
};

export function memoryLedger(opts: { readonly ceilingMicro?: number } = {}): MemoryLedger {
  const ceiling = opts.ceilingMicro ?? SPEND.globalCeilingMicro;
  const rows: LogRow[] = [];
  const seen = new Set<string>();
  const leases = new Map<string, { month: string; micro: MicroUsd }>();
  const boxes = new Map<string, { name: string; host: string }>();
  return {
    lineQuotaReading: null,
    async recordLineQuota() {},
    async lineQuota() {
      return this.lineQuotaReading as QuotaReading | null;
    },
    async lineQuotaAlerts() {
      return [];
    },
    async lineQuotaAlerted() {},
    rows,
    boxes,
    async claimBox(req) {
      if (!boxes.has(req.agent) && boxes.size >= req.max) return "full";
      if (!boxes.has(req.agent)) boxes.set(req.agent, { name: req.name, host: req.host });
      return "granted";
    },
    async releaseBox(agent) {
      boxes.delete(agent);
    },
    async append(batch) {
      for (const row of batch) {
        const key = `${row.stream}:${row.id}`;
        if (!seen.has(key)) rows.push(row);
        seen.add(key);
      }
    },
    async requestLease(req): Promise<LeaseAnswer> {
      const key = `${req.agent}|${req.month}|${req.seq}`;
      const existing = leases.get(key);
      if (existing) return { kind: "granted", micro: existing.micro };
      const used = [...leases.values()].filter((l) => l.month === req.month).reduce((sum, l) => sum + l.micro, 0);
      if (used + req.micro > ceiling) return { kind: "ceiling" };
      leases.set(key, { month: req.month, micro: req.micro });
      return { kind: "granted", micro: req.micro };
    },
  };
}

export type DeliveryStep =
  | { readonly kind: "sent" }
  | { readonly kind: "retry" | "in_doubt"; readonly afterMs: number }
  | { readonly kind: "throw" }
  | { readonly kind: "gone" };

export type Delivered = {
  readonly at: EpochMs;
  readonly text: string;
  readonly via: "reply" | "push";
  readonly button?: { readonly label: string; readonly data: string };
};

export type ScriptedChannel = ChannelAdapter & { readonly delivered: readonly Delivered[] };

export function scriptedChannel(steps: readonly DeliveryStep[] = []): ScriptedChannel {
  const queue = [...steps];
  const delivered: Delivered[] = [];
  return {
    delivered,
    receive: async () => {
      throw new Error("the agent never receives through its channel");
    },
    async deliver(msg, now) {
      const step = queue.shift() ?? { kind: "sent" };
      switch (step.kind) {
        case "sent": {
          const via = msg.reply !== undefined && now < msg.reply.expiresAt ? "reply" : "push";
          delivered.push({ at: now, text: msg.texts.join("\n"), via, ...(msg.button ? { button: msg.button } : {}) });
          return { kind: "sent", via };
        }
        case "retry":
        case "in_doubt":
          return { kind: step.kind, afterMs: step.afterMs, detail: `scripted ${step.kind}` };
        case "throw":
          throw new Error("scripted exception from the channel");
        case "gone":
          return { kind: "recipient_gone" };
      }
    },
  };
}

export type DevChat = {
  readonly model: ScriptedModel;
  readonly clock: FakeClock;
  readonly channel: ScriptedChannel;
  post(text: string, opts?: { readonly id?: string; readonly at?: EpochMs }): Promise<Response>;
  say(text: string, opts?: { readonly id?: string; readonly at?: EpochMs }): Promise<void>;
  /** The person taps a button whose data is `data`, such as "a:1.1". */
  tap(data: string): Promise<void>;
  settle(): Promise<void>;
  alarm(): Promise<void>;
  advanceTo(local: string): Promise<void>;
  received(): Promise<string[]>;
  snapshot(): Promise<AgentSnapshot>;
  logs<S extends LogRow["stream"]>(stream: S): Extract<LogRow, { stream: S }>[];
};

let messageIds = 0;

export async function devChat(
  user: string,
  opts: {
    readonly model: ScriptedModel;
    readonly at: string;
    readonly ledger?: MemoryLedger;
    readonly deliveries?: readonly DeliveryStep[];
    readonly box?: BoxDeps;
    readonly billing?: BillingDeps;
    /** A LINE person's messages go straight into their agent, past the webhook's signature check. */
    readonly line?: boolean;
  },
): Promise<DevChat> {
  const clock = fakeClock(local(opts.at));
  const ledger = opts.ledger ?? memoryLedger();
  const channel = scriptedChannel(opts.deliveries);
  const identity: Identity = { channel: opts.line ? "line" : "dev", channelUserId: user };
  const stub = env.AGENT.get(env.AGENT.idFromName(personAgentKey(identity)));
  const channels = { line: channel, telegram: channel, dev: channel };
  const box = opts.box ? { box: opts.box } : {};
  const billing = opts.billing ? { billing: opts.billing } : {};
  await runInDurableObject<Agent, void>(stub, (agent) => agent.withDeps({ model: opts.model, clock, ledger, channels, ...box, ...billing }));
  let seen = 0;
  const nextAlarm = () => runInDurableObject(stub, (_agent, state) => state.storage.getAlarm());

  const chat: DevChat = {
    model: opts.model,
    clock,
    channel,
    async post(text, o = {}) {
      const body = { user, text, id: o.id ?? `m${++messageIds}`, at: o.at ?? clock.now() };
      if (identity.channel === "dev") return SELF.fetch("https://agent.test/webhook/dev", { method: "POST", body: JSON.stringify(body) });
      const at = body.at as EpochMs;
      await stub.enqueue({ agent: personAgentKey(identity), identity, key: eventKey.line(body.id), receivedAt: at, event: { kind: "message", text } });
      return new Response("ok");
    },
    async say(text, o) {
      const res = await chat.post(text, o);
      if (!res.ok) throw new Error(`webhook answered ${res.status}`);
      await chat.settle();
    },
    async tap(data) {
      const choice = parseChoice(data);
      if (!choice) throw new Error(`not a button: ${data}`);
      const at = clock.now();
      const key = identity.channel === "line" ? eventKey.line(`tap${++messageIds}`) : eventKey.dev(`tap${++messageIds}`);
      await stub.enqueue({ agent: personAgentKey(identity), identity, key, receivedAt: at, event: { kind: "choice", choice, at } });
      await chat.settle();
    },
    async settle() {
      for (let i = 0; i < 50; i++) {
        await chat.alarm();
        const next = await nextAlarm();
        if (next === null || next > clock.now()) return;
      }
      throw new Error("the agent never went idle");
    },
    alarm: () => runInDurableObject<Agent, void>(stub, (agent) => agent.alarm()),
    async advanceTo(to) {
      const target = local(to);
      for (;;) {
        const next = await nextAlarm();
        if (next === null || next > target) break;
        clock.set(Math.max(next, clock.now()) as EpochMs);
        await chat.settle();
      }
      clock.set(target);
      await chat.settle();
    },
    async received() {
      const fresh = channel.delivered.slice(seen);
      seen = channel.delivered.length;
      return fresh.map((d) => d.text);
    },
    snapshot: () => stub.snapshot(),
    logs: (stream) => ledger.rows.filter((r): r is Extract<LogRow, { stream: typeof stream }> => r.stream === stream),
  };
  return chat;
}

export function turn(o: {
  readonly actions: unknown[];
  readonly lateNotice?: string;
  readonly task?: readonly [kind: string, key: string, status: string];
  readonly tasks?: unknown[];
  readonly about?: string;
  readonly usage?: Extract<ScriptStep, { kind: "output" }>["usage"];
}): ScriptStep {
  const [kind, key, status] = o.task ?? ["chat", "chat", "none"];
  const base = { actions: o.actions, task: { kind, key, status }, tasks: o.tasks ?? [], about: o.about ?? "" };
  const value = o.lateNotice === undefined ? base : { ...base, lateNotice: o.lateNotice };
  return o.usage ? { kind: "output", value, usage: o.usage } : { kind: "output", value };
}
export const send = (text: string) => ({ type: "send", text });
export const schedule = (key: string, at: string, note: string, asked = true, task = "") => ({ type: "schedule_wakeup", key, at, note, asked, task });
export const cancel = (key: string) => ({ type: "cancel_wakeup", key });
export const quiet = () => ({ type: "quiet" });
export const propose = (ref: string, title: string, plan: string, kind = "plan") => ({ op: "propose", ref, kind, title, plan });
export const openTask = (ref: string, title: string, kind = "other") => ({ op: "open", ref, kind, title, plan: "" });
export const throws = (): ScriptStep => ({ kind: "throw" });
export const hold = (then: ScriptStep): ScriptStep => ({ kind: "hold", then });
export const chat = (text: string): ScriptStep => turn({ actions: [send(text)], task: ["chat", "chat", "none"] });

export const BOX_SECRET = "test-secret-0123456789abcdef";

export type HostStep = "ok" | "die" | { readonly retryable: boolean; readonly detail: string };
/** `die` removes the app and then throws, as a crash right after the host call would. */
export type DestroyStep = "ok" | "die" | "fail";

export type BoxReplyStep =
  | { readonly kind: "reply"; readonly step: ScriptStep }
  | { readonly kind: "signed_out" }
  | { readonly kind: "status"; readonly status: number };

export type FakeBox = {
  readonly deps: BoxDeps;
  /** Apps the host has created; a step that died after creating one leaves it here, as a real crash would. */
  readonly created: Set<string>;
  readonly ensureCalls: string[];
  /** The image each `ensure` put on its machine. */
  readonly ensuredWith: string[];
  /** BOX_IMAGE as the host sees it; changing it stands for a deploy with a new image. */
  image: string;
  readonly destroyCalls: string[];
  readonly healthCalls: string[];
  readonly parses: { readonly authorization: string | null; readonly user: string }[];
  readonly replies: BoxReplyStep[];
  signedIn: boolean;
  /** False makes the box's own URL unreachable, as a wedged machine or a network fault would. */
  reachable: boolean;
  nameOf(user: string): Promise<BoxName>;
};

/** A BoxHost and the box's HTTP server behind the real box client, wired through a fake fetch. */
export function fakeBox(
  opts: {
    readonly maxBoxes?: number;
    readonly host?: readonly HostStep[];
    readonly destroy?: readonly DestroyStep[];
    readonly signedIn?: boolean;
    readonly onlyFor?: string;
  } = {},
): FakeBox {
  const steps = [...(opts.host ?? [])];
  const destroySteps = [...(opts.destroy ?? [])];
  const box = {
    created: new Set<string>(),
    ensureCalls: [] as string[],
    ensuredWith: [] as string[],
    image: "registry.test/box:1",
    destroyCalls: [] as string[],
    healthCalls: [] as string[],
    parses: [] as { authorization: string | null; user: string }[],
    replies: [] as BoxReplyStep[],
    signedIn: opts.signedIn ?? false,
    reachable: true,
    nameOf: (user: string) => boxName(BOX_SECRET, "gbox-", personAgentKey({ channel: "dev", channelUserId: user })),
  };
  const host: BoxHost = {
    kind: "fly",
    get image() {
      return box.image;
    },
    nameFor: (agent) => boxName(BOX_SECRET, "gbox-", agent),
    urlOf: (name) => `https://${name}.box.test`,
    async ensure(name): Promise<HostResult> {
      box.ensureCalls.push(name);
      const step = steps.shift() ?? "ok";
      if (step === "die") {
        box.created.add(name);
        throw new Error("the host step died after creating the app");
      }
      if (step !== "ok") return { ok: false, ...step };
      box.created.add(name);
      box.ensuredWith.push(box.image);
      return { ok: true };
    },
    async destroy(name): Promise<HostResult> {
      box.destroyCalls.push(name);
      const step = destroySteps.shift() ?? "ok";
      if (step === "fail") return { ok: false, retryable: true, detail: "DELETE /apps: 503" };
      box.created.delete(name);
      if (step === "die") throw new Error("the host step died after destroying the app");
      return { ok: true };
    },
  };
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const name = url.hostname.replace(/\.box\.test$/, "");
    if (url.pathname === "/health") box.healthCalls.push(name);
    if (!box.created.has(name) || !box.reachable) throw new TypeError("fetch failed: no such host");
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/health") {
      return Response.json({ ok: true, signedIn: box.signedIn, authMethod: box.signedIn ? "claude.ai" : "none", version: "test" });
    }
    if (url.pathname === "/parse") {
      const body = JSON.parse(String(init?.body)) as { user: string };
      box.parses.push({ authorization, user: body.user });
      const step = box.replies.shift();
      if (!step) throw new Error("the box got a turn the test didn't script");
      switch (step.kind) {
        case "signed_out":
          return Response.json({ error: "signed_out" }, { status: 409 });
        case "status":
          return Response.json({ error: "claude_failed" }, { status: step.status });
        case "reply": {
          if (step.step.kind !== "output") throw new Error("a box reply must be an output step");
          return Response.json({ structured: step.step.value, usage: { input_tokens: 900, output_tokens: 90 }, stop: "end" });
        }
      }
    }
    return new Response("not found", { status: 404 });
  };
  const deps: BoxDeps = {
    host,
    client: boxClient(fetch),
    secret: BOX_SECRET,
    maxBoxes: opts.maxBoxes ?? 10,
    onlyFor: opts.onlyFor === undefined ? null : personAgentKey({ channel: "dev", channelUserId: opts.onlyFor }),
  };
  return Object.assign(box, { deps });
}

export const STRIPE_VARS = {
  BILLING: "on",
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
  STRIPE_PRICE_STANDARD: "price_standard",
  STRIPE_PRICE_PLUS: "price_plus",
  STRIPE_PRICE_SEAT: "price_seat",
  STRIPE_PRICE_AI: "price_ai",
  STRIPE_PORTAL_CONFIGURATION: "bpc_fake",
  PUBLIC_URL: "https://giraffes.test",
} as const;

export type FakeStripe = StripeApi & {
  readonly checkouts: CheckoutRequest[];
  /** Checkout sessions by id, as Stripe holds them; a repeated idempotency key gets its session back. */
  readonly sessions: Map<string, "open" | "complete" | "expired">;
  readonly portals: string[];
  failing: boolean;
  expiresFailing: boolean;
  /** What Stripe holds now, by subscription id; each event's handler reads it from here. */
  readonly subscriptions: Map<string, unknown>;
  readsFailing: boolean;
  /** Holds the next read after it has copied the state, until the returned function is called. */
  holdNextRead(): () => void;
};

export function fakeStripe(): FakeStripe {
  let hold: Promise<void> | null = null;
  const stripe: FakeStripe = {
    checkouts: [],
    sessions: new Map(),
    portals: [],
    failing: false,
    expiresFailing: false,
    subscriptions: new Map(),
    readsFailing: false,
    holdNextRead() {
      let release = () => {};
      hold = new Promise((r) => (release = r));
      return release;
    },
    async checkout(req) {
      stripe.checkouts.push(req);
      if (stripe.failing) return { ok: false, status: 500, detail: "checkout 500" };
      const id = `cs_${createHmac("sha256", "cs").update(req.idempotencyKey).digest("hex").slice(0, 12)}` as CheckoutId;
      if (!stripe.sessions.has(id)) stripe.sessions.set(id, "open");
      return { ok: true, value: { id, url: `https://checkout.stripe.test/${req.plan}/${encodeURIComponent(req.idempotencyKey)}` } };
    },
    async expireCheckout(id) {
      if (stripe.expiresFailing) return { ok: false, status: 500, detail: "expire 500" };
      if (stripe.sessions.get(id) !== "open") return { ok: true, value: "gone" };
      stripe.sessions.set(id, "expired");
      return { ok: true, value: "expired" };
    },
    async portal(customer) {
      if (stripe.failing) return { ok: false, status: 500, detail: "portal 500" };
      stripe.portals.push(customer);
      return { ok: true, value: { url: `https://billing.stripe.test/p/${customer}` } };
    },
    async subscription(id): Promise<StripeReply<unknown>> {
      if (stripe.readsFailing) return { ok: false, status: null, detail: "TypeError: fetch failed" };
      const state = structuredClone(stripe.subscriptions.get(id) ?? null);
      const held = hold;
      hold = null;
      if (held) await held;
      return { ok: true, value: state };
    },
  };
  return stripe;
}

export type BillingKit = { readonly deps: BillingDeps; readonly stripe: FakeStripe; readonly config: Extract<BillingConfig, { on: true }> };

/** BILLING=on with the real D1 store and a fake Stripe API. `vars` overrides the env, such as TRIAL_DAYS. */
export function billingOn(vars: Record<string, string> = {}, store: BillingStore = d1Billing(env.LEDGER)): BillingKit {
  const config = loadConfig({ MODEL_BACKEND: "scripted", DEV_MODE: "1", ...STRIPE_VARS, ...vars } as unknown as Env).billing;
  if (!config.on) throw new Error("billingOn needs BILLING=on");
  const stripe = fakeStripe();
  return { deps: { config, store, stripe }, stripe, config };
}

export function signStripe(payload: string, at: number = Date.now(), secret: string = STRIPE_VARS.STRIPE_WEBHOOK_SECRET): string {
  const t = Math.floor(at / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}

/** Posts to the real Worker route with BILLING=on in its env. */
export async function postStripe(event: unknown, opts: { readonly signature?: string; readonly vars?: Record<string, string> } = {}): Promise<Response> {
  const payload = JSON.stringify(event);
  const req = new Request("https://agent.test/webhook/stripe", {
    method: "POST",
    headers: { "stripe-signature": opts.signature ?? signStripe(payload) },
    body: payload,
  });
  return worker.fetch(req, { ...env, ...STRIPE_VARS, ...opts.vars } as Env);
}

let stripeEvents = 0;

export type StripeSubscriptionOpts = {
  readonly user: string;
  readonly sub: string;
  readonly plan: "standard" | "plus" | "ai";
  readonly status: string;
  readonly extraSeats?: number;
  readonly customer?: string;
};

/** A subscription object as `GET /v1/subscriptions/{id}` returns it, on the prices `stripe-setup.ts` makes. */
export function stripeSubscription(o: StripeSubscriptionOpts) {
  const price = (name: string) => ({ id: `price_${name}`, object: "price", product: `giraffes_${name}`, lookup_key: `giraffes_${name}` });
  const items = [{ price: price(o.plan), quantity: 1 }];
  if (o.extraSeats) items.push({ price: price("seat"), quantity: o.extraSeats });
  return {
    id: o.sub,
    object: "subscription",
    status: o.status,
    customer: o.customer ?? `cus_${o.user}`,
    metadata: { agent_key: personAgentKey({ channel: "dev", channelUserId: o.user }), plan: o.plan },
    items: { object: "list", data: items },
  };
}

type SubscriptionEventType = "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted";

export function subscriptionEvent(o: StripeSubscriptionOpts & { readonly type?: SubscriptionEventType; readonly id?: string }) {
  return {
    id: o.id ?? `evt_${++stripeEvents}`,
    type: o.type ?? "customer.subscription.updated",
    created: Math.floor(Date.now() / 1000),
    data: { object: stripeSubscription(o) },
  };
}

export function checkoutEvent(o: { readonly user: string; readonly sub: string; readonly plan: "standard" | "plus" | "ai"; readonly id?: string }) {
  const agent = personAgentKey({ channel: "dev", channelUserId: o.user });
  return {
    id: o.id ?? `evt_${++stripeEvents}`,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `cs_${stripeEvents}`,
        object: "checkout.session",
        mode: "subscription",
        client_reference_id: agent,
        metadata: { agent_key: agent, plan: o.plan },
        subscription: o.sub,
        payment_status: "paid",
      },
    },
  };
}

/** Stripe's state becomes `o`, and Stripe posts the subscription event that says so. */
export function stripeChange(kit: BillingKit, o: StripeSubscriptionOpts & { readonly type?: SubscriptionEventType; readonly id?: string }): Promise<Response> {
  kit.stripe.subscriptions.set(o.sub, stripeSubscription(o));
  return postStripe(subscriptionEvent(o));
}
