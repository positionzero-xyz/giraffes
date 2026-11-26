import { z } from "zod";
import type { Fetch } from "../box/host";
import type { StripeConfig } from "../config";
import { CHANNEL_IDS, type AgentKey, type Brand, type EpochMs } from "../domain";
import { PAID_PLANS, SUBSCRIPTION_STATUSES, type CustomerId, type PaidPlan, type PlanRules, type Subscription, type SubscriptionId } from "./plan";
import { formBody, LEGACY_PRICE_KEYS, PRICE_NAMES, priceKey, STRIPE_API, STRIPE_EVENT_TYPES, type Form, type PriceName } from "./wire";

export const DONE_PATH = "/billing/done";
export const CANCEL_PATH = "/billing/cancel";
const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export type CheckoutRequest = { readonly agent: AgentKey; readonly plan: PaidPlan; readonly idempotencyKey: string };
export type CheckoutId = Brand<string, "CheckoutId">;

/** A failed call carries Stripe's HTTP status, or null when Stripe wasn't reached. */
export type StripeReply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: number | null; readonly detail: string };

export interface StripeApi {
  checkout(req: CheckoutRequest): Promise<StripeReply<{ readonly id: CheckoutId; readonly url: string }>>;
  /** `gone` when the session was no longer open: paid, expired or unknown. */
  expireCheckout(id: CheckoutId): Promise<StripeReply<"expired" | "gone">>;
  portal(customer: CustomerId): Promise<StripeReply<{ readonly url: string }>>;
  /** The subscription as Stripe holds it now, unparsed, or null when Stripe has no such subscription. */
  subscription(id: SubscriptionId): Promise<StripeReply<unknown>>;
}

export interface StripeErasure {
  /** A checkout can complete between the initial read and expiration. */
  closeCheckout(id: CheckoutId, owner: AgentKey): Promise<StripeReply<SubscriptionId | null>>;
  closeSubscription(id: SubscriptionId, owner: AgentKey): Promise<StripeReply<"settled">>;
}

function priceOf(cfg: StripeConfig, plan: PaidPlan): string {
  const price = cfg.prices[plan];
  if (price === null) throw new Error(`no Stripe price for the ${plan} plan`);
  return price;
}

/** The plans /plan sells: `included` only while it has a price, which INCLUDED=on requires. */
export const offeredPlans = (cfg: StripeConfig): readonly PaidPlan[] => PAID_PLANS.filter((p) => cfg.prices[p] !== null);

export function checkoutForm(cfg: StripeConfig, rules: PlanRules, req: CheckoutRequest): Form {
  const form: Form = {
    mode: "subscription",
    client_reference_id: req.agent,
    success_url: `${cfg.publicUrl}${DONE_PATH}`,
    cancel_url: `${cfg.publicUrl}${CANCEL_PATH}`,
    "metadata[agent_key]": req.agent,
    "metadata[plan]": req.plan,
    "subscription_data[metadata][agent_key]": req.agent,
    "subscription_data[metadata][plan]": req.plan,
    "line_items[0][price]": priceOf(cfg, req.plan),
    "line_items[0][quantity]": 1,
  };
  const extra = rules.plusMaxSeats - rules.plusSeats;
  if (req.plan === "plus" && extra > 0) {
    Object.assign(form, {
      "optional_items[0][price]": cfg.prices.seat,
      "optional_items[0][quantity]": 1,
      "optional_items[0][adjustable_quantity][enabled]": "true",
      "optional_items[0][adjustable_quantity][minimum]": 1,
      "optional_items[0][adjustable_quantity][maximum]": extra,
    });
  }
  return form;
}

