import { env, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import type { Agent } from "../src/agent/agent";
import { boxClient } from "../src/box/client";
import type { BoxName } from "../src/box/names";
import type { CheckoutId, StripeReply } from "../src/billing/stripe";
import { parseInviteCode, personAgentKey, type EpochMs } from "../src/domain";
import { type SubscriptionId } from "../src/billing/plan";
import { d1Ledger } from "../src/ledger/ledger";
import { billingOn, chat, devChat, fakeBox, hold, scripted } from "./testkit";

test("a confirmed account erase clears private state and requires a fresh decision to return", async () => {
  const model = scripted([chat("A private reply.")]);
  const c = await devChat("erase-account", { model, at: "2099-11-04T10:00" });
  const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
  await c.say("A private message.");
  expect(await c.received()).toEqual(["A private reply."]);
  await runInDurableObject(stub, (agent) => agent.withDeps({ firstContactConsent: true }));
  // A later release can add a session table beside box_session; erasure discovers tables, not names.
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec("CREATE TABLE session (id TEXT, memory TEXT)");
    state.storage.sql.exec("INSERT INTO session VALUES ('old-session', 'private words')");
  });

  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  expect(confirm?.label).toBe("Stop and delete");
  if (!confirm) throw new Error("erase confirmation is missing");
  expect((await c.snapshot()).turns.some((turn) => turn.text === "A private message.")).toBe(true);
  const other = await devChat("other-erase-account", { model: null, at: "2099-11-04T10:00" });
  await other.tap(confirm.data);
  expect(await other.received()).toEqual([]);
  const otherStub = env.AGENT.get(env.AGENT.idFromName(other.agent));
  const storageOf = (target: DurableObjectStub<Agent>) => runInDurableObject(target, async (_, state) => {
    const sql = state.storage.sql;
    const names = sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' ORDER BY name",
    ).toArray();
    return {
      alarm: await state.storage.getAlarm(), keys: [...(await state.storage.list()).keys()],
      tables: Object.fromEntries(names.map(({ name }) => [name, sql.exec(`SELECT * FROM "${name}"`).toArray()])),
    };
  });
  const emptyAccount = await storageOf(otherStub);

  await c.tap(confirm.data);
  expect(await c.received()).toHaveLength(2);
  expect(c.channel.delivered.at(-1)?.text).toMatch(/deleted your live Giraffe data/);
  expect(c.channel.delivered.at(-1)?.text).toContain("start fresh");
  expect(await storageOf(stub)).toEqual(emptyAccount);
  expect((await c.snapshot()).agent).toBeNull();
  expect((await env.LEDGER.prepare("SELECT agent_key FROM agent WHERE agent_key = ?").bind(c.agent).all()).results).toEqual([]);

  await c.tap(confirm.data);
  expect(await stub.billingEvent({ id: "late_old", owner: c.agent, subscription: "sub_old" as SubscriptionId })).toBe("ignored");
  await c.tap("c");
  expect((await c.snapshot()).agent).toBeNull();
  await c.say("Do you still have my old facts?");
  expect(model.calls).toHaveLength(1);
  const start = c.channel.delivered.at(-1)?.button;
  expect(start?.label).toBe("Start");
  if (!start) throw new Error("fresh consent is missing");
  await c.tap(start.data);
  expect(await stub.billingEvent({ id: "late_after_restart", owner: c.agent, subscription: "sub_old" as SubscriptionId })).toBe("ignored");
  expect((await c.snapshot()).turns.map((turn) => turn.text)).not.toContain("Do you still have my old facts?");
});

test("an old model reply and messages while deletion is pending never reach the new account", async () => {
  const model = scripted([hold(chat("late private reply"))]);
  const c = await devChat("erase-held-model", { model, at: "2099-11-04T10:00" });
  await c.post("private words");
  await vi.waitFor(() => expect(model.calls).toHaveLength(1));
  await c.post("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing confirmation");
  const erase = c.post(`/tap ${confirm.data}`);
  await erase;
  await c.post("another private message");
  model.release();
  await c.settle();

  expect(model.calls).toHaveLength(1);
  expect(c.channel.delivered.some(({ text }) => text.includes("late private reply"))).toBe(false);
  expect((await c.snapshot()).turns).toEqual([]);
  expect((await c.snapshot()).agent).toBeNull();
});

