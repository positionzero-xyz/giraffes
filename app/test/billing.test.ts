import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { planAllowsBox, planOf, type CustomerId, type PlanRules, type Subscription, type SubscriptionId } from "../src/billing/plan";
import { d1Billing, type BillingStore } from "../src/billing/store";
import { checkoutForm, offeredPlans, parseEvent, parseSubscription, stripeApi, verifySignature, type CheckoutId } from "../src/billing/stripe";
import { DEFAULT_AMOUNTS, stripeSetup } from "../src/billing/setup";
import { formBody, STRIPE_EVENT_TYPES } from "../src/billing/wire";
import { boxMessage } from "../src/box/machine";
import { loadConfig, type Env } from "../src/config";
import type { AgentKey, EpochMs, MicroUsd } from "../src/domain";
import { HAIKU_5_5 } from "../src/model/providers";
import { NOTICES } from "../src/notices";
import worker from "../src/worker";
import {
  billingOn,
  chat,
  checkoutEvent,
  devChat,
  fakeBox,
  fakeProvider,
  INCLUDED_VARS,
  local,
  postStripe,
  quiet,
  schedule,
  scripted,
  scriptedChannel,
  signStripe,
  STRIPE_VARS,
  stripeChange,
  stripeSubscription,
  subscriptionEvent,
  turn,
  type BillingKit,
  type DevChat,
} from "./testkit";

const NOTICE = NOTICES.en;

const quietCheckin = () => turn({ actions: [quiet()] });
const agent = (user: string) => `p:dev:${user}` as AgentKey;
const codeIn = (text: string) => text.match(/\/join ([A-Z0-9]{6})$/)?.[1] ?? "";

async function row(sub: string) {
  return env.LEDGER.prepare("SELECT plan, status, seats, customer_id FROM billing_subscription WHERE id = ?").bind(sub).first();
}

async function pay(kit: BillingKit, c: DevChat, user: string, plan: "standard" | "plus" | "included", o: { extraSeats?: number } = {}) {
  const res = await stripeChange(kit, { user, sub: `sub_${user}`, plan, status: "active", type: "customer.subscription.created", extraSeats: o.extraSeats });
  expect(res.status).toBe(200);
  await c.settle();
}

describe("plan rules", () => {
  const rules: PlanRules = { trialDays: 14, plusSeats: 3, plusMaxSeats: 6 };
  const now = local("2099-11-04T10:00");
  const later = (days: number) => (now + days * 86_400_000) as EpochMs;
  const id = "sub_1" as SubscriptionId;
  const trial = { trialEndsAt: later(14), own: null, seat: null };

  test("a paid plan beats a seat, a seat beats included, and included beats the trial", () => {
    expect(planOf({ ...trial, own: { id, plan: "standard" }, seat: { id, owner: agent("o") } }, now, true, rules)).toEqual({ kind: "standard" });
    expect(planOf({ ...trial, own: { id, plan: "included" }, seat: { id, owner: agent("o") } }, now, true, rules)).toEqual({ kind: "plus", role: "member" });
    expect(planOf({ ...trial, own: { id, plan: "included" } }, now, true, rules)).toEqual({ kind: "included" });
    expect(planOf(trial, now, true, rules)).toEqual({ kind: "trial", endsAt: later(14) });
  });

  test("the trial ends at its end with billing on, never with billing off, and a missing row is a trial not started", () => {
    expect(planOf(trial, later(14), true, rules)).toEqual({ kind: "lapsed" });
    expect(planOf(trial, later(400), false, rules)).toEqual({ kind: "trial", endsAt: null });
    expect(planOf(null, now, true, rules)).toEqual({ kind: "trial", endsAt: later(14) });
  });

  test("the box comes with trial, standard and plus, not with included or lapsed", () => {
    expect((["trial", "standard", "plus", "included", "lapsed"] as const).filter(planAllowsBox)).toEqual(["trial", "standard", "plus"]);
  });

});

describe("configuration", () => {
  const load = (vars: Record<string, string>) => loadConfig({ MODEL_BACKEND: "scripted", DEV_MODE: "1", ...vars } as unknown as Env).billing;

  test("BILLING defaults to off with the default rules", () => {
    expect(load({})).toEqual({ on: false, rules: { trialDays: 14, plusSeats: 3, plusMaxSeats: 6 } });
  });

  test("the included plan's price is needed only while INCLUDED is on, and nothing sells it otherwise", () => {
    const on = load({ ...STRIPE_VARS, ...INCLUDED_VARS, STRIPE_PRICE_INCLUDED: "price_included" });
    expect(on.on && on.stripe.prices.included).toBe("price_included");
    expect(() => load({ ...STRIPE_VARS, ...INCLUDED_VARS })).toThrow("STRIPE_PRICE_INCLUDED");
    const off = load({ ...STRIPE_VARS, STRIPE_PRICE_INCLUDED: "price_included" });
    expect(off.on && offeredPlans(off.stripe)).toEqual(["standard", "plus"]);
  });

  test.each(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_STANDARD", "STRIPE_PRICE_PLUS", "STRIPE_PRICE_SEAT", "STRIPE_PORTAL_CONFIGURATION", "PUBLIC_URL", "OPERATOR_CHAT"])(
    "BILLING=on without %s fails at load",
    (name) => {
      const vars: Record<string, string> = { ...STRIPE_VARS };
      delete vars[name];
      expect(() => load(vars)).toThrow(name);
    },
  );

  test("bad rule values fail at load", () => {
    expect(load({ TRIAL_DAYS: "30" }).rules).toMatchObject({ trialDays: 30 });
    expect(() => load({ PLUS_SEATS: "4", PLUS_MAX_SEATS: "3" })).toThrow("PLUS_MAX_SEATS");
    expect(() => load({ ...STRIPE_VARS, PUBLIC_URL: "giraffes.test" })).toThrow("PUBLIC_URL");
    expect(() => load({ BILLING: "yes" })).toThrow("BILLING");
  });
});

