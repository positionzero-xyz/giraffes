import { z } from "zod";
import type { Fetch } from "../box/host";
import type { StripeConfig } from "../config";
import { CHANNEL_IDS, type AgentKey, type EpochMs } from "../domain";
import { PAID_PLANS, SUBSCRIPTION_STATUSES, type PaidPlan, type PlanRules, type Subscription, type SubscriptionId } from "./plan";
import { formBody, STRIPE_API, STRIPE_EVENT_TYPES, type Form } from "./wire";

export const DONE_PATH = "/billing/done";
const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export type CheckoutRequest = { readonly agent: AgentKey; readonly plan: PaidPlan; readonly idempotencyKey: string };
export type CheckoutResult = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly detail: string };

export interface StripeApi {
  checkout(req: CheckoutRequest): Promise<CheckoutResult>;
}


export function checkoutForm(cfg: StripeConfig, rules: PlanRules, req: CheckoutRequest): Form {
  const done = `${cfg.publicUrl}${DONE_PATH}`;
  const form: Form = {
    mode: "subscription",
    client_reference_id: req.agent,
    success_url: done,
    cancel_url: done,
    "metadata[agent_key]": req.agent,
    "metadata[plan]": req.plan,
    "subscription_data[metadata][agent_key]": req.agent,
    "subscription_data[metadata][plan]": req.plan,
    "line_items[0][price]": cfg.prices[req.plan],
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

const CheckoutReply = z.object({ url: z.string().url() });
/** Stripe's error message can echo part of the key, so only its type and code reach the logs. */
const ErrorReply = z.object({ error: z.object({ type: z.string().optional(), code: z.string().optional() }) });

export function stripeApi(cfg: StripeConfig, rules: PlanRules, fetch: Fetch): StripeApi {
  return {
    async checkout(req) {
      let res: Response;
      let body: unknown;
      try {
        res = await fetch(`${STRIPE_API}/checkout/sessions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${cfg.secretKey}`,
            "content-type": "application/x-www-form-urlencoded",
            "idempotency-key": req.idempotencyKey,
          },
          body: formBody(checkoutForm(cfg, rules, req)),
          signal: AbortSignal.timeout(15_000),
        });
        body = await res.json().catch(() => null);
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
      }
      if (!res.ok) {
        const e = ErrorReply.safeParse(body);
        return { ok: false, detail: `checkout ${res.status}${e.success ? ` ${e.data.error.type ?? ""} ${e.data.error.code ?? ""}`.trimEnd() : ""}` };
      }
      const parsed = CheckoutReply.safeParse(body);
      return parsed.success ? { ok: true, url: parsed.data.url } : { ok: false, detail: "checkout reply unreadable" };
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


export type BillingEvent = { readonly id: string; readonly subscription: Subscription };

type ParsedEvent =
  | { readonly kind: "event"; readonly event: BillingEvent }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

const AGENT_KEY = new RegExp(`^p:(${CHANNEL_IDS.join("|")}):[^:]+$`);
const Metadata = z.record(z.string(), z.string()).nullish();
const Envelope = z.object({ id: z.string().min(1), type: z.string(), created: z.number().int(), data: z.object({ object: z.unknown() }) });
const Session = z.object({
  mode: z.string(),
  client_reference_id: z.string().nullish(),
  metadata: Metadata,
  subscription: z.string().nullish(),
  payment_status: z.string(),
});
const Item = z.object({ price: z.object({ id: z.string() }), quantity: z.number().int().nullish(), current_period_end: z.number().int().nullish() });
const StripeSubscription = z.object({
  id: z.string().min(1),
  status: z.enum(SUBSCRIPTION_STATUSES),
  metadata: Metadata,
  current_period_end: z.number().int().nullish(),
  items: z.object({ data: z.array(Item) }),
});

const agentKey = (raw: string | null | undefined): AgentKey | null => (raw && AGENT_KEY.test(raw) ? (raw as AgentKey) : null);
const paidPlan = (raw: string | null | undefined): PaidPlan | null => PAID_PLANS.find((p) => p === raw) ?? null;

/**
 * Newer API versions moved `current_period_end` from the subscription onto its items, so either is read.
 */
export function parseEvent(raw: unknown, cfg: StripeConfig, rules: PlanRules): ParsedEvent {
  const env = Envelope.safeParse(raw);
  if (!env.success) return { kind: "invalid", reason: "not a Stripe event" };
  const { id, type, created } = env.data;
  const eventAt = (created * 1000) as EpochMs;

  if (type === "checkout.session.completed") {
    const s = Session.safeParse(env.data.data.object);
    if (!s.success) return { kind: "invalid", reason: "unreadable checkout session" };
    if (s.data.mode !== "subscription" || !s.data.subscription) return { kind: "ignored", reason: "not a subscription checkout" };
    const owner = agentKey(s.data.client_reference_id ?? s.data.metadata?.agent_key);
    const plan = paidPlan(s.data.metadata?.plan);
    if (!owner || !plan) return { kind: "ignored", reason: "checkout without our agent key or plan" };
    const paid = s.data.payment_status === "paid" || s.data.payment_status === "no_payment_required";
    return {
      kind: "event",
      event: {
        id,
        subscription: {
          id: s.data.subscription as SubscriptionId,
          owner,
          plan,
          status: paid ? "active" : "incomplete",
          periodEnd: 0 as EpochMs,
          eventAt,
          seats: plan === "plus" ? rules.plusSeats : 1,
        },
      },
    };
  }

  if (!(STRIPE_EVENT_TYPES as readonly string[]).includes(type)) return { kind: "ignored", reason: `event type ${type}` };
  const sub = StripeSubscription.safeParse(env.data.data.object);
  if (!sub.success) return { kind: "invalid", reason: "unreadable subscription" };
  const owner = agentKey(sub.data.metadata?.agent_key);
  if (!owner) return { kind: "ignored", reason: "subscription without our agent key" };
  const items = sub.data.items.data;
  const priced = (price: string) => items.find((i) => i.price.id === price);
  const plan = PAID_PLANS.find((p) => priced(cfg.prices[p])) ?? paidPlan(sub.data.metadata?.plan);
  if (!plan) return { kind: "ignored", reason: "subscription for none of our prices" };
  const extra = priced(cfg.prices.seat)?.quantity ?? 0;
  const ends = [sub.data.current_period_end, ...items.map((i) => i.current_period_end)].filter((t): t is number => typeof t === "number");
  return {
    kind: "event",
    event: {
      id,
      subscription: {
        id: sub.data.id as SubscriptionId,
        owner,
        plan,
        status: sub.data.status,
        periodEnd: ((ends.length > 0 ? Math.max(...ends) : 0) * 1000) as EpochMs,
        eventAt,
        seats: plan === "plus" ? Math.min(rules.plusSeats + extra, rules.plusMaxSeats) : 1,
      },
    },
  };
}