test("an old image erases the workspace but leaves sign-in, so account erasure stays pending", async () => {
  const user = "erase-with-box";
  const volume = "00000000-0000-4000-8000-000000000002";
  const box = fakeBox({ onlyFor: user, signedIn: true, volume });
  const billing = billingOn();
  const closeSubscription = vi.fn(async () => ({ ok: true, value: { retained: false } } as const));
  let accountProof = false;
  let reportedVolume = volume;
  const files = new Set(["workspace session", "sign-in credentials"]);
  const requests: { epoch: number; box: string }[] = [];
  const c = await devChat(user, {
    model: null,
    at: "2099-11-04T10:00",
    billing: { ...billing.deps, stripe: { ...billing.stripe, closeSubscription, closeCheckout: async () => ({ ok: true, value: { subscription: null, retained: false } }) } },
    box: {
      ...box.deps,
      host: { ...box.deps.host, kind: "static" },
      client: {
        ...box.deps.client,
        async health() {
          return { kind: "up", signedIn: true, box: reportedVolume };
        },
        erase: boxClient(async (_url, init) => {
          const request = JSON.parse(String(init?.body));
          expect(request).toMatchObject({ scope: "account", box: volume });
          requests.push({ epoch: request.epoch, box: request.box });
          files.delete("workspace session");
          if (accountProof) files.delete("sign-in credentials");
          return Response.json({
            box: volume, floor: request.epoch,
            ...(accountProof ? { scope: "account" as const } : {}),
          });
        }).erase,
      },
    },
  });
  const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
  await env.LEDGER.prepare("INSERT INTO billing_subscription (id, owner_key, plan, status, seats, updated_at) VALUES ('sub_box_erase', ?, 'standard', 'active', 1, 1)")
    .bind(c.agent).run();
  await env.LEDGER.prepare("INSERT INTO model_call (id, agent_key, purpose, model, status, estimate_micro, cost_micro, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at) VALUES ('erase_usage', ?, 'turn', '', 'settled', 1, 1, 1, 1, 0, 0, 1)")
    .bind(c.agent).run();
  await c.say("/claude");
  await runInDurableObject(stub, (_, state) => { state.storage.sql.exec("UPDATE box SET volume = NULL"); });
  const forget = await stub.beginForget({ at: c.clock.now(), seq: null });
  c.clock.set((c.clock.now() + 1_000) as EpochMs);
  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing confirmation");
  await c.received();
  await c.say(`/tap ${confirm.data}`);
  expect(requests[0]).toEqual({ epoch: forget.epoch + 1, box: volume });
  expect(files).toEqual(new Set(["sign-in credentials"]));
  expect(await stub.endForget(forget.op)).toBe(false);
  expect(closeSubscription).toHaveBeenCalledWith("sub_box_erase", c.agent);
  expect(c.channel.delivered.at(-1)?.text).not.toMatch(/deleted your live Giraffe data/);
  expect(await env.LEDGER.prepare("SELECT id FROM model_call WHERE agent_key = ?").bind(c.agent).first()).toBeNull();
  expect(await env.LEDGER.prepare("SELECT id FROM billing_subscription WHERE owner_key = ?").bind(c.agent).first()).toBeNull();
  await c.say("please answer this");
  reportedVolume = "00000000-0000-4000-8000-000000000003";
  accountProof = true;
  c.clock.set((c.clock.now() + 60_000) as EpochMs);
  await c.settle();
  expect(requests.every((request) => request.epoch === forget.epoch + 1 && request.box === volume)).toBe(true);
  expect(files.size).toBe(0);
  expect(await stub.endForget(forget.op)).toBe(false);
  expect(await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("SELECT epoch, op FROM forget").one(),
  )).toEqual({ epoch: 0, op: null });
  expect(c.channel.delivered.at(-1)?.text).toMatch(/deleted your live Giraffe data/);
  expect(await c.received()).toEqual([expect.stringMatching(/deleted your live Giraffe data/)]);
  expect(closeSubscription).toHaveBeenCalledTimes(1);
  expect((await c.snapshot()).box).toBeNull();
});

