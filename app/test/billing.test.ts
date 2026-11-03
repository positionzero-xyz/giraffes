import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { NOTICE } from "../src/agent/turn";
import { planAllowsBox, planOf, supersedes, type PlanRules, type Subscription, type SubscriptionId } from "../src/billing/plan";
import { BILLING_OFF, inviteFull, JOIN, LEFT, NO_LINKS, NOT_SEATED } from "../src/billing/say";
import { d1Billing, type BillingStore } from "../src/billing/store";
import { checkoutForm, formBody, parseEvent, stripeApi, verifySignature } from "../src/billing/stripe";
import { boxMessage } from "../src/box/machine";
import { loadConfig, type Env } from "../src/config";
import type { AgentKey, EpochMs, MicroUsd } from "../src/domain";
import { priceOf, routeOf } from "../src/model/model";
import {
  billingOn,
  chat,
  checkoutEvent,
  devChat,
  fakeBox,
  local,
  postStripe,
  quiet,
  scripted,
  signStripe,
  STRIPE_VARS,
  subscriptionEvent,
  turn,
  type DevChat,
} from "./testkit";

const quietCheckin = () => turn({ actions: [quiet()], task: ["chat", "checkin", "none"] });
const agent = (user: string) => `p:dev:${user}` as AgentKey;
const codeIn = (text: string) => text.match(/\/join ([A-Z0-9]{6})$/)?.[1] ?? "";

async function row(sub: string) {
  return env.LEDGER.prepare("SELECT plan, status, period_end, seats FROM billing_subscription WHERE id = ?").bind(sub).first();
}

async function pay(c: DevChat, user: string, plan: "standard" | "plus" | "ai", o: { created?: string; extraSeats?: number } = {}) {
  const created = o.created ?? "2099-11-04T10:00";
  const res = await postStripe(
    subscriptionEvent({ user, sub: `sub_${user}`, plan, status: "active", periodEnd: "2099-12-04T10:00", created, type: "customer.subscription.created", extraSeats: o.extraSeats }),
  );
  expect(res.status).toBe(200);
  await c.settle();
}

describe("plan rules", () => {
  const rules: PlanRules = { trialDays: 14, plusSeats: 3, plusMaxSeats: 6, aiCapMicro: 1_000_000 as MicroUsd };
  const now = local("2099-11-04T10:00");
  const later = (days: number) => (now + days * 86_400_000) as EpochMs;
  const id = "sub_1" as SubscriptionId;
  const trial = { trialEndsAt: later(14), own: null, seat: null };

  test("a paid plan beats a seat, a seat beats ai, and ai beats the trial", () => {
    expect(planOf({ ...trial, own: { id, plan: "standard" }, seat: { id, owner: agent("o") } }, now, true, rules)).toEqual({ kind: "standard" });
    expect(planOf({ ...trial, own: { id, plan: "ai" }, seat: { id, owner: agent("o") } }, now, true, rules)).toEqual({ kind: "plus", role: "member" });
    expect(planOf({ ...trial, own: { id, plan: "ai" } }, now, true, rules)).toEqual({ kind: "ai" });
    expect(planOf(trial, now, true, rules)).toEqual({ kind: "trial", endsAt: later(14) });
  });

  test("the trial ends at its end with billing on, never with billing off, and a missing row is a trial not started", () => {
    expect(planOf(trial, later(14), true, rules)).toEqual({ kind: "lapsed" });
    expect(planOf(trial, later(400), false, rules)).toEqual({ kind: "trial", endsAt: null });
    expect(planOf(null, now, true, rules)).toEqual({ kind: "trial", endsAt: later(14) });
  });

  test("the box comes with trial, standard and plus, not with ai or lapsed", () => {
    expect((["trial", "standard", "plus", "ai", "lapsed"] as const).filter(planAllowsBox)).toEqual(["trial", "standard", "plus"]);
  });

  test("a terminal state is final; otherwise the later period, then the later event, then anything over incomplete wins", () => {
    const s = (status: Subscription["status"], periodEnd: number, eventAt: number): Subscription => ({
      id,
      owner: agent("o"),
      plan: "standard",
      status,
      periodEnd: periodEnd as EpochMs,
      eventAt: eventAt as EpochMs,
      seats: 1,
    });
    expect(supersedes(s("active", 1, 1), null)).toBe(true);
    expect(supersedes(s("active", 9, 9), s("canceled", 1, 1))).toBe(false);
    expect(supersedes(s("canceled", 1, 1), s("active", 9, 9))).toBe(true);
    expect(supersedes(s("past_due", 1, 5), s("active", 2, 1))).toBe(false);
    expect(supersedes(s("past_due", 2, 5), s("active", 2, 4))).toBe(true);
    expect(supersedes(s("incomplete", 2, 4), s("active", 2, 4))).toBe(false);
    expect(supersedes(s("active", 2, 4), s("incomplete", 2, 4))).toBe(true);
  });
});