describe("stripe boundary", () => {
  const kit = billingOn();
  const { stripe: cfg, rules } = kit.config;

  test("the signature is HMAC-SHA256 over 't.payload'; a wrong secret, a changed body, a stale or missing header fail", async () => {
    const now = (Math.floor(Date.now() / 1000) * 1000) as EpochMs;
    const body = '{"id":"evt_1"}';
    const secret = STRIPE_VARS.STRIPE_WEBHOOK_SECRET;
    expect(await verifySignature(body, signStripe(body, now), secret, now)).toBe(true);
    expect(await verifySignature(body, `${signStripe(body, now, "whsec_other")},${signStripe(body, now).split(",")[1]}`, secret, now)).toBe(true);
    expect(await verifySignature(body, signStripe(body, now, "whsec_other"), secret, now)).toBe(false);
    expect(await verifySignature('{"id":"evt_2"}', signStripe(body, now), secret, now)).toBe(false);
    expect(await verifySignature(body, signStripe(body, now - 5 * 60_000), secret, now)).toBe(true);
    expect(await verifySignature(body, signStripe(body, now - 5 * 60_000 - 1000), secret, now)).toBe(false);
    expect(await verifySignature(body, null, secret, now)).toBe(false);
    expect(await verifySignature(body, "t=abc,v1=zz", secret, now)).toBe(false);
  });

  test("a Checkout Session is a form-encoded subscription keyed to the person, with extra Plus places as an optional item", async () => {
    const sent: { url: string; headers: Headers; body: string }[] = [];
    const api = stripeApi(cfg, rules, async (url, init) => {
      sent.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
      return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    });

    expect(await api.checkout({ agent: agent("ann"), plan: "plus", idempotencyKey: "k1" })).toEqual({ ok: true, value: { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" } });

    expect(sent[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(sent[0].headers.get("authorization")).toBe("Bearer sk_test_fake");
    expect(sent[0].headers.get("idempotency-key")).toBe("k1");
    expect(sent[0].headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toEqual({
      mode: "subscription",
      client_reference_id: "p:dev:ann",
      success_url: "https://giraffes.test/billing/done",
      cancel_url: "https://giraffes.test/billing/cancel",
      "metadata[agent_key]": "p:dev:ann",
      "metadata[plan]": "plus",
      "subscription_data[metadata][agent_key]": "p:dev:ann",
      "subscription_data[metadata][plan]": "plus",
      "line_items[0][price]": "price_plus",
      "line_items[0][quantity]": "1",
      "optional_items[0][price]": "price_seat",
      "optional_items[0][quantity]": "1",
      "optional_items[0][adjustable_quantity][enabled]": "true",
      "optional_items[0][adjustable_quantity][minimum]": "1",
      "optional_items[0][adjustable_quantity][maximum]": "3",
    });
    expect(formBody({ "a[b]": "x y" })).toBe("a%5Bb%5D=x%20y");
    expect(Object.keys(checkoutForm(cfg, rules, { agent: agent("ann"), plan: "standard", idempotencyKey: "k" }))).not.toContain("optional_items[0][price]");
  });

  test("leaving Checkout without paying shows a cancellation page with no charge", async () => {
    const { cancel_url, success_url } = checkoutForm(cfg, rules, { agent: agent("ann"), plan: "standard", idempotencyKey: "cancel" });
    const bindings = { ...env, ...STRIPE_VARS };
    const cancelled = await worker.fetch(new Request(String(cancel_url)), bindings);
    expect(cancelled.status).toBe(200);
    expect(cancelled.headers.get("content-type")).toContain("text/html");
    expect(await cancelled.text()).toContain("You weren't charged for this checkout.");
    expect(await (await worker.fetch(new Request(String(success_url)), bindings)).text()).toContain("All done.");
  });

  test("the subscription read, session expiry and portal session call Stripe as documented", async () => {
    const sent: { method: string; url: string; body: string }[] = [];
    let status = 200;
    const api = stripeApi(cfg, rules, async (url, init) => {
      sent.push({ method: init?.method ?? "GET", url, body: String(init?.body ?? "") });
      return Response.json({ id: "x", url: "https://billing.stripe.com/p/session_1" }, { status });
    });

    expect(await api.subscription("sub_1" as SubscriptionId)).toEqual({ ok: true, value: { id: "x", url: "https://billing.stripe.com/p/session_1" } });
    expect(await api.expireCheckout("cs_1" as CheckoutId)).toEqual({ ok: true, value: "expired" });
    expect(await api.portal("cus_1" as CustomerId)).toEqual({ ok: true, value: { url: "https://billing.stripe.com/p/session_1" } });
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://api.stripe.com/v1/subscriptions/sub_1",
      "POST https://api.stripe.com/v1/checkout/sessions/cs_1/expire",
      "POST https://api.stripe.com/v1/billing_portal/sessions",
    ]);
    expect(Object.fromEntries(new URLSearchParams(sent[2].body))).toEqual({
      customer: "cus_1",
      configuration: "bpc_fake",
      return_url: "https://giraffes.test/billing/done",
    });

    status = 404;
    expect(await api.subscription("sub_gone" as SubscriptionId)).toEqual({ ok: true, value: null });
    expect(await api.expireCheckout("cs_gone" as CheckoutId)).toEqual({ ok: true, value: "gone" });
    status = 400;
    expect(await api.expireCheckout("cs_paid" as CheckoutId)).toEqual({ ok: true, value: "gone" });
    status = 503;
    expect(await api.expireCheckout("cs_1" as CheckoutId)).toMatchObject({ ok: false, status: 503 });
    expect(await api.subscription("sub_1" as SubscriptionId)).toMatchObject({ ok: false, status: 503 });
  });

  test("a Stripe error or a network failure is a failed checkout whose detail carries no key", async () => {
    const refused = stripeApi(cfg, rules, async () =>
      Response.json({ error: { type: "invalid_request_error", code: "api_key_invalid", message: "Invalid API Key provided: sk_test_****fake" } }, { status: 401 }),
    );
    const r = await refused.checkout({ agent: agent("ann"), plan: "standard", idempotencyKey: "k" });
    expect(r).toEqual({ ok: false, status: 401, detail: "checkout 401 invalid_request_error api_key_invalid" });
    const down = stripeApi(cfg, rules, async () => {
      throw new TypeError("fetch failed");
    });
    expect(await down.checkout({ agent: agent("ann"), plan: "standard", idempotencyKey: "k" })).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain("sk_test");
  });

  test("a subscription read from Stripe gives its owner, customer, plan and capped Plus places", () => {
    const plus = stripeSubscription({ user: "ann", sub: "sub_1", plan: "plus", status: "past_due", extraSeats: 10, customer: "cus_ann" });
    expect(parseSubscription(plus, rules)).toEqual({
      kind: "ours",
      subscription: { id: "sub_1", owner: "p:dev:ann", customer: "cus_ann", plan: "plus", status: "past_due", seats: 6 },
    });
    const byMetadata = { ...stripeSubscription({ user: "ann", sub: "sub_2", plan: "included", status: "active" }), items: { data: [] } };
    expect(parseSubscription(byMetadata, rules)).toMatchObject({ kind: "ours", subscription: { plan: "included", seats: 1 } });
    const legacy = stripeSubscription({ user: "ann", sub: "sub_4", plan: "included", status: "active" });
    legacy.items.data[0].price = { id: "price_old", object: "price", product: "giraffes_ai", lookup_key: "giraffes_ai" };
    legacy.metadata.plan = "ai";
    expect(parseSubscription(legacy, rules)).toMatchObject({ kind: "ours", subscription: { plan: "included" } });
    expect(parseSubscription({ ...legacy, items: { data: [] } }, rules)).toMatchObject({ kind: "ours", subscription: { plan: "included" } });
    expect(parseSubscription({ ...plus, metadata: {} }, rules)).toMatchObject({ kind: "not_ours" });
    expect(parseSubscription(null, rules)).toMatchObject({ kind: "not_ours" });
    expect(parseSubscription({ id: "sub_3" }, rules)).toMatchObject({ kind: "invalid" });
  });

  test("our prices are known by product or lookup key, so a replaced price still counts the places people pay for", () => {
    const replaced = (name: string, quantity: number) => ({ price: { id: `price_${name}_2025`, product: `giraffes_${name}`, lookup_key: null }, quantity });
    const plus = { ...stripeSubscription({ user: "ann", sub: "sub_1", plan: "plus", status: "active" }), items: { data: [replaced("plus", 1), replaced("seat", 2)] } };
    expect(parseSubscription(plus, rules)).toMatchObject({ kind: "ours", subscription: { plan: "plus", seats: 5 } });

    const keyed = (name: string) => ({ price: { id: `price_${name}_manual`, product: { id: "prod_manual" }, lookup_key: `giraffes_${name}` }, quantity: 1 });
    const switched = { ...stripeSubscription({ user: "ann", sub: "sub_2", plan: "plus", status: "active" }), items: { data: [keyed("standard")] } };
    expect(parseSubscription(switched, rules)).toMatchObject({ kind: "ours", subscription: { plan: "standard", seats: 1 } });
  });

  test("an event names the subscription and the owner's agent key, and carries no state", () => {
    expect(parseEvent(checkoutEvent({ user: "ann", sub: "sub_1", plan: "plus", id: "evt_c" }))).toEqual({
      kind: "event",
      event: { id: "evt_c", subscription: "sub_1", owner: "p:dev:ann" },
    });
    expect(parseEvent(subscriptionEvent({ user: "ann", sub: "sub_1", plan: "plus", status: "canceled", id: "evt_s" }))).toEqual({
      kind: "event",
      event: { id: "evt_s", subscription: "sub_1", owner: "p:dev:ann" },
    });
  });
});

describe("billing off", () => {
  test("/plan says the free beta, the seat commands say plans aren't on, nothing is paid for, and nobody lapses", async () => {
    const model = scripted([chat("Hi!"), quietCheckin()]);
    const c = await devChat("bea", { model, at: "2099-11-04T10:00" });

    await c.say("/plan");
    await c.say("/invite");
    await c.say("/join ABC234");
    await c.say("/leave");
    expect(await c.received()).toEqual(["You're on the free beta, so there's nothing to pay.", NOTICE.billingOff, NOTICE.billingOff, NOTICE.billingOff]);

    c.clock.set(local("2099-12-30T10:00"));
    await c.say("hello");

    expect(await c.received()).toEqual(["Hi!"]);
    expect((await c.snapshot()).plan).toEqual({ kind: "trial", endsAt: null });
    const res = await postStripe(checkoutEvent({ user: "bea", sub: "sub_x", plan: "standard" }), { vars: { BILLING: "off" } });
    expect(res.status).toBe(404);
  });

  test("a person from the beta starts the full trial on their first message after billing turns on", async () => {
    const beta = await devChat("ben", { model: scripted([chat("Hi!"), chat("Still here.")]), at: "2099-11-04T10:00" });
    await beta.say("hello");
    await beta.received();

    const kit = billingOn();
    const c = await devChat("ben", { model: beta.model, at: "2099-12-30T10:00", billing: kit.deps });
    await c.say("hello again");

    expect(await c.received()).toEqual(["Still here."]);
    expect((await c.snapshot()).plan).toEqual({ kind: "trial", endsAt: local("2100-01-13T10:00") });
  });
});

describe("trial and lapse", () => {
  test("the first message starts the trial; after it ends no model is called and one notice goes out per local day", async () => {
    const kit = billingOn();
    const box = fakeBox({ signedIn: true });
    const model = scripted([chat("Hi!")]);
    const c = await devChat("cat", { model, at: "2099-11-04T10:00", billing: kit.deps, box: box.deps });
    await c.say("hello");
    await c.say("/claude");
    expect((await c.snapshot()).plan).toEqual({ kind: "trial", endsAt: local("2099-11-18T10:00") });
    await c.received();

    c.clock.set(local("2099-11-18T10:00"));
    await c.say("are you there?");
    await c.say("hello?");
    c.clock.set(local("2099-11-19T08:00"));
    await c.say("anyone?");

    expect(await c.received()).toEqual([NOTICE.lapsed, boxMessage("retiring", "en", null, "2 December 2099").text, NOTICE.lapsed]);
    expect(model.calls).toHaveLength(1);
    expect(box.parses).toEqual([]);
    expect(c.logs("turn").filter((t) => t.eventKind === "message").map((t) => t.outcome)).toEqual(["acted", "no_model", "lapsed", "lapsed", "lapsed"]);
  });

  test("a reminder the person asked for still arrives after the trial ends, written by code, with no model call", async () => {
    const kit = billingOn({ TRIAL_DAYS: "1" });
    const model = scripted([turn({ actions: [schedule("vet", "2099-11-06T09:30", "Call the vet"), { type: "send", text: "Will do." }] })]);
    const c = await devChat("dot", { model, at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("remind me on the 6th at 9:30 to call the vet");
    expect(await c.received()).toEqual(["Will do."]);

    c.clock.set(local("2099-11-06T09:30"));
    await c.settle();

    expect(await c.received()).toEqual([NOTICE.reminder("Call the vet")]);
    expect(model.calls).toHaveLength(1);
  });

  test("/plan during the trial gives the days left and a Checkout link per plan on sale, which stay out of the history", async () => {
    const kit = billingOn();
    const model = scripted([]);
    const c = await devChat("dee", { model, at: "2099-11-04T10:00", billing: kit.deps });

    await c.say("/plan", { id: "plan-1" });

    const [text] = await c.received();
    expect(text.split("\n").slice(0, 2)).toEqual(["You're on the free trial, with 14 days left.", "Pick a plan:"]);
    for (const p of ["standard", "plus"]) expect(text).toContain(`https://checkout.stripe.test/${p}/`);
    expect(text).not.toContain("included");
    expect(kit.stripe.checkouts).toEqual(
      ["standard", "plus"].map((plan) => ({ agent: "p:dev:dee", plan, idempotencyKey: `p:dev:dee|dev:plan-1|${plan}` })),
    );
    expect(JSON.stringify((await c.snapshot()).turns)).not.toContain("checkout.stripe.test");
    expect(model.calls).toHaveLength(0);

    kit.stripe.failing = true;
    await c.say("/plan");
    expect(await c.received()).toEqual([`You're on the free trial, with 14 days left.\n${NOTICE.noLinks}`]);
  });

  test("a payment after the trial lapsed is announced and the model answers again", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const model = scripted([chat("Welcome back.")]);
    const c = await devChat("eve", { model, at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("/plan");
    expect((await c.received())[0]).toMatch(/^You have no active plan, so I can't answer messages for now\.\nPick a plan:/);

    kit.stripe.subscriptions.set("sub_eve", stripeSubscription({ user: "eve", sub: "sub_eve", plan: "standard", status: "active" }));
    const res = await postStripe(checkoutEvent({ user: "eve", sub: "sub_eve", plan: "standard" }));
    expect([res.status, await res.text()]).toEqual([200, "applied"]);
    await c.settle();
    expect(await c.received()).toEqual(["Thanks. Your Standard plan is active."]);

    await c.say("hello");
    expect(await c.received()).toEqual(["Welcome back."]);
    await c.say("/plan");
    expect(await c.received()).toEqual(["You're on the Standard plan.\nTo change or cancel your plan: https://billing.stripe.test/p/cus_eve"]);
  });
});

describe("checkout and the portal", () => {
  test("a new /plan expires the Checkout sessions an earlier one handed out before making new ones", async () => {
    const kit = billingOn();
    const c = await devChat("fin", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("/plan", { id: "plan-a" });
    const first = [...kit.stripe.sessions.keys()];
    kit.stripe.sessions.set(first[1], "complete");

    await c.say("/plan", { id: "plan-b" });

    expect(first.map((id) => kit.stripe.sessions.get(id))).toEqual(["expired", "complete"]);
    expect([...kit.stripe.sessions.values()].filter((s) => s === "open")).toHaveLength(2);
    const [, second] = await c.received();
    expect(second).toContain("Pick a plan:");
  });

  test("when an earlier session can't be expired, no new links go out, and the next /plan tries again", async () => {
    const kit = billingOn();
    const c = await devChat("gus", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("/plan");
    kit.stripe.expiresFailing = true;
    await c.say("/plan");
    expect(kit.stripe.checkouts).toHaveLength(2);

    kit.stripe.expiresFailing = false;
    await c.say("/plan");

    expect((await c.received())[1]).toBe(`You're on the free trial, with 14 days left.\n${NOTICE.noLinks}`);
    expect([...kit.stripe.sessions.values()]).toEqual(["expired", "expired", "open", "open"]);
  });

  test("a person who pays gets a link to manage the plan instead of Checkout links, kept out of the history", async () => {
    const kit = billingOn();
    const c = await devChat("hal", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    await pay(kit, c, "hal", "standard");
    await c.received();

    await c.say("/plan");

    expect(await c.received()).toEqual(["You're on the Standard plan.\nTo change or cancel your plan: https://billing.stripe.test/p/cus_hal"]);
    expect(kit.stripe.portals).toEqual(["cus_hal"]);
    expect(kit.stripe.checkouts).toEqual([]);
    expect(JSON.stringify((await c.snapshot()).turns)).not.toContain("billing.stripe.test");

    kit.stripe.failing = true;
    await c.say("/plan");
    expect(await c.received()).toEqual([`You're on the Standard plan.\n${NOTICE.noPortal}`]);
  });

  test("a second paying subscription alerts the operator immediately and tells the person once", async () => {
    const kit = billingOn();
    const c = await devChat("ike", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    const operator = scriptedChannel();
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (agent) => {
      agent.withDeps({ channels: { line: c.channel, telegram: operator, dev: c.channel }, operatorChat: { channel: "telegram", channelUserId: "4242" } });
    });
    await c.say("/plan");
    await c.received();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    await stripeChange(kit, { user: "ike", sub: "sub_ike_1", plan: "standard", status: "active" });
    expect(operator.delivered).toEqual([]);
    await stripeChange(kit, { user: "ike", sub: "sub_ike_2", plan: "included", status: "active" });
    expect(operator.delivered.map(({ text }) => text)).toEqual([expect.stringContaining("sub_ike_1 sub_ike_2")]);
    await stripeChange(kit, { user: "ike", sub: "sub_ike_2", plan: "included", status: "active" });
    await c.settle();

    expect(operator.delivered).toHaveLength(1);
    expect(await c.received()).toEqual(["Thanks. Your Standard plan is active.", expect.stringContaining("They can review it now")]);
    expect(warnings).toHaveBeenCalledWith({ code: "stripe_duplicate_subscription" });
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("sub_ike_");
    warnings.mockRestore();
    const found = await env.LEDGER.prepare("SELECT owner_key, subscription_ids FROM billing_duplicate").all();
    expect(found.results).toEqual([{ owner_key: "p:dev:ike", subscription_ids: "sub_ike_1 sub_ike_2" }]);
    expect([(await row("sub_ike_1"))?.status, (await row("sub_ike_2"))?.status]).toEqual(["active", "active"]);
  });

  test.each([
    { kind: "retry", language: "en", delivery: "delivery hasn't been confirmed", timing: "another attempt in 30 seconds", billing: "payment statement" },
    { kind: "in_doubt", language: "th", delivery: "ทีมอาจได้รับการแจ้งเตือนแล้ว", timing: "ลองอีกครั้งในอีก 30 วินาที", billing: "รายการเดินบัญชี" },
    { kind: "throw", language: "en", delivery: "may already have received the alert", timing: "another attempt in 30 seconds", billing: "payment statement" },
  ] as const)("retries a $kind operator alert on the alarm and gives the person the next steps in $language", async ({ kind, language, delivery, timing, billing }) => {
    const kit = billingOn();
    const c = await devChat("june", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    const first = kind === "throw" ? { kind } : { kind, afterMs: 30_000 };
    const operator = scriptedChannel([first, { kind: "retry", afterMs: 30_000 }]);
    const deliver = vi.spyOn(operator, "deliver");
    await c.say("/plan");
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (agent, state) => {
      agent.withDeps({ channels: { line: c.channel, telegram: operator, dev: c.channel }, operatorChat: { channel: "telegram", channelUserId: "4242" } });
      state.storage.sql.exec("UPDATE agent SET language = ?", language);
    });
    await c.received();
    await pay(kit, c, "june", "standard");
    await c.received();

    const second = { id: "evt_june_extra", user: "june", sub: "sub_june_extra", plan: "included", status: "active", customer: "cus_june_extra" } as const;
    expect((await stripeChange(kit, second)).status).toBe(200);
    await c.settle();
    expect(deliver).toHaveBeenCalledTimes(1);
    const messages = await c.received();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(delivery);
    expect(messages[0]).toContain(timing);
    expect(messages[0]).toContain(billing);
    expect(messages[0]).not.toContain("/plan");

    expect(await (await stripeChange(kit, second)).text()).toBe("duplicate");
    await c.advanceTo("2099-11-04T10:01");
    expect(operator.delivered).toEqual([expect.objectContaining({ text: expect.stringContaining("sub_june sub_june_extra"), at: local("2099-11-04T10:01") })]);
    expect(deliver.mock.calls.map(([message, at]) => [message.id, at - local("2099-11-04T10:00")])).toEqual([
      [expect.any(String), 0], [deliver.mock.calls[0]?.[0].id, 30_000], [deliver.mock.calls[0]?.[0].id, 60_000],
    ]);
    expect(await c.received()).toEqual([]);
  });

  test.each([{ kind: "failed", detail: "fake refusal" }, { kind: "recipient_gone" }] as const)(
    "reports $kind accurately, retries every five minutes, and stops after three attempts",
    async (result) => {
      const kit = billingOn();
      const c = await devChat("refused", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
      const operator = scriptedChannel();
      const deliver = vi.spyOn(operator, "deliver").mockResolvedValue(result);
      await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (agent) => {
        agent.withDeps({ channels: { line: c.channel, telegram: operator, dev: c.channel }, operatorChat: { channel: "telegram", channelUserId: "4242" } });
      });
      await c.say("/plan");
      await pay(kit, c, "refused", "standard");
      await c.received();
      const extra = { user: "refused", sub: "sub_refused_extra", plan: "included", status: "active" } as const;
      expect((await stripeChange(kit, extra)).status).toBe(200);
      await c.settle();
      expect(await c.received()).toEqual([expect.stringContaining("The billing alert couldn't be delivered. I've scheduled another attempt in 300 seconds. I'll try up to two more times.")]);
      await c.advanceTo("2099-11-04T11:00");
      await stripeChange(kit, extra);
      await c.settle();
      expect(deliver.mock.calls.map(([, at]) => at)).toEqual([
        local("2099-11-04T10:00"), local("2099-11-04T10:05"), local("2099-11-04T10:10"),
      ]);
      expect(operator.delivered).toEqual([]);
      expect(await c.received()).toEqual([]);
    },
  );

  test("backs off a failed receipt write without re-sending a confirmed operator alert", async () => {
    const kit = billingOn();
    const c = await devChat("receipt", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
    const operator = scriptedChannel();
    await runInDurableObject(stub, (agent, { storage }) => {
      agent.withDeps({ channels: { line: c.channel, telegram: operator, dev: c.channel }, operatorChat: { channel: "telegram", channelUserId: "4242" } });
      storage.sql.exec(`CREATE TRIGGER fail_billing_receipt BEFORE UPDATE ON billing_alert
        WHEN NEW.ready_at IS NULL BEGIN SELECT RAISE(ABORT, 'receipt write unavailable'); END`);
    });
    await c.say("/plan");
    await pay(kit, c, "receipt", "standard");
    await c.received();
    const extra = { id: "evt_receipt_extra", user: "receipt", sub: "sub_receipt_extra", plan: "included", status: "active" } as const;
    expect((await stripeChange(kit, extra)).status).toBe(200);
    await c.settle();
    expect(operator.delivered).toHaveLength(1);
    expect(await (await stripeChange(kit, extra)).text()).toBe("duplicate");
    expect(await runInDurableObject(stub, (_, { storage }) => storage.getAlarm())).toBe(local("2099-11-04T10:00:30"));

    await c.advanceTo("2099-11-04T10:00:30");
    expect(operator.delivered).toHaveLength(1);
    expect(await runInDurableObject(stub, (_, { storage }) => storage.getAlarm())).toBe(local("2099-11-04T10:01"));
    await runInDurableObject(stub, (_, { storage }) => { storage.sql.exec("DROP TRIGGER fail_billing_receipt"); });
    await c.advanceTo("2099-11-04T10:10");
    await stripeChange(kit, { ...extra, id: "evt_receipt_later" });
    await c.settle();
    expect(operator.delivered).toHaveLength(1);
    expect(await c.received()).toEqual([expect.stringContaining("I've alerted our billing team")]);
  });

  test("does not re-alert or notify for the same subscriptions after Stripe event dedupe expires", async () => {
    const kit = billingOn();
    const c = await devChat("retained", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    const operator = scriptedChannel();
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (agent) => {
      agent.withDeps({ channels: { line: c.channel, telegram: operator, dev: c.channel }, operatorChat: { channel: "telegram", channelUserId: "4242" } });
    });
    await c.say("/plan");
    await pay(kit, c, "retained", "standard");
    const extra = { user: "retained", sub: "sub_retained_2", plan: "included", status: "active" } as const;
    await stripeChange(kit, extra);
    await c.settle();
    expect(operator.delivered).toHaveLength(1);
    c.clock.set(local("2099-11-20T10:00"));
    await c.settle();
    await c.received();

    await stripeChange(kit, extra);
    await c.settle();
    expect(operator.delivered).toHaveLength(1);
    expect(await c.received()).toEqual([]);
  });
});

describe("stripe webhook", () => {
  test("a bad, stale or missing signature is refused and changes nothing", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const c = await devChat("fay", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    kit.stripe.subscriptions.set("sub_fay", stripeSubscription({ user: "fay", sub: "sub_fay", plan: "standard", status: "active" }));
    const e = checkoutEvent({ user: "fay", sub: "sub_fay", plan: "standard" });
    const body = JSON.stringify(e);

    for (const signature of [signStripe(body, Date.now(), "whsec_other"), signStripe(body, Date.now() - 6 * 60_000), ""]) {
      expect((await postStripe(e, { signature })).status).toBe(400);
    }

    expect(await row("sub_fay")).toBeNull();
    expect((await c.snapshot()).plan.kind).toBe("lapsed");
  });

  test("a duplicate event is applied once", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const c = await devChat("gil", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("/plan");
    await c.received();
    kit.stripe.subscriptions.set("sub_gil", stripeSubscription({ user: "gil", sub: "sub_gil", plan: "included", status: "active" }));
    const e = checkoutEvent({ user: "gil", sub: "sub_gil", plan: "included" });

    expect(await (await postStripe(e)).text()).toBe("applied");
    expect(await (await postStripe(e)).text()).toBe("duplicate");
    await c.settle();

    expect(await c.received()).toEqual(["Thanks. Your AI included plan is active."]);
  });

  test("every event stores what Stripe holds now, whatever its own payload says, and a cancelled one stays cancelled", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const c = await devChat("hu", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("/plan");
    await c.received();
    const hu = { user: "hu", sub: "sub_hu", plan: "standard" } as const;

    await stripeChange(kit, { ...hu, status: "active" });
    await stripeChange(kit, { ...hu, status: "past_due" });
    await stripeChange(kit, { ...hu, status: "unpaid" });
    expect(await row("sub_hu")).toEqual({ plan: "standard", status: "unpaid", seats: 1, customer_id: "cus_hu" });

    kit.stripe.subscriptions.set("sub_hu", stripeSubscription({ ...hu, status: "active" }));
    await postStripe(subscriptionEvent({ ...hu, status: "incomplete" }));
    expect(await row("sub_hu")).toMatchObject({ status: "active" });

    await stripeChange(kit, { ...hu, status: "canceled", type: "customer.subscription.deleted" });
    kit.stripe.subscriptions.set("sub_hu", stripeSubscription({ ...hu, status: "active" }));
    await postStripe(checkoutEvent(hu));
    await c.settle();

    expect(await row("sub_hu")).toMatchObject({ status: "canceled" });
    expect(await c.received()).toEqual(["Thanks. Your Standard plan is active.", NOTICE.lapsed, "Thanks. Your Standard plan is active.", NOTICE.lapsed]);
  });

  test("a checkout seen after its Plus subscription keeps the extra places Stripe holds", async () => {
    const kit = billingOn();
    const c = await devChat("ida", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    await stripeChange(kit, { user: "ida", sub: "sub_ida", plan: "plus", status: "active", extraSeats: 2, type: "customer.subscription.created" });
    await postStripe(checkoutEvent({ user: "ida", sub: "sub_ida", plan: "plus" }));
    await c.settle();

    expect(await row("sub_ida")).toMatchObject({ plan: "plus", status: "active", seats: 5 });
  });

  test("a slow read of an older state can't land after a newer one", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const c = await devChat("ivy", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    const ivy = { user: "ivy", sub: "sub_ivy", plan: "standard" } as const;
    kit.stripe.subscriptions.set("sub_ivy", stripeSubscription({ ...ivy, status: "incomplete" }));
    const release = kit.stripe.holdNextRead();
    const first = postStripe(checkoutEvent(ivy));
    await new Promise((r) => setTimeout(r, 50));

    kit.stripe.subscriptions.set("sub_ivy", stripeSubscription({ ...ivy, status: "active" }));
    const second = postStripe(subscriptionEvent({ ...ivy, status: "active" }));
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([first, second]);
    await c.settle();

    expect(await row("sub_ivy")).toMatchObject({ status: "active" });
    expect((await c.snapshot()).plan).toEqual({ kind: "standard" });
  });

  test("a failed read from Stripe fails the event, and the redelivery applies it", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const c = await devChat("jan", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("/plan");
    await c.received();
    kit.stripe.readsFailing = true;
    const e = subscriptionEvent({ user: "jan", sub: "sub_jan", plan: "included", status: "active" });
    kit.stripe.subscriptions.set("sub_jan", e.data.object);

    expect((await postStripe(e)).status).toBe(500);
    expect(await row("sub_jan")).toBeNull();
    kit.stripe.readsFailing = false;
    expect(await (await postStripe(e)).text()).toBe("applied");
    await c.settle();
    expect(await c.received()).toEqual(["Thanks. Your AI included plan is active."]);
  });

  test("events that aren't ours are acknowledged and ignored", async () => {
    const foreign = subscriptionEvent({ user: "joe", sub: "sub_joe", plan: "standard", status: "active" });
    (foreign.data.object.metadata as Record<string, string>) = {};
    const other = { id: "evt_inv", type: "invoice.paid", created: 1, data: { object: {} } };
    for (const e of [foreign, other]) {
      const res = await postStripe(e);
      expect([res.status, (await res.text()).startsWith("ignored")]).toEqual([200, true]);
    }
    expect(await row("sub_joe")).toBeNull();
    expect((await postStripe({ nope: true })).status).toBe(400);
  });
});

describe("the subscription store", () => {
  test("a stored terminal state is final, and any other state is replaced by the one read from Stripe", async () => {
    const store = d1Billing(env.LEDGER);
    const s = (status: Subscription["status"]): Subscription => ({
      id: "sub_order" as SubscriptionId,
      owner: agent("o"),
      customer: null,
      plan: "standard",
      status,
      seats: 1,
    });
    const after = async (sub: Subscription) => {
      await store.applySubscription(sub, 0 as EpochMs);
      return (await row("sub_order"))?.status;
    };
    expect(await after(s("active"))).toBe("active");
    expect(await after(s("past_due"))).toBe("past_due");
    expect(await after(s("unpaid"))).toBe("unpaid");
    expect(await after(s("incomplete"))).toBe("incomplete");
    expect(await after(s("incomplete_expired"))).toBe("incomplete_expired");
    expect(await after(s("active"))).toBe("incomplete_expired");
  });

  test("past_due keeps paying for 14 days from when it was first seen, then counts as lapsed", async () => {
    const store = d1Billing(env.LEDGER);
    const day = (d: number) => (local("2099-11-04T10:00") + d * 86_400_000) as EpochMs;
    const due: Subscription = { id: "sub_due" as SubscriptionId, owner: agent("due"), customer: null, plan: "standard", status: "past_due", seats: 1 };
    const own = async (at: EpochMs) => (await store.standing(agent("due"), at)).own;

    await store.applySubscription(due, day(0));
    await store.applySubscription(due, day(10));
    expect(await own(day(13.9))).toEqual({ id: "sub_due", plan: "standard" });
    expect(await own(day(14))).toBeNull();

    await store.applySubscription({ ...due, status: "active" }, day(15));
    await store.applySubscription(due, day(16));
    expect(await own(day(29.9))).toEqual({ id: "sub_due", plan: "standard" });
    expect(await own(day(30))).toBeNull();

    const plus: Subscription = { ...due, id: "sub_due_plus" as SubscriptionId, plan: "plus", seats: 3 };
    await store.applySubscription(plus, day(0));
    expect(await store.invite(agent("due"), "DUEDUE", day(1), day(30))).toEqual({ kind: "created" });
    expect(await store.join("DUEDUE", agent("late"), day(14))).toBe("ended");
  });
});

describe("plus seats", () => {
  test("a member pushed out when places are cut holds no seat, so they can join another Plus plan", async () => {
    const store = d1Billing(env.LEDGER);
    const t = (m: number) => (local("2099-11-04T10:00") + m * 60_000) as EpochMs;
    const plus = (owner: string, seats: number): Subscription => ({ id: `sub_${owner}` as SubscriptionId, owner: agent(owner), customer: null, plan: "plus", status: "active", seats });
    await store.applySubscription(plus("big", 4), t(0));
    for (const [i, m] of ["amy", "bob", "cy"].entries()) {
      await store.invite(agent("big"), `BIG00${i}`, t(i), t(999));
      expect(await store.join(`BIG00${i}`, agent(m), t(i))).toBe("joined");
    }

    await store.applySubscription(plus("big", 3), t(10));
    expect((await store.standing(agent("cy"), t(11))).seat).toBeNull();
    await store.applySubscription(plus("other", 3), t(11));
    await store.invite(agent("other"), "OTHER0", t(11), t(999));

    expect(await store.join("OTHER0", agent("cy"), t(12))).toBe("joined");
    expect((await store.standing(agent("cy"), t(13))).seat).toEqual({ id: "sub_other", owner: "p:dev:other" });
    expect(await store.members("sub_big" as SubscriptionId)).toEqual(["p:dev:amy", "p:dev:bob"]);
  });

  test("a join repeated by the person who joined is still joined, and an expired code doesn't work", async () => {
    const store = d1Billing(env.LEDGER);
    const now = local("2099-11-04T10:00");
    const sub: Subscription = { id: "sub_z" as SubscriptionId, owner: agent("zed"), customer: null, plan: "plus", status: "active", seats: 3 };
    await store.applySubscription(sub, now);
    await store.invite(agent("zed"), "AAAAAA", now, (now + 1000) as EpochMs);
    await store.invite(agent("zed"), "BBBBBB", now, (now + 1000) as EpochMs);

    expect(await store.join("AAAAAA", agent("amy"), now)).toBe("joined");
    expect(await store.join("AAAAAA", agent("amy"), (now + 10) as EpochMs)).toBe("joined");
    expect(await store.join("BBBBBB", agent("bob"), (now + 1000) as EpochMs)).toBe("bad_code");
    expect(await store.members(sub.id)).toEqual(["p:dev:amy"]);
  });

  test("the owner invites, a code works once, places are counted, and extra places come from the seat quantity", async () => {
    const kit = billingOn();
    const at = "2099-11-04T10:00";
    const owner = await devChat("kit", { model: scripted([]), at, billing: kit.deps });
    const [mia, noa, ola] = await Promise.all(["mia", "noa", "ola"].map((u) => devChat(u, { model: scripted([]), at, billing: kit.deps })));
    await owner.say("/invite");
    expect(await owner.received()).toEqual(["Only the owner of a Plus plan can invite people. Send /plan to see the plans."]);
    await pay(kit, owner, "kit", "plus");
    expect(await owner.received()).toEqual(["Thanks. Your Plus plan is active. Send /invite to add someone."]);

    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      await owner.say("/invite");
      codes.push(codeIn((await owner.received())[0]));
    }
    expect(new Set(codes).size).toBe(3);

    await mia.say(`/join ${codes[0]}`);
    await noa.say(`/join ${codes[0]}`);
    await noa.say(`/join ${codes[1].toLowerCase()}`);
    await ola.say(`/join ${codes[2]}`);
    expect(await mia.received()).toEqual([NOTICE.join.joined]);
    expect(await noa.received()).toEqual([NOTICE.join.bad_code, NOTICE.join.joined]);
    expect(await ola.received()).toEqual([NOTICE.join.full]);
    expect((await mia.snapshot()).plan).toEqual({ kind: "plus", role: "member" });
    await owner.say("/plan");
    await owner.say("/invite");
    expect(await owner.received()).toEqual(["You're on the Plus plan, with 3 of 3 places taken. Send /invite to add someone.\nTo change or cancel your plan: https://billing.stripe.test/p/cus_kit", NOTICE.inviteFull(3)]);

    await pay(kit, owner, "kit", "plus", { extraSeats: 1 });
    await ola.say(`/join ${codes[2]}`);
    expect(await ola.received()).toEqual([NOTICE.join.joined]);
    expect(await row("sub_kit")).toMatchObject({ seats: 4 });
  });

  test("a member who leaves goes back to their trial, an owner can't join their own plan, and a seat holder can't join twice", async () => {
    const kit = billingOn();
    const at = "2099-11-04T10:00";
    const owner = await devChat("pam", { model: scripted([]), at, billing: kit.deps });
    const member = await devChat("quin", { model: scripted([]), at, billing: kit.deps });
    await pay(kit, owner, "pam", "plus");
    await owner.received();
    await owner.say("/invite");
    const code = codeIn((await owner.received())[0]);
    await owner.say(`/join ${code}`);
    expect(await owner.received()).toEqual([NOTICE.join.own]);

    await member.say(`/join ${code}`);
    await owner.say("/invite");
    await member.say(`/join ${codeIn((await owner.received())[0])}`);
    await member.say("/leave");
    await member.say("/leave");

    expect(await member.received()).toEqual([NOTICE.join.joined, NOTICE.join.seated, `${NOTICE.left}\nYou're on the free trial, with 14 days left.`, NOTICE.notSeated]);
    expect((await member.snapshot()).plan.kind).toBe("trial");
  });

  test("a deleted Plus subscription moves the owner and every member off it, each told once", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const at = "2099-11-04T10:00";
    const owner = await devChat("rae", { model: scripted([]), at, billing: kit.deps });
    const member = await devChat("sol", { model: scripted([]), at, billing: kit.deps });
    await pay(kit, owner, "rae", "plus");
    await owner.say("/invite");
    await member.say(`/join ${codeIn((await owner.received()).at(-1) ?? "")}`);
    await member.received();

    const res = await stripeChange(kit, { user: "rae", sub: "sub_rae", plan: "plus", status: "canceled", type: "customer.subscription.deleted" });
    expect(res.status).toBe(200);
    await owner.settle();
    await member.settle();

    expect(await owner.received()).toEqual([NOTICE.lapsed]);
    expect(await member.received()).toEqual([NOTICE.lapsed]);
    expect((await member.snapshot()).plan.kind).toBe("lapsed");
  });

  test("a member refresh that fails makes the event fail, and Stripe's redelivery tells each person once", async () => {
    const real = d1Billing(env.LEDGER);
    let failures = 1;
    const flaky: BillingStore = {
      ...real,
      async standing(a, now) {
        if (failures-- > 0) throw new Error("D1 unavailable");
        return real.standing(a, now);
      },
    };
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const at = "2099-11-04T10:00";
    const owner = await devChat("tia", { model: scripted([]), at, billing: kit.deps });
    const member = await devChat("uma", { model: scripted([]), at, billing: { ...kit.deps, store: flaky } });
    failures = 0;
    await pay(kit, owner, "tia", "plus");
    await owner.say("/invite");
    await member.say(`/join ${codeIn((await owner.received()).at(-1) ?? "")}`);
    await member.received();
    failures = 1;

    const ended = subscriptionEvent({ user: "tia", sub: "sub_tia", plan: "plus", status: "canceled", type: "customer.subscription.deleted" });
    kit.stripe.subscriptions.set("sub_tia", ended.data.object);
    expect((await postStripe(ended)).status).toBe(500);
    expect(await (await postStripe(ended)).text()).toBe("applied");
    await owner.settle();
    await member.settle();

    expect(await owner.received()).toEqual([NOTICE.lapsed]);
    expect(await member.received()).toEqual([NOTICE.lapsed]);
  });

  test("a Plus owner who moves to Standard takes every member off the plan", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const at = "2099-11-04T10:00";
    const owner = await devChat("wren", { model: scripted([]), at, billing: kit.deps });
    const member = await devChat("xia", { model: scripted([]), at, billing: kit.deps });
    await pay(kit, owner, "wren", "plus");
    await owner.say("/invite");
    await member.say(`/join ${codeIn((await owner.received()).at(-1) ?? "")}`);
    await member.received();

    await stripeChange(kit, { user: "wren", sub: "sub_wren", plan: "standard", status: "active" });
    await owner.settle();
    await member.settle();

    expect(await owner.received()).toEqual(["Thanks. Your Standard plan is active."]);
    expect(await member.received()).toEqual([NOTICE.lapsed]);
    expect((await member.snapshot()).plan.kind).toBe("lapsed");
  });

  test("a /leave repeated after its refresh failed answers as if it had just left", async () => {
    const real = d1Billing(env.LEDGER);
    let failures = 0;
    const flaky: BillingStore = {
      ...real,
      async standing(a, now) {
        if (failures-- > 0) throw new Error("D1 unavailable");
        return real.standing(a, now);
      },
    };
    const kit = billingOn();
    const at = "2099-11-04T10:00";
    const owner = await devChat("yan", { model: scripted([]), at, billing: kit.deps });
    const member = await devChat("zoe", { model: scripted([]), at, billing: { ...kit.deps, store: flaky } });
    await pay(kit, owner, "yan", "plus");
    await owner.say("/invite");
    await member.say(`/join ${codeIn((await owner.received()).at(-1) ?? "")}`);
    await member.received();

    failures = 1;
    await member.say("/leave");
    await member.say("/leave");
    await member.say("/leave");

    expect(await member.received()).toEqual([NOTICE.billingBusy, `${NOTICE.left}\nYou're on the free trial, with 14 days left.`, NOTICE.notSeated]);
    expect(await real.members("sub_yan" as SubscriptionId)).toEqual([]);
  });
});

describe("each turn's plan", () => {
  test("a turn reads the plan from D1, so a payment whose refresh was lost still counts", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const c = await devChat("abe", { model: scripted([chat("Hello again.")]), at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("/plan");
    await c.received();

    await kit.deps.store.applySubscription({ id: "sub_abe" as SubscriptionId, owner: agent("abe"), customer: null, plan: "standard", status: "active", seats: 1 }, c.clock.now());
    await c.say("hello");

    expect(await c.received()).toEqual(["Hello again."]);
  });

  test("with D1 unreachable a turn uses the plan last refreshed, paid or lapsed", async () => {
    const real = d1Billing(env.LEDGER);
    let down = false;
    const flaky: BillingStore = {
      ...real,
      async standing(a, now) {
        if (down) throw new Error("D1 unavailable");
        return real.standing(a, now);
      },
    };
    const kit = billingOn({ TRIAL_DAYS: "0" }, flaky);
    const paid = await devChat("bo", { model: scripted([chat("Still answering.")]), at: "2099-11-04T10:00", billing: kit.deps });
    const unpaid = await devChat("cal", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    await paid.say("/plan");
    await pay(kit, paid, "bo", "standard");
    await paid.received();

    down = true;
    await paid.say("hello");
    await unpaid.say("hello");

    expect(await paid.received()).toEqual(["Still answering."]);
    expect(await unpaid.received()).toEqual([NOTICE.lapsed]);
  });
});

describe("the included plan", () => {
  test("included has no box: /claude says so and a connected box is no longer used", async () => {
    const kit = billingOn();
    const box = fakeBox({ signedIn: true });
    const model = scripted([chat("From the API.")]);
    const c = await devChat("val", { model, at: "2099-11-04T10:00", billing: kit.deps, box: box.deps });
    await c.say("/claude");
    await c.received();
    await pay(kit, c, "val", "included");
    expect(await c.received()).toEqual(["Thanks. Your AI included plan is active.", boxMessage("retiring", "en", null, "18 November 2099").text]);

    await c.say("hello");
    await c.say("/claude");

    expect(await c.received()).toEqual(["From the API.", boxMessage("not_in_plan", "en", null).text]);
    expect(box.parses).toEqual([]);
  });

  test("with INCLUDED on, the included plan runs on our key up to INCLUDED_CAP_USD, and the trial gets none of it", async () => {
    const kit = billingOn();
    const included = loadConfig({ MODEL_BACKEND: "scripted", DEV_MODE: "1", ...INCLUDED_VARS, INCLUDED_CAP_USD: "1" } as unknown as Env).included;
    const spendsTheCap = Math.ceil((1_000_000 * 1_000_000) / HAIKU_5_5.inputPerM);
    const provider = fakeProvider([{ kind: "output", value: { actions: [{ type: "send", text: "Sure." }], tasks: [], about: "" }, usage: { input: spendsTheCap } }]);
    const c = await devChat("wes", { model: null, provider, included, at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("hello");
    expect(await c.received()).toEqual([NOTICE.noAccess({ box: false, key: true, included: true })]);

    await pay(kit, c, "wes", "included");
    await c.received();
    await c.say("hello");
    await c.say("again");

    expect(await c.received()).toEqual(["Sure.", NOTICE.includedCapReached]);
    expect(provider.seen.map((s) => s.headers.get("x-api-key"))).toEqual([INCLUDED_VARS.INCLUDED_API_KEY]);
    expect((await c.snapshot()).access.spentMicro.included).toBeGreaterThanOrEqual(1_000_000);
    expect(c.logs("model_call").map((l) => [l.backend, l.status])).toEqual([
      ["included", "settled"],
      ["included", "refused_user_cap"],
    ]);
  });

  test("our included key's provider out of credit is our ceiling: the person hears the monthly limit, and no key of theirs is touched", async () => {
    const kit = billingOn();
    const included = loadConfig({ MODEL_BACKEND: "scripted", DEV_MODE: "1", ...INCLUDED_VARS } as unknown as Env).included;
    const provider = fakeProvider([{ kind: "status", status: 402 }]);
    const c = await devChat("xan", { model: null, provider, included, at: "2099-11-04T10:00", billing: kit.deps });
    await pay(kit, c, "xan", "included");
    await c.received();

    await c.say("hello");

    expect(await c.received()).toEqual([NOTICE.monthlyLimit]);
    expect(c.logs("model_call").map((l) => [l.backend, l.status, l.costMicro])).toEqual([["included", "provider_refused", 0]]);
  });
});

describe("stripe setup", () => {
  function fakeAccount() {
    const products = new Set<string>();
    const prices: { id: string; product: string; unit_amount: number; currency: string; recurring: { interval: string }; lookup_key: string | null; active: boolean }[] = [];
    const endpoints: { id: string; url: string; events: string[] }[] = [];
    const portals: { id: string; form: Record<string, string> }[] = [];
    const posts: string[] = [];
    let n = 0;
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/v1/, "");
      const form = new URLSearchParams(init?.method === "POST" ? String(init.body) : url.search);
      if (new Headers(init?.headers).get("authorization") !== "Bearer sk_test_fake") return Response.json({ error: { message: "bad key" } }, { status: 401 });
      if (init?.method === "POST") posts.push(path);
      const product = path.match(/^\/products\/(\w+)$/)?.[1];
      if (product) return products.has(product) ? Response.json({ id: product }) : Response.json({ error: { message: "No such product" } }, { status: 404 });
      if (path === "/products") {
        products.add(form.get("id")!);
        return Response.json({ id: form.get("id") });
      }
      if (path === "/prices" && init?.method !== "POST") {
        return Response.json({ data: prices.filter((p) => p.active && p.lookup_key === form.get("lookup_keys[0]")) });
      }
      if (path === "/prices") {
        if (form.get("transfer_lookup_key") === "true") for (const p of prices) if (p.lookup_key === form.get("lookup_key")) p.lookup_key = null;
        const p = { id: `price_${++n}`, product: form.get("product")!, unit_amount: Number(form.get("unit_amount")), currency: form.get("currency")!, recurring: { interval: form.get("recurring[interval]")! }, lookup_key: form.get("lookup_key"), active: true };
        prices.push(p);
        return Response.json(p);
      }
      const events = () => [...form.entries()].filter(([k]) => k.startsWith("enabled_events")).map(([, v]) => v);
      if (path === "/webhook_endpoints" && init?.method !== "POST") return Response.json({ data: endpoints });
      if (path === "/webhook_endpoints") {
        endpoints.push({ id: `we_${++n}`, url: form.get("url")!, events: events() });
        return Response.json({ ...endpoints.at(-1), secret: "whsec_made" });
      }
      if (path === "/billing_portal/configurations" && init?.method !== "POST") {
        return Response.json({ data: portals.map((c) => ({ id: c.id, active: true, metadata: { giraffes: c.form["metadata[giraffes]"] } })) });
      }
      if (path === "/billing_portal/configurations") {
        portals.push({ id: `bpc_${++n}`, form: Object.fromEntries(form) });
        return Response.json({ id: portals.at(-1)?.id });
      }
      const portal = portals.find((c) => path === `/billing_portal/configurations/${c.id}`);
      if (portal) {
        portal.form = Object.fromEntries(form);
        return Response.json({ id: portal.id });
      }
      const endpoint = endpoints.find((e) => path === `/webhook_endpoints/${e.id}`);
      if (endpoint) {
        endpoint.events = events();
        return Response.json(endpoint);
      }
      return Response.json({ error: { message: "no route" } }, { status: 400 });
    };
    return { fetch, products, prices, endpoints, portals, posts };
  }
  const opts = (fetch: ReturnType<typeof fakeAccount>["fetch"], amounts = DEFAULT_AMOUNTS, included = true) => ({
    secretKey: "sk_test_fake",
    publicUrl: "https://giraffes.test/",
    amounts,
    included,
    fetch,
  });

  test("without --included, the included plan gets no product, no price and no place in the portal", async () => {
    const account = fakeAccount();
    const r = await stripeSetup(opts(account.fetch, DEFAULT_AMOUNTS, false));

    expect([...account.products].sort()).toEqual(["giraffes_plus", "giraffes_seat", "giraffes_standard"]);
    expect(r.prices.included).toBeUndefined();
    expect(JSON.stringify(account.portals[0].form)).not.toContain("giraffes_included");
  });

  test("a first run creates four products, four THB monthly prices and the endpoint for the events the Worker handles", async () => {
    const account = fakeAccount();
    const r = await stripeSetup(opts(account.fetch));

    expect([...account.products].sort()).toEqual(["giraffes_included", "giraffes_plus", "giraffes_seat", "giraffes_standard"]);
    expect(account.prices.map((p) => [p.lookup_key, p.unit_amount, p.currency, p.recurring.interval])).toEqual([
      ["giraffes_standard", 29900, "thb", "month"],
      ["giraffes_plus", 69900, "thb", "month"],
      ["giraffes_seat", 19900, "thb", "month"],
      ["giraffes_included", 17900, "thb", "month"],
    ]);
    expect(account.endpoints).toEqual([{ id: r.webhook.id, url: "https://giraffes.test/webhook/stripe", events: [...STRIPE_EVENT_TYPES] }]);
    expect(r.webhook.secret).toBe("whsec_made");
    expect(Object.values(r.prices)).toEqual(account.prices.map((p) => p.id));
  });

  test("a second run creates nothing, and a changed amount makes one new price that takes the lookup key", async () => {
    const account = fakeAccount();
    const first = await stripeSetup(opts(account.fetch));
    const posts = account.posts.length;

    const again = await stripeSetup(opts(account.fetch));
    expect(account.posts.slice(posts)).toEqual([`/billing_portal/configurations/${first.portal}`, `/webhook_endpoints/${first.webhook.id}`]);
    expect(again).toMatchObject({ prices: first.prices, portal: first.portal, webhook: { id: first.webhook.id, secret: null } });

    const raised = await stripeSetup(opts(account.fetch, { ...DEFAULT_AMOUNTS, included: 19900 }));
    expect(raised.prices.included).not.toBe(first.prices.included);
    expect({ ...raised.prices, included: first.prices.included }).toEqual(first.prices);
    expect(account.prices.filter((p) => p.lookup_key === "giraffes_included").map((p) => p.unit_amount)).toEqual([19900]);
    expect(account.portals).toHaveLength(1);
    expect(account.portals[0].form["features[subscription_update][products][2][prices][0]"]).toBe(raised.prices.included);
  });

  test("the portal configuration lets a person update their card, see invoices, cancel at period end and switch plans", async () => {
    const account = fakeAccount();
    const r = await stripeSetup(opts(account.fetch));

    expect(account.portals.map((c) => c.id)).toEqual([r.portal]);
    expect(account.portals[0].form).toEqual({
      "metadata[giraffes]": "portal",
      default_return_url: "https://giraffes.test/billing/done",
      "features[payment_method_update][enabled]": "true",
      "features[invoice_history][enabled]": "true",
      "features[subscription_cancel][enabled]": "true",
      "features[subscription_cancel][mode]": "at_period_end",
      "features[subscription_update][enabled]": "true",
      "features[subscription_update][default_allowed_updates][0]": "price",
      "features[subscription_update][proration_behavior]": "create_prorations",
      "features[subscription_update][products][0][product]": "giraffes_standard",
      "features[subscription_update][products][0][prices][0]": r.prices.standard,
      "features[subscription_update][products][1][product]": "giraffes_plus",
      "features[subscription_update][products][1][prices][0]": r.prices.plus,
      "features[subscription_update][products][2][product]": "giraffes_included",
      "features[subscription_update][products][2][prices][0]": r.prices.included,
    });
    expect(r.log).toContain(`portal configuration ${r.portal}: created`);
  });
});