const CheckoutReply = z.object({ id: z.string().min(1), url: z.string().url() });
const PortalReply = z.object({ url: z.string().url() });
/** Stripe's error message can echo part of the key, so only its type and code reach the logs. */
const ErrorReply = z.object({ error: z.object({ type: z.string().optional(), code: z.string().optional() }) });
const CheckoutState = z.object({
  id: z.string(),
  status: z.enum(["open", "complete", "expired"]),
  client_reference_id: z.string().nullable(),
  subscription: z.string().min(1).nullable(),
  metadata: z.object({ agent_key: z.string().optional() }).nullable(),
});
const ErasingSubscription = z.object({
  id: z.string(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  metadata: z.object({ agent_key: z.string().optional() }),
});

export function stripeApi(cfg: StripeConfig, rules: PlanRules, fetch: Fetch): StripeApi & StripeErasure {
  async function call(what: string, method: "GET" | "POST" | "DELETE", path: string, o: { form?: Form; idempotencyKey?: string } = {}): Promise<StripeReply<unknown>> {
    let res: Response;
    let body: unknown;
    try {
      res = await fetch(`${STRIPE_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${cfg.secretKey}`,
          "content-type": "application/x-www-form-urlencoded",
          ...(o.idempotencyKey ? { "idempotency-key": o.idempotencyKey } : {}),
        },
        body: method === "POST" ? formBody(o.form ?? {}) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      body = await res.json().catch(() => null);
    } catch (err) {
      return { ok: false, status: null, detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
    if (res.ok) return { ok: true, value: body };
    const e = ErrorReply.safeParse(body);
    return { ok: false, status: res.status, detail: `${what} ${res.status}${e.success ? ` ${e.data.error.type ?? ""} ${e.data.error.code ?? ""}`.trimEnd() : ""}` };
  }

  async function checkoutState(path: string, id: CheckoutId, owner: AgentKey): Promise<StripeReply<z.infer<typeof CheckoutState>>> {
    const r = await call("checkout read", "GET", path);
    if (!r.ok) return r;
    const parsed = CheckoutState.safeParse(r.value);
    return parsed.success && parsed.data.id === id && parsed.data.client_reference_id === owner
      ? { ok: true, value: parsed.data }
      : { ok: false, status: 200, detail: "checkout identity unverified" };
  }

  return {
    async checkout(req) {
      const r = await call("checkout", "POST", "/checkout/sessions", { form: checkoutForm(cfg, rules, req), idempotencyKey: req.idempotencyKey });
      if (!r.ok) return r;
      const parsed = CheckoutReply.safeParse(r.value);
      return parsed.success
        ? { ok: true, value: { id: parsed.data.id as CheckoutId, url: parsed.data.url } }
        : { ok: false, status: 200, detail: "checkout reply unreadable" };
    },
    async expireCheckout(id) {
      const r = await call("expire", "POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`);
      if (r.ok) return { ok: true, value: "expired" };
      return r.status === 400 || r.status === 404 ? { ok: true, value: "gone" } : r;
    },
    async portal(customer) {
      const form = { customer, configuration: cfg.portalConfiguration, return_url: `${cfg.publicUrl}${DONE_PATH}` };
      const r = await call("portal", "POST", "/billing_portal/sessions", { form });
      if (!r.ok) return r;
      const parsed = PortalReply.safeParse(r.value);
      return parsed.success ? { ok: true, value: { url: parsed.data.url } } : { ok: false, status: 200, detail: "portal reply unreadable" };
    },
    async subscription(id) {
      const r = await call("subscription", "GET", `/subscriptions/${encodeURIComponent(id)}`);
      return !r.ok && r.status === 404 ? { ok: true, value: null } : r;
    },
    async closeCheckout(id, owner) {
      const path = `/checkout/sessions/${encodeURIComponent(id)}`;
      let current = await checkoutState(path, id, owner);
      if (!current.ok) return current;
      if (current.value.status === "open") {
        const expired = await call("expire checkout for erasure", "POST", `${path}/expire`);
        if (!expired.ok && expired.status !== 400) return expired;
        current = await checkoutState(path, id, owner);
        if (!current.ok) return current;
      }
      const checkout = current.value;
      if (checkout.status === "open" || (checkout.status === "complete" && !checkout.subscription)) {
        return { ok: false, status: 200, detail: "checkout termination unverified" };
      }
      if (checkout.metadata?.agent_key) {
        const cleared = await call("clear checkout metadata for erasure", "POST", path, { form: { "metadata[agent_key]": "" } });
        if (!cleared.ok) return cleared;
        const verified = CheckoutState.safeParse(cleared.value);
        if (!verified.success || verified.data.id !== id || verified.data.metadata?.agent_key) {
          return { ok: false, status: 200, detail: "checkout metadata removal unverified" };
        }
      }
      return { ok: true, value: checkout.status === "complete" ? checkout.subscription as SubscriptionId : null };
    },
    async closeSubscription(id, owner) {
      const path = `/subscriptions/${encodeURIComponent(id)}`;
      const r = await call("read subscription for erasure", "GET", path);
      if (!r.ok) return r;
      const subscription = ErasingSubscription.safeParse(r.value);
      if (!subscription.success || subscription.data.id !== id || (subscription.data.metadata.agent_key && subscription.data.metadata.agent_key !== owner)) {
        return { ok: false, status: 200, detail: "subscription identity unverified" };
      }
      const current = subscription.data;
      const closed = current.status === "canceled" || current.status === "incomplete_expired";
      if (current.metadata.agent_key) {
        const cleared = await call("clear subscription metadata for erasure", "POST", path, { form: { "metadata[agent_key]": "" } });
        if (!cleared.ok) return cleared;
        const verified = ErasingSubscription.safeParse(cleared.value);
        if (!verified.success || verified.data.id !== id || verified.data.metadata.agent_key) {
          return { ok: false, status: 200, detail: "subscription metadata removal unverified" };
        }
      }
      if (closed) return { ok: true, value: "settled" };
      const canceled = await call("cancel subscription for erasure", "DELETE", path);
      if (!canceled.ok) return canceled;
      const verified = ErasingSubscription.safeParse(canceled.value);
      return verified.success && verified.data.id === id && verified.data.status === "canceled" && !verified.data.metadata.agent_key
        ? { ok: true, value: "settled" }
        : { ok: false, status: 200, detail: "subscription cancellation unverified" };
    },
  };
}

const utf8 = new TextEncoder();

function hexBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

/**
 * The `Stripe-Signature` header is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.payload">`, with one v1
 * per active signing secret. `crypto.subtle.verify` compares in constant time.
 */
export async function verifySignature(payload: string, header: string | null, secret: string, now: EpochMs): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  if (!t || !/^\d+$/.test(t) || Math.abs(now - Number(t) * 1000) > SIGNATURE_TOLERANCE_MS) return false;
  const key = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = utf8.encode(`${t}.${payload}`);
  for (const [k, v] of parts) {
    const sig = k === "v1" && v ? hexBytes(v) : null;
    if (sig && (await crypto.subtle.verify("HMAC", key, sig, signed))) return true;
  }
  return false;
}


/** Which subscription an event is about and whose DO handles it; the state itself is fetched from Stripe. */
export type BillingEvent = { readonly id: string; readonly subscription: SubscriptionId; readonly owner: AgentKey; readonly checkout?: CheckoutId };

type ParsedEvent =
  | { readonly kind: "event"; readonly event: BillingEvent }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

const AGENT_KEY = new RegExp(`^p:(${CHANNEL_IDS.join("|")}):[^:]+$`);
const Metadata = z.record(z.string(), z.string()).nullish();
const Envelope = z.object({ id: z.string().min(1), type: z.string(), data: z.object({ object: z.unknown() }) });
const Session = z.object({ id: z.string().min(1).optional(), mode: z.string(), client_reference_id: z.string().nullish(), metadata: Metadata, subscription: z.string().nullish() });
const EventSubscription = z.object({ id: z.string().min(1), metadata: Metadata });

const agentKey = (raw: string | null | undefined): AgentKey | null => (raw && AGENT_KEY.test(raw) ? (raw as AgentKey) : null);
const paidPlan = (raw: string | null | undefined): PaidPlan | null => (raw === "ai" ? "included" : (PAID_PLANS.find((p) => p === raw) ?? null));

export function parseEvent(raw: unknown): ParsedEvent {
  const env = Envelope.safeParse(raw);
  if (!env.success) return { kind: "invalid", reason: "not a Stripe event" };
  const { id, type } = env.data;

  if (type === "checkout.session.completed") {
    const s = Session.safeParse(env.data.data.object);
    if (!s.success) return { kind: "invalid", reason: "unreadable checkout session" };
    if (s.data.mode !== "subscription" || !s.data.subscription) return { kind: "ignored", reason: "not a subscription checkout" };
    const owner = agentKey(s.data.client_reference_id ?? s.data.metadata?.agent_key);
    if (!owner) return { kind: "ignored", reason: "checkout without our agent key" };
    const checkout = s.data.id;
    return { kind: "event", event: { id, subscription: s.data.subscription as SubscriptionId, owner, ...(checkout ? { checkout: checkout as CheckoutId } : {}) } };
  }

  if (!(STRIPE_EVENT_TYPES as readonly string[]).includes(type)) return { kind: "ignored", reason: `event type ${type}` };
  const sub = EventSubscription.safeParse(env.data.data.object);
  if (!sub.success) return { kind: "invalid", reason: "unreadable subscription" };
  const owner = agentKey(sub.data.metadata?.agent_key);
  if (!owner) return { kind: "ignored", reason: "subscription without our agent key" };
  return { kind: "event", event: { id, subscription: sub.data.id as SubscriptionId, owner } };
}

const Price = z.object({ id: z.string(), product: z.union([z.string(), z.object({ id: z.string() })]), lookup_key: z.string().nullish() });
const Item = z.object({ price: Price, quantity: z.number().int().nullish() });
const StripeSubscription = z.object({
  id: z.string().min(1),
  status: z.enum(SUBSCRIPTION_STATUSES),
  customer: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  metadata: Metadata,
  items: z.object({ data: z.array(Item) }),
});

export type SubscriptionRead =
  | { readonly kind: "ours"; readonly subscription: Subscription }
  | { readonly kind: "not_ours"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

const idOf = (x: string | { readonly id: string }) => (typeof x === "string" ? x : x.id);

/** By product or lookup key rather than price id, so a price replaced by `stripe-setup.ts` still counts for those on it. */
function priceName(price: z.infer<typeof Price>): PriceName | null {
  const key = (k: string | null | undefined) => (k ? (LEGACY_PRICE_KEYS[k] ?? PRICE_NAMES.find((n) => priceKey(n) === k) ?? null) : null);
  return key(idOf(price.product)) ?? key(price.lookup_key);
}

export function parseSubscription(raw: unknown, rules: PlanRules): SubscriptionRead {
  if (raw === null) return { kind: "not_ours", reason: "no such subscription" };
  const sub = StripeSubscription.safeParse(raw);
  if (!sub.success) return { kind: "invalid", reason: "unreadable subscription" };
  const owner = agentKey(sub.data.metadata?.agent_key);
  if (!owner) return { kind: "not_ours", reason: "subscription without our agent key" };
  const items = sub.data.items.data.map((i) => ({ name: priceName(i.price), quantity: i.quantity ?? 1 }));
  const plan = PAID_PLANS.find((p) => items.some((i) => i.name === p)) ?? paidPlan(sub.data.metadata?.plan);
  if (!plan) return { kind: "not_ours", reason: "subscription for none of our prices" };
  const extra = items.filter((i) => i.name === "seat").reduce((n, i) => n + i.quantity, 0);
  return {
    kind: "ours",
    subscription: {
      id: sub.data.id as SubscriptionId,
      owner,
      customer: sub.data.customer ? (idOf(sub.data.customer) as CustomerId) : null,
      plan,
      status: sub.data.status,
      seats: plan === "plus" ? Math.min(rules.plusSeats + extra, rules.plusMaxSeats) : 1,
    },
  };
}
