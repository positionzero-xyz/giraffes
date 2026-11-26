import { env, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import type { Agent } from "../src/agent/agent";
import { parseInviteCode, type EpochMs } from "../src/domain";
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
  expect(start?.label).toBe("Start fresh");
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

test("a workspace-only box reply keeps account erasure pending", async () => {
  const user = "erase-with-box";
  const volume = "00000000-0000-4000-8000-000000000002";
  const box = fakeBox({ onlyFor: user, signedIn: true, volume });
  const billing = billingOn();
  const closeSubscription = vi.fn(async () => ({ ok: true, value: "settled" } as const));
  let accountProof = false;
  const c = await devChat(user, {
    model: null,
    at: "2099-11-04T10:00",
    billing: { ...billing.deps, stripe: { ...billing.stripe, closeSubscription, closeCheckout: async () => ({ ok: true, value: null }) } },
    box: {
      ...box.deps,
      host: { ...box.deps.host, kind: "static" },
      client: {
        ...box.deps.client,
        async erase(_url, _token, request) {
          if (typeof request === "number") throw new Error("workspace erase requested");
          expect(request).toMatchObject({ scope: "account", box: volume });
          return {
            kind: "erased", box: volume, floor: request.epoch,
            ...(accountProof ? { scope: "account" as const } : {}),
          };
        },
      },
    },
  });
  await env.LEDGER.prepare("INSERT INTO billing_subscription (id, owner_key, plan, status, seats, updated_at) VALUES ('sub_box_erase', ?, 'standard', 'active', 1, 1)")
    .bind(c.agent).run();
  await c.say("/claude");
  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing confirmation");
  await c.tap(confirm.data);
  expect(closeSubscription).toHaveBeenCalledWith("sub_box_erase", c.agent);
  expect(c.channel.delivered.at(-1)?.text).not.toMatch(/deleted your live Giraffe data/);
  await c.say("please answer this");
  accountProof = true;
  c.clock.set((c.clock.now() + 60_000) as EpochMs);
  await c.settle();
  expect(c.channel.delivered.at(-1)?.text).toMatch(/deleted your live Giraffe data/);
  expect(closeSubscription).toHaveBeenCalledTimes(1);
  expect((await c.snapshot()).box).toBeNull();
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
  expect(start?.label).toBe("Start fresh");
  if (!start) throw new Error("fresh consent is missing");
  expect((await c.snapshot()).agent).toBeNull();
  await c.tap(start.data);

  expect((await c.snapshot()).admission).toMatchObject({ state: "consenting", code });
  expect(c.model.calls).toHaveLength(0);
});