test("erase retains box identity while the box feature is off, counts capacity, and rechecks when restored", async () => {
  const user = "erase-box-off";
  const volume = "00000000-0000-4000-8000-0000000000d4";
  const box = fakeBox({ onlyFor: user, signedIn: true, volume });
  const wipes: { epoch: number; box: string }[] = [];
  const deps = {
    ...box.deps,
    host: { ...box.deps.host, kind: "static" as const },
    client: {
      ...box.deps.client,
      async health() {
        return { kind: "up" as const, signedIn: true, box: volume };
      },
      erase: boxClient(async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        wipes.push({ epoch: request.epoch, box: request.box });
        return Response.json({ box: volume, floor: request.epoch, scope: "account" as const });
      }).erase,
    },
  };
  const c = await devChat(user, { model: null, at: "2099-11-04T10:00", box: deps });
  const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
  await runInDurableObject(stub, (agent) => agent.withDeps({ ledger: d1Ledger(env.LEDGER) }));
  await c.say("/claude");
  const name = (await env.LEDGER.prepare("SELECT name FROM boxes WHERE agent_key = ?").bind(c.agent).first<{ name: BoxName }>())?.name;
  if (!name) throw new Error("the fixture box was not registered");

  await runInDurableObject(stub, (agent) => agent.withDeps({ box: null }));
  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing confirmation");
  await c.tap(confirm.data);

  const job = await runInDurableObject(stub, (_, state) => state.storage.kv.get<Record<string, unknown>>("account:erase"));
  expect(job?.box).toMatchObject({ kind: "unverified", box: { name, host: "static" } });
  const held = await env.LEDGER.prepare("SELECT agent_key, deleted_at FROM boxes WHERE name = ?").bind(name).first<{ agent_key: string; deleted_at: number | null }>();
  expect(held).toMatchObject({ deleted_at: null });
  expect(held?.agent_key).toMatch(/^erasure:/);
  const other = personAgentKey({ channel: "dev", channelUserId: "erase-box-off-other" });
  expect(await d1Ledger(env.LEDGER).claimBox({ agent: other, name: "gbox-capacity" as BoxName, host: "static", at: 1 as EpochMs, max: 1 })).toBe("full");
  expect(wipes).toEqual([]);

  await runInDurableObject(stub, (agent) => agent.withDeps({ box: deps }));
  c.clock.set((c.clock.now() + 61_000) as EpochMs);
  await c.settle();

  expect(wipes).toHaveLength(1);
  expect(c.channel.delivered.at(-1)?.text).toMatch(/deleted your live Giraffe data/);
  expect(await env.LEDGER.prepare("SELECT name FROM boxes WHERE name = ?").bind(name).first()).toBeNull();
});

test("a stuck box erasure reports a non-content operator diagnostic once a day", async () => {
  const user = "erase-diagnostic";
  const box = fakeBox({ onlyFor: user, signedIn: true });
  const c = await devChat(user, {
    model: null,
    at: "2099-11-04T10:00",
    box: { ...box.deps, host: { ...box.deps.host, kind: "static" } },
  });
  await c.say("/claude");
  const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
  await runInDurableObject(stub, (agent) => agent.withDeps({ box: box.deps }));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing confirmation");
  await c.received();
  await c.tap(confirm.data);
  c.clock.set((c.clock.now() + 25 * 60 * 60_000) as EpochMs);
  await c.settle();

  expect(warn.mock.calls.map(([line]) => line)).toContainEqual({ code: "erase_box_host_mismatch", value: 25 });
  warn.mockRestore();
});