describe("configuration", () => {
  const load = (vars: Record<string, string>) => loadConfig({ MODEL_BACKEND: "scripted", DEV_MODE: "1", ...vars } as unknown as Env).billing;

  test("BILLING defaults to off with the default rules", () => {
    expect(load({})).toEqual({ on: false, rules: { trialDays: 14, plusSeats: 3, plusMaxSeats: 6, aiCapMicro: 1_000_000 } });
  });

  test.each(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_STANDARD", "STRIPE_PRICE_PLUS", "STRIPE_PRICE_SEAT", "STRIPE_PRICE_AI", "PUBLIC_URL"])(
    "BILLING=on without %s fails at load",
    (name) => {
      const vars: Record<string, string> = { ...STRIPE_VARS };
      delete vars[name];
      expect(() => load(vars)).toThrow(name);
    },
  );

  test("bad rule values fail at load", () => {
    expect(load({ AI_CAP_USD: "2.5", TRIAL_DAYS: "30" }).rules).toMatchObject({ aiCapMicro: 2_500_000, trialDays: 30 });
    expect(() => load({ AI_CAP_USD: "one" })).toThrow("AI_CAP_USD");
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
      return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    });

    expect(await api.checkout({ agent: agent("ann"), plan: "plus", idempotencyKey: "k1" })).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_1" });

    expect(sent[0].url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(sent[0].headers.get("authorization")).toBe("Bearer sk_test_fake");
    expect(sent[0].headers.get("idempotency-key")).toBe("k1");
    expect(sent[0].headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(sent[0].body))).toEqual({
      mode: "subscription",
      client_reference_id: "p:dev:ann",
      success_url: "https://giraffes.test/billing/done",
      cancel_url: "https://giraffes.test/billing/done",
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

  test("a Stripe error or a network failure is a failed checkout whose detail carries no key", async () => {
    const refused = stripeApi(cfg, rules, async () => Response.json({ error: { type: "invalid_request_error", message: "No such price" } }, { status: 400 }));
    const r = await refused.checkout({ agent: agent("ann"), plan: "ai", idempotencyKey: "k" });
    expect(r).toEqual({ ok: false, detail: "checkout 400 invalid_request_error: No such price" });
    const down = stripeApi(cfg, rules, async () => {
      throw new TypeError("fetch failed");
    });
    expect(await down.checkout({ agent: agent("ann"), plan: "ai", idempotencyKey: "k" })).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain("sk_test");
  });

  test("a subscription's period end is read from the subscription or its items, and Plus places are capped", () => {
    const e = subscriptionEvent({ user: "ann", sub: "sub_1", plan: "plus", status: "active", periodEnd: "2099-12-04T10:00", created: "2099-11-04T10:00", extraSeats: 10 });
    const parsed = parseEvent(e, cfg, rules);
    expect(parsed).toMatchObject({ kind: "event", event: { subscription: { plan: "plus", seats: 6, periodEnd: local("2099-12-04T10:00"), owner: "p:dev:ann" } } });
    const top = structuredClone(e) as { data: { object: Record<string, unknown> } };
    top.data.object.current_period_end = Math.floor(local("2099-12-05T10:00") / 1000);
    top.data.object.items = { data: [{ price: { id: "price_plus" }, quantity: 1 }] };
    expect(parseEvent(top, cfg, rules)).toMatchObject({ kind: "event", event: { subscription: { periodEnd: local("2099-12-05T10:00"), seats: 3 } } });
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
    expect(await c.received()).toEqual(["You're on the free beta, so there's nothing to pay.", BILLING_OFF, BILLING_OFF, BILLING_OFF]);

    c.clock.set(local("2099-12-30T10:00"));
    await c.say("hello");

    expect(await c.received()).toEqual(["Hi!"]);
    expect((await c.snapshot()).plan).toEqual({ kind: "trial", endsAt: null });
    const res = await postStripe(checkoutEvent({ user: "bea", sub: "sub_x", plan: "standard", created: "2099-11-04T10:00" }), { vars: { BILLING: "off" } });
    expect(res.status).toBe(404);
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

    expect(await c.received()).toEqual([NOTICE.lapsed, NOTICE.lapsed]);
    expect(model.calls).toHaveLength(1);
    expect(box.parses).toEqual([]);
    expect(c.logs("turn").filter((t) => t.eventKind === "message").map((t) => t.outcome)).toEqual(["acted", "no_model", "lapsed", "lapsed", "lapsed"]);
  });

  test("/plan during the trial gives the days left and three Checkout links, which stay out of the history", async () => {
    const kit = billingOn();
    const model = scripted([]);
    const c = await devChat("dee", { model, at: "2099-11-04T10:00", billing: kit.deps });

    await c.say("/plan", { id: "plan-1" });

    const [text] = await c.received();
    expect(text.split("\n").slice(0, 2)).toEqual(["You're on the free trial, with 14 days left.", "Pick a plan:"]);
    for (const p of ["standard", "plus", "ai"]) expect(text).toContain(`https://checkout.stripe.test/${p}/`);
    expect(kit.stripe.checkouts).toEqual(
      ["standard", "plus", "ai"].map((plan) => ({ agent: "p:dev:dee", plan, idempotencyKey: `p:dev:dee|dev:plan-1|${plan}` })),
    );
    expect(JSON.stringify((await c.snapshot()).turns)).not.toContain("checkout.stripe.test");
    expect(model.calls).toHaveLength(0);

    kit.stripe.failing = true;
    await c.say("/plan");
    expect(await c.received()).toEqual([`You're on the free trial, with 14 days left.\n${NO_LINKS}`]);
  });

  test("a payment after the trial lapsed is announced and the model answers again", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const model = scripted([chat("Welcome back.")]);
    const c = await devChat("eve", { model, at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("/plan");
    expect((await c.received())[0]).toMatch(/^You have no active plan, so I can't answer messages for now\.\nPick a plan:/);

    const res = await postStripe(checkoutEvent({ user: "eve", sub: "sub_eve", plan: "standard", created: "2099-11-04T10:01" }));
    expect([res.status, await res.text()]).toEqual([200, "applied"]);
    await c.settle();
    expect(await c.received()).toEqual(["Thanks. Your Standard plan is active."]);

    await c.say("hello");
    expect(await c.received()).toEqual(["Welcome back."]);
    await c.say("/plan");
    expect(await c.received()).toEqual(["You're on the Standard plan."]);
  });
});

describe("stripe webhook", () => {
  test("a bad, stale or missing signature is refused and changes nothing", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const c = await devChat("fay", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    const e = checkoutEvent({ user: "fay", sub: "sub_fay", plan: "standard", created: "2099-11-04T10:00" });
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
    const e = checkoutEvent({ user: "gil", sub: "sub_gil", plan: "ai", created: "2099-11-04T10:00" });

    expect(await (await postStripe(e)).text()).toBe("applied");
    expect(await (await postStripe(e)).text()).toBe("duplicate");
    await c.settle();

    expect(await c.received()).toEqual(["Thanks. Your AI plan is active."]);
  });

  test("late events never move a subscription back, and a cancelled one stays cancelled", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const c = await devChat("hu", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("/plan");
    await c.received();
    const ev = (status: string, periodEnd: string, created: string, type?: "customer.subscription.deleted") =>
      postStripe(subscriptionEvent({ user: "hu", sub: "sub_hu", plan: "standard", status, periodEnd, created, type }));

    await ev("active", "2100-01-04T10:00", "2099-12-04T10:00");
    await ev("past_due", "2099-12-04T10:00", "2099-11-20T10:00");
    await ev("incomplete", "2100-01-04T10:00", "2099-12-04T10:00");
    expect(await row("sub_hu")).toEqual({ plan: "standard", status: "active", period_end: local("2100-01-04T10:00"), seats: 1 });

    await ev("canceled", "2100-01-04T10:00", "2099-12-10T10:00", "customer.subscription.deleted");
    await ev("active", "2100-02-04T10:00", "2100-01-04T10:00");
    await postStripe(checkoutEvent({ user: "hu", sub: "sub_hu", plan: "standard", created: "2100-01-05T10:00" }));
    await c.settle();

    expect(await row("sub_hu")).toMatchObject({ status: "canceled" });
    expect(await c.received()).toEqual(["Thanks. Your Standard plan is active.", NOTICE.lapsed]);
  });

  test("same-second events in reverse order end active, and a checkout seen after its subscription changes nothing", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const c = await devChat("ida", { model: scripted([]), at: "2099-11-04T10:00", billing: kit.deps });
    await c.say("/plan");
    await c.received();
    const at = "2099-11-04T10:05";

    await postStripe(subscriptionEvent({ user: "ida", sub: "sub_ida", plan: "standard", status: "active", periodEnd: "2099-12-04T10:05", created: at }));
    await postStripe(subscriptionEvent({ user: "ida", sub: "sub_ida", plan: "standard", status: "incomplete", periodEnd: "2099-12-04T10:05", created: at, type: "customer.subscription.created" }));
    await postStripe(checkoutEvent({ user: "ida", sub: "sub_ida", plan: "standard", created: at }));
    await c.settle();

    expect(await row("sub_ida")).toMatchObject({ status: "active", period_end: local("2099-12-04T10:05") });
    expect(await c.received()).toEqual(["Thanks. Your Standard plan is active."]);
  });

  test("events that aren't ours are acknowledged and ignored", async () => {
    const foreign = subscriptionEvent({ user: "joe", sub: "sub_joe", plan: "standard", status: "active", periodEnd: "2099-12-04T10:00", created: "2099-11-04T10:00" });
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

describe("plus seats", () => {
  test("a join repeated by the person who joined is still joined, and an expired code doesn't work", async () => {
    const store = d1Billing(env.LEDGER);
    const now = local("2099-11-04T10:00");
    const sub = { id: "sub_z" as SubscriptionId, owner: agent("zed"), plan: "plus" as const, status: "active" as const, periodEnd: now, eventAt: now, seats: 3 };
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
    await pay(owner, "kit", "plus");
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
    expect(await mia.received()).toEqual([JOIN.joined]);
    expect(await noa.received()).toEqual([JOIN.bad_code, JOIN.joined]);
    expect(await ola.received()).toEqual([JOIN.full]);
    expect((await mia.snapshot()).plan).toEqual({ kind: "plus", role: "member" });
    await owner.say("/plan");
    await owner.say("/invite");
    expect(await owner.received()).toEqual(["You're on the Plus plan, with 3 of 3 places taken. Send /invite to add someone.", inviteFull(3)]);

    await pay(owner, "kit", "plus", { created: "2099-11-05T10:00", extraSeats: 1 });
    await ola.say(`/join ${codes[2]}`);
    expect(await ola.received()).toEqual([JOIN.joined]);
    expect(await row("sub_kit")).toMatchObject({ seats: 4 });
  });

  test("a member who leaves goes back to their trial, an owner can't join their own plan, and a seat holder can't join twice", async () => {
    const kit = billingOn();
    const at = "2099-11-04T10:00";
    const owner = await devChat("pam", { model: scripted([]), at, billing: kit.deps });
    const member = await devChat("quin", { model: scripted([]), at, billing: kit.deps });
    await pay(owner, "pam", "plus");
    await owner.received();
    await owner.say("/invite");
    const code = codeIn((await owner.received())[0]);
    await owner.say(`/join ${code}`);
    expect(await owner.received()).toEqual([JOIN.own]);

    await member.say(`/join ${code}`);
    await owner.say("/invite");
    await member.say(`/join ${codeIn((await owner.received())[0])}`);
    await member.say("/leave");
    await member.say("/leave");

    expect(await member.received()).toEqual([JOIN.joined, JOIN.seated, `${LEFT}\nYou're on the free trial, with 14 days left.`, NOT_SEATED]);
    expect((await member.snapshot()).plan.kind).toBe("trial");
  });

  test("a deleted Plus subscription moves the owner and every member off it, each told once", async () => {
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const at = "2099-11-04T10:00";
    const owner = await devChat("rae", { model: scripted([]), at, billing: kit.deps });
    const member = await devChat("sol", { model: scripted([]), at, billing: kit.deps });
    await pay(owner, "rae", "plus");
    await owner.say("/invite");
    await member.say(`/join ${codeIn((await owner.received()).at(-1) ?? "")}`);
    await member.received();

    const res = await postStripe(
      subscriptionEvent({ user: "rae", sub: "sub_rae", plan: "plus", status: "canceled", periodEnd: "2099-12-04T10:00", created: "2099-11-20T10:00", type: "customer.subscription.deleted" }),
    );
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
      async standing(a) {
        if (failures-- > 0) throw new Error("D1 unavailable");
        return real.standing(a);
      },
    };
    const kit = billingOn({ TRIAL_DAYS: "0" });
    const at = "2099-11-04T10:00";
    const owner = await devChat("tia", { model: scripted([]), at, billing: kit.deps });
    const member = await devChat("uma", { model: scripted([]), at, billing: { ...kit.deps, store: flaky } });
    failures = 0;
    await pay(owner, "tia", "plus");
    await owner.say("/invite");
    await member.say(`/join ${codeIn((await owner.received()).at(-1) ?? "")}`);
    await member.received();
    failures = 1;

    const ended = subscriptionEvent({ user: "tia", sub: "sub_tia", plan: "plus", status: "canceled", periodEnd: "2099-12-04T10:00", created: "2099-11-20T10:00", type: "customer.subscription.deleted" });
    await expect(postStripe(ended)).rejects.toThrow();
    expect(await (await postStripe(ended)).text()).toBe("applied");
    await owner.settle();
    await member.settle();

    expect(await owner.received()).toEqual([NOTICE.lapsed]);
    expect(await member.received()).toEqual([NOTICE.lapsed]);
  });
});

describe("the ai plan", () => {
  test("ai has no box: /claude says so and a connected box is no longer used", async () => {
    const kit = billingOn();
    const box = fakeBox({ signedIn: true });
    const model = scripted([chat("From the API.")]);
    const c = await devChat("val", { model, at: "2099-11-04T10:00", billing: kit.deps, box: box.deps });
    await c.say("/claude");
    await c.received();
    await pay(c, "val", "ai");
    expect(await c.received()).toEqual(["Thanks. Your AI plan is active."]);

    await c.say("hello");
    await c.say("/claude");

    expect(await c.received()).toEqual(["From the API.", boxMessage("not_in_plan", null).text]);
    expect(box.parses).toEqual([]);
  });

  test("AI_CAP_USD is the person's monthly API cap", async () => {
    const kit = billingOn({ AI_CAP_USD: "1" });
    const spendsTheCap = Math.ceil((1_000_000 * 1_000_000) / priceOf(routeOf("turn").model).inputPerM);
    const model = scripted([turn({ actions: [{ type: "send", text: "Sure." }], task: ["chat", "chat", "none"], usage: { inputTokens: spendsTheCap } })]);
    const c = await devChat("wes", { model, at: "2099-11-04T10:00", billing: kit.deps });
    await pay(c, "wes", "ai");
    await c.received();

    await c.say("hello");
    await c.say("again");

    expect(await c.received()).toEqual(["Sure.", NOTICE.monthlyLimit]);
    expect((await c.snapshot()).spendThisMonthMicro).toBeGreaterThanOrEqual(1_000_000);
    expect(model.calls).toHaveLength(1);
  });
});