test("an active static box known only to the ledger is wiped from its derived URL", async () => {
  const user = "erase-registered-box";
  const volume = "00000000-0000-4000-8000-0000000000e1";
  const box = fakeBox({ onlyFor: user, signedIn: true, volume });
  const wipes: { epoch: number; box: string }[] = [];
  const c = await devChat(user, {
    model: null,
    at: "2099-11-04T10:00",
    box: {
      ...box.deps,
      host: { ...box.deps.host, kind: "static" },
      client: {
        ...box.deps.client,
        async health() {
          return { kind: "up", signedIn: true, box: volume };
        },
        erase: boxClient(async (_url, init) => {
          const request = JSON.parse(String(init?.body));
          wipes.push({ epoch: request.epoch, box: request.box });
          return Response.json({ box: volume, floor: request.epoch, scope: "account" as const });
        }).erase,
      },
    },
  });
  await c.say("hello");
  const name = await box.nameOf(user);
  await env.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at, deleted_at) VALUES (?, ?, 'static', 1, NULL)")
    .bind(c.agent, name).run();
  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing confirmation");
  await c.tap(confirm.data);

  expect(wipes).toHaveLength(1);
  expect(c.channel.delivered.at(-1)?.text).toMatch(/deleted your live Giraffe data/);
  expect(await env.LEDGER.prepare("SELECT name FROM boxes WHERE name = ?").bind(name).first()).toBeNull();
});

test("a confirmed missing Fly box finishes as reclaimed and releases capacity", async () => {
  const user = "erase-box-missing";
  const box = fakeBox({ onlyFor: user });
  const c = await devChat(user, {
    model: null,
    at: "2099-11-04T10:00",
    box: {
      ...box.deps,
      host: Object.assign({ ...box.deps.host }, {
        retirementTarget: async () => ({ ok: false as const, retryable: false, detail: "GET volumes: 404", missing: true as const }),
        retireWipedDisk: async () => ({ ok: true as const }),
        removeRetiredApp: async () => ({ ok: true as const }),
      }),
    },
  });
  await c.say("hello");
  await env.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at, deleted_at) VALUES (?, 'gbox-missing', 'fly', 1, NULL)")
    .bind(c.agent).run();
  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing confirmation");
  await c.tap(confirm.data);

  const receipt = c.channel.delivered.at(-1)?.text;
  expect(receipt).toMatch(/deleted your live Giraffe data/);
  expect(receipt).toMatch(/box was removed earlier.*wipe/i);
  expect(await env.LEDGER.prepare("SELECT name FROM boxes WHERE name = 'gbox-missing'").first()).toBeNull();
});

test("the fresh consent button preserves the beta invite from a start link", async () => {
  const code = parseInviteCode("ERASE8");
  if (!code) throw new Error("invalid fixture invite");
  const c = await devChat("457234", { model: null, at: "2099-11-04T10:00", channel: "telegram", admission: "beta" });
  const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
  await runInDurableObject(stub, (agent) => agent.withDeps({ firstContactConsent: true, ledger: d1Ledger(env.LEDGER) }));
  await env.LEDGER.prepare("INSERT INTO invite_code VALUES (?, 'recruit', 'intl_telegram', 'operator', 1)").bind(code).run();

  await c.event({ kind: "lifecycle", change: "follow", code, at: c.clock.now() });
  const start = c.channel.delivered.at(-1)?.button;
  expect(start?.label).toBe("Start");
  expect(c.channel.delivered.at(-1)?.text).not.toMatch(/start (a new account|fresh)/i);
  if (!start) throw new Error("fresh consent is missing");
  expect((await c.snapshot()).agent).toBeNull();
  await c.tap(start.data);

  expect((await c.snapshot()).admission).toMatchObject({ state: "consenting", code });
  expect(c.model.calls).toHaveLength(0);
});

test("a reclaimed Fly box is disclosed without holding account deletion open", async () => {
  const c = await devChat("reclaimed-before-erase", { model: null, at: "2099-11-04T10:00" });
  await c.say("hello");
  await env.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at, deleted_at) VALUES (?, 'g-reclaimed', 'fly', 1, 5)")
    .bind(c.agent).run();
  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing confirmation");
  await c.tap(confirm.data);

  const receipt = c.channel.delivered.at(-1)?.text;
  expect(receipt).toMatch(/deleted your live Giraffe data/);
  expect(receipt).toMatch(/box was removed earlier.*wipe/i);
  expect(receipt).toMatch(/Fly.*older disk copies/i);
  expect(await env.LEDGER.prepare("SELECT name FROM boxes WHERE agent_key = ?").bind(c.agent).first()).toBeNull();
});

test("erase still clears expired unpaid Stripe sessions and discloses retained references", async () => {
  const billing = billingOn();
  let available = false;
  const closeCheckout = vi.fn(async (_id: CheckoutId) => available
    ? { ok: true, value: { subscription: null, retained: false } } as const
    : { ok: false, status: 503, detail: "Stripe unavailable" } as const);
  const c = await devChat("erase-unpaid", {
    model: null,
    at: "2099-11-04T10:00",
    billing: { ...billing.deps, stripe: { ...billing.stripe, closeCheckout } },
  });
  await c.say("/plan");
  await c.say("/plan");
  const expired = [...billing.stripe.sessions].filter(([, status]) => status === "expired").map(([id]) => id);
  expect(expired.length).toBeGreaterThan(0);
  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing confirmation");
  await c.tap(confirm.data);
  expect(await env.LEDGER.prepare("SELECT id FROM agent WHERE agent_key = ?").bind(c.agent).first()).toBeNull();
  expect(c.channel.delivered.at(-1)?.text).not.toMatch(/deleted your live Giraffe data/);
  available = true;
  c.clock.set((c.clock.now() + 61_000) as EpochMs);
  await c.settle();

  expect(closeCheckout.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(expired));
  const receipt = c.channel.delivered.at(-1)?.text;
  expect(receipt).toMatch(/Stripe.*checkout.*even if you didn’t pay/i);
  expect(receipt).not.toMatch(/subscriptions you owned have ended/i);
  const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
  expect(await runInDurableObject(stub, (_, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM checkout_session").one())).toEqual({ n: 0 });
});

test("a subscription 404 leaves billing pending instead of promising it ended", async () => {
  const billing = billingOn();
  let available = false;
  const closeSubscription = vi.fn(async (): Promise<StripeReply<{ readonly retained: boolean }>> => available
    ? { ok: true, value: { retained: false } }
    : { ok: false, status: 404, detail: "subscription read 404" });
  const c = await devChat("erase-sub-404", {
    model: null,
    at: "2099-11-04T10:00",
    billing: { ...billing.deps, stripe: { ...billing.stripe, closeSubscription } },
  });
  await env.LEDGER.prepare("INSERT INTO billing_subscription (id, owner_key, plan, status, seats, updated_at) VALUES ('sub_404', ?, 'standard', 'active', 1, 1)")
    .bind(c.agent).run();
  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing confirmation");
  await c.received();
  await c.tap(confirm.data);

  expect(closeSubscription).toHaveBeenCalledWith("sub_404", c.agent);
  expect(await c.received()).toEqual([]);
  const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
  expect(await runInDurableObject(stub, (_, state) => state.storage.kv.get<Record<string, unknown>>("account:erase")))
    .toMatchObject({ kind: "cleaning", billing: { kind: "pending", subscriptions: ["sub_404"] } });
  expect(await env.LEDGER.prepare("SELECT id FROM billing_subscription WHERE owner_key = ?").bind(c.agent).first()).toBeNull();

  available = true;
  c.clock.set((c.clock.now() + 61_000) as EpochMs);
  await c.settle();
  const receipt = c.channel.delivered.at(-1)?.text;
  expect(receipt).toMatch(/deleted your live Giraffe data/);
  expect(receipt).toMatch(/subscriptions you owned have ended/i);
});

test("a permanent Stripe metadata refusal is disclosed once instead of blocking erasure", async () => {
  const billing = billingOn();
  const closeCheckout = vi.fn(async (_id: CheckoutId) => ({ ok: true, value: { subscription: null, retained: true } } as const));
  const c = await devChat("erase-stripe-retained", {
    model: null,
    at: "2099-11-04T10:00",
    billing: { ...billing.deps, stripe: { ...billing.stripe, closeCheckout } },
  });
  await c.say("/plan");
  const opened = [...billing.stripe.sessions.keys()].sort();
  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing confirmation");
  await c.tap(confirm.data);

  expect(opened.length).toBeGreaterThan(0);
  expect(closeCheckout.mock.calls.map(([id]) => id).sort()).toEqual(opened);
  const receipt = c.channel.delivered.at(-1)?.text;
  expect(receipt).toMatch(/deleted your live Giraffe data/);
  expect(receipt?.match(/Stripe refused removal/g)).toHaveLength(1);
  expect(receipt).toMatch(/Stripe refused removal.*references remain/i);
});
