import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { ADMISSION } from "../src/agent/admission";
import { loadConfig, type Env } from "../src/config";
import { MIGRATIONS, migrate } from "../src/agent/schema";
import { AgentStore } from "../src/agent/store";
import { eventKey, type AgentKey, type InviteCode } from "../src/domain";
import { NOTICES } from "../src/notices";
import { chat, devChat, fakeBox, fakeProvider, giveKey, local, memoryLedger, type DevChat, type MemoryLedger, schedule, scripted, send, STRIPE_VARS, turn } from "./testkit";

const t = NOTICES.en;
const FULL_BETA = "The beta is full right now. There's no date for new places yet. To check again, send your invite code here.";
const CODE = "K7P3QZ" as InviteCode;

async function mint(code: string, cohort = "recruit", half: string | null = "intl_telegram"): Promise<void> {
  await env.LEDGER.prepare("INSERT INTO invite_code (code, cohort, half, issuer, created_at) VALUES (?, ?, ?, 'operator', 0)").bind(code, cohort, half).run();
}

async function enrolled(agent: string) {
  return env.LEDGER.prepare("SELECT agent_key, code, cohort, half, inviter, channel FROM enrollment WHERE agent_key = ?").bind(agent).first();
}

async function fillRecruits(): Promise<void> {
  await env.LEDGER.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO enrollment (agent_key, code, cohort, half, inviter, channel, seated_at)
     SELECT 'p:telegram:filler' || i, 'FILL' || i, 'recruit', 'intl_telegram', NULL, 'telegram', 0 FROM n`,
  )
    .bind(ADMISSION.caps.recruit)
    .run();
}

function doRows(agent: AgentKey, sql: string): Promise<unknown[]> {
  return runInDurableObject(env.AGENT.get(env.AGENT.idFromName(agent)), (_a, state) => state.storage.sql.exec(sql).toArray());
}

const follow = (c: DevChat, code?: InviteCode) =>
  code ? ({ kind: "lifecycle", change: "follow", at: c.clock.now(), code } as const) : ({ kind: "lifecycle", change: "follow", at: c.clock.now() } as const);

describe("admission to the beta", () => {
  test("a LINE stranger is asked for a code once a day, in Thai, with no model call, no push and no check-in", async () => {
    const model = scripted([]);
    const c = await devChat("U00000000000000000000000000000a01", { model, at: "2099-11-04T10:00", channel: "line", admission: "beta" });

    await c.say("hello");
    await c.say("anyone there?");

    expect(await c.received()).toEqual([NOTICES.th.waitlist.no_code]);
    const s = await c.snapshot();
    expect(s.admission).toEqual({ state: "waitlisted", reason: "no_code", toldOn: "2099-11-04" });
    expect(s.outbox.map((o) => o.replyOnly)).toEqual([true]);
    expect(s.pendingWakeups).toEqual([]);
    expect(model.calls).toEqual([]);
    expect(c.logs("admission").map((r) => [r.change, r.reason])).toEqual([["waitlisted", "no_code"]]);
  });

  test("a Telegram recruit's start code asks for consent, and consent claims the seat, admits them and starts check-ins", async () => {
    await mint(CODE);
    const model = scripted([chat("Hi! What do you need?")]);
    const c = await devChat("5531", { model, at: "2099-11-04T10:00", channel: "telegram", admission: "beta" });

    await c.event(follow(c, CODE));
    expect(c.channel.delivered.at(-1)).toMatchObject({ text: t.privacy, button: { label: t.consentButton, data: "c" } });
    expect(await enrolled("p:telegram:5531")).toBeNull();

    await c.tap("c");
    expect(await c.received()).toEqual([
      t.privacy,
      "You're in. Tell me what you'd like a hand with. I may send a morning check-in when I have AI access and something useful to share.",
    ]);
    const s = await c.snapshot();
    expect(s.admission).toMatchObject({ state: "admitted", seat: { cohort: "recruit", half: "intl_telegram", code: CODE, inviter: null } });
    expect(s.pendingWakeups.map((w) => w.kind)).toEqual(["checkin"]);
    expect(await enrolled("p:telegram:5531")).toEqual({
      agent_key: "p:telegram:5531",
      code: CODE,
      cohort: "recruit",
      half: "intl_telegram",
      inviter: null,
      channel: "telegram",
    });
    expect(c.logs("admission").map((r) => r.change)).toEqual(["consenting", "consented"]);

    await c.say("hello");
    expect(await c.received()).toEqual(["Hi! What do you need?"]);
    model.assertDone();
  });

  test("an unknown code, a used one and one for a full beta each waitlist the person and say why", async () => {
    await mint(CODE);
    await mint("USED22");
    await env.LEDGER.prepare(
      "INSERT INTO enrollment (agent_key, code, cohort, half, inviter, channel, seated_at) VALUES ('p:telegram:1', 'USED22', 'recruit', 'intl_telegram', NULL, 'telegram', 0)",
    ).run();
    await fillRecruits();
    const said = async (user: string, text: string) => {
      const c = await devChat(user, { model: scripted([]), at: "2099-11-04T10:00", channel: "telegram", admission: "beta" });
      await c.say(text);
      return { received: await c.received(), admission: (await c.snapshot()).admission };
    };

    expect(await said("901", "ZZZZZZ")).toEqual({ received: [t.waitlist.bad_code], admission: { state: "waitlisted", reason: "bad_code", toldOn: "2099-11-04" } });
    expect(await said("902", "/join used22")).toEqual({ received: [t.waitlist.used], admission: { state: "waitlisted", reason: "used", toldOn: "2099-11-04" } });
    expect(await said("903", CODE)).toEqual({
      received: [FULL_BETA],
      admission: { state: "waitlisted", reason: "full", toldOn: "2099-11-04" },
    });
  });

  test("caps invite-code checks per person each hour without calling D1 past the cap", async () => {
    const base = memoryLedger();
    const realCheck = base.checkInvite;
    let checks = 0;
    const ledger = Object.assign(base, {
      checkInvite: async (req: Parameters<MemoryLedger["checkInvite"]>[0]) => {
        checks += 1;
        return realCheck(req);
      },
    });
    const c = await devChat("5536", { model: scripted([]), at: "2099-11-04T10:00", channel: "telegram", admission: "beta", ledger });
    const over = ADMISSION.inviteChecksPerHour + 2;

    for (let i = 0; i < over; i++) await c.say("ZZZZZZ");

    expect(await c.received()).toEqual(Array(ADMISSION.inviteChecksPerHour).fill(t.waitlist.bad_code));
    expect(checks).toBe(ADMISSION.inviteChecksPerHour);

    await c.advanceTo("2099-11-04T11:00");
    await c.say("ZZZZZZ");

    expect(await c.received()).toEqual([t.waitlist.bad_code]);
    expect(checks).toBe(ADMISSION.inviteChecksPerHour + 1);
  });

  test("rate-event storage upgrades from the schema just before it", async () => {
    const stub = env.AGENT.get(env.AGENT.idFromName("rate-event-upgrade"));
    await runInDurableObject(stub, (_a, { storage }) => {
      const version = MIGRATIONS.findIndex((migration) => migration.includes("CREATE TABLE rate_event")) + 1;
      expect(version).toBeGreaterThan(0);
      storage.sql.exec("DROP TABLE routine_delivery");
      storage.sql.exec("DROP TABLE rate_event");
      storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'schema_version'", String(version - 1));

      migrate(storage);

      expect(storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'schema_version'").one().v).toBe(String(MIGRATIONS.length));
      const store = new AgentStore(storage);
      const now = local("2099-11-04T10:00");
      expect(store.rateLimited("invite", now, 60_000, 1)).toBe(false);
      expect(store.rateLimited("invite", now, 60_000, 1)).toBe(true);
    });
  });

  test("a beta that filled up between the code and consent waitlists the person as full", async () => {
    await mint(CODE);
    const c = await devChat("5532", { model: scripted([]), at: "2099-11-04T10:00", channel: "telegram", admission: "beta" });
    await c.event(follow(c, CODE));
    await fillRecruits();

    await c.tap("c");

    expect((await c.received()).at(-1)).toBe(FULL_BETA);
    expect((await c.snapshot()).admission).toMatchObject({ state: "waitlisted", reason: "full" });
    expect(await enrolled("p:telegram:5532")).toBeNull();
  });

  test("the Thai welcome says morning check-ins depend on AI access and having something useful to share", async () => {
    await mint(CODE, "recruit", "th_line");
    const c = await devChat("U00000000000000000000000000000a02", { model: null, at: "2099-11-04T10:00", channel: "line", admission: "beta" });
    await c.say(CODE);
    await c.tap("c");
    expect((await c.received()).at(-1)).toBe(
      "เข้าร่วมรุ่นทดลองแล้วค่ะ อยากให้ช่วยเรื่องไหนบอกได้เลย ถ้าใช้ AI ได้และมีเรื่องที่น่าบอก อาจทักไปตอนเช้านะคะ",
    );
  });

  test("the Thai notice for a full beta tells the person how to check again", async () => {
    await mint(CODE, "recruit", "th_line");
    await fillRecruits();
    const c = await devChat("U00000000000000000000000000000a03", { model: null, at: "2099-11-04T10:00", channel: "line", admission: "beta" });
    await c.say(CODE);
    expect(await c.received()).toEqual([
      "ตอนนี้รุ่นทดลองเต็มแล้วค่ะ ยังไม่มีกำหนดเปิดรับเพิ่ม ถ้าอยากเช็กอีกครั้ง ส่งรหัสเชิญในแชตนี้ได้เลยค่ะ",
    ]);
  });

  test("a D1 it can't reach holds the answer for a retry, then says to try again, and admits nobody", async () => {
    const ledger = Object.assign(memoryLedger(), {
      checkInvite: async () => {
        throw new Error("D1 unavailable");
      },
    });
    const c = await devChat("5533", { model: scripted([]), at: "2099-11-04T10:00", channel: "telegram", admission: "beta", ledger });

    await c.say(CODE);
    expect(await c.received()).toEqual([]);

    await c.advanceTo("2099-11-04T10:05");
    expect(await c.received()).toEqual([t.billingBusy]);
    expect((await c.snapshot()).admission).toEqual({ state: "stranger" });
  });

  test("an enrolled person can invite five joiners, who inherit their half and name them as the inviter", async () => {
    await mint(CODE, "recruit", "th_line");
    const host = await devChat("5534", { model: scripted([]), at: "2099-11-04T10:00", channel: "telegram", admission: "beta" });
    await host.event(follow(host, CODE));
    await host.tap("c");
    await host.received();

    for (let i = 0; i < ADMISSION.invitesPerPerson + 1; i++) await host.say("/invite");

    const sent = await host.received();
    expect(sent.at(-1)).toBe(t.inviteLimit(ADMISSION.invitesPerPerson));
    const codes = sent.slice(0, -1).map((text) => /\/join (\w+)$/.exec(text)?.[1]);
    expect(codes).toHaveLength(ADMISSION.invitesPerPerson);

    const friend = await devChat("5535", { model: scripted([]), at: "2099-11-04T11:00", channel: "telegram", admission: "beta" });
    await friend.say(`/join ${codes[0]}`);
    await friend.tap("c");
    expect(await enrolled("p:telegram:5535")).toMatchObject({ cohort: "joiner", half: "th_line", inviter: "p:telegram:5534" });
  });

  test("a person who isn't enrolled can't invite anyone, and an admitted person's code is answered without D1", async () => {
    const ledger = Object.assign(memoryLedger(), {
      checkInvite: async () => {
        throw new Error("must not be asked");
      },
    });
    const c = await devChat("staffer", { model: scripted([]), at: "2099-11-04T10:00", admission: "beta", ledger });

    await c.say("/invite");
    await c.say(`/join ${CODE}`);

    expect(await c.received()).toEqual([t.inviteNotEnrolled, t.alreadyIn]);
  });

  test("a removed person's wake-ups are skipped and ordinary messages get a fixed reply, without the model", async () => {
    const model = scripted([turn({ actions: [schedule("nudge", "2099-11-04T12:00", "Ask about the trip", false), send("OK.")] })]);
    const c = await devChat("gone", { model, at: "2099-11-04T10:00", admission: "beta" });
    await c.say("remind yourself to ask me later");
    await c.received();

    await c.remove();
    await c.advanceTo("2099-11-04T12:30");
    await c.say("hello?");

    expect(await c.received()).toEqual([t.removed]);
    expect(model.calls).toHaveLength(1);
    expect((await c.snapshot()).admission).toMatchObject({ state: "removed" });
    expect(c.logs("admission").map((r) => r.change)).toEqual(["consented", "removed"]);
  });

  test("with open admission, a removed person stays removed, and a message, a consent tap or a code gets the fixed reply without the model or D1", async () => {
    const refuse = async () => {
      throw new Error("must not be asked");
    };
    const ledger = Object.assign(memoryLedger(), { checkInvite: refuse, claimSeat: refuse });
    const model = scripted([chat("Hi.")]);
    const c = await devChat("gone-open", { model, at: "2099-11-04T10:00", admission: "open", ledger });
    await c.say("hi");
    await c.received();

    await c.remove();
    await c.say("hello?");
    await c.tap("c");
    await c.say(`/join ${CODE}`);

    expect(await c.received()).toEqual([t.removed, t.removed, t.removed]);
    expect(model.calls).toHaveLength(1);
    expect((await c.snapshot()).admission).toMatchObject({ state: "removed" });
    expect(c.logs("admission").map((r) => r.change)).toEqual(["consented", "removed"]);
  });

  test("a removed person's key link no longer validates, and their tickets are gone", async () => {
    const provider = fakeProvider([{ kind: "output", value: { ok: true } }]);
    const c = await devChat("rem1", { model: null, provider, at: "2099-11-04T10:00", admission: "beta" });
    await c.say("/key");
    const ticket = /#t=([^&\s]+)/.exec((await c.received()).join("\n"))![1];

    await c.remove();
    const res = await SELF.fetch("https://giraffes.test/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket, provider: "opencode-go", model: "", baseUrl: "", key: "oc_sk_live_abcdefghijklmnop0123456789" }),
    });

    expect(await res.json()).toEqual({ ok: false, error: "expired" });
    expect(provider.seen).toHaveLength(0);
    expect((await c.snapshot()).access.key).toBeNull();
    expect(await doRows(c.agent, "SELECT * FROM key_ticket")).toEqual([]);
  });

  test("removing a person deletes their saved key", async () => {
    const c = await devChat("rem4", { model: scripted([]), at: "2099-11-04T10:00", admission: "beta" });
    await c.say("/key");
    await c.received();
    await giveKey(c.agent);

    await c.remove();

    expect(await doRows(c.agent, "SELECT * FROM model_key")).toEqual([]);
    expect((await c.snapshot()).access.key).toBeNull();
  });

  test("a removed person who still has a key can delete it with /key remove, and only that command is answered", async () => {
    const model = scripted([]);
    const c = await devChat("rem5", { model, at: "2099-11-04T10:00", admission: "beta" });
    await c.say("/key");
    await c.received();
    await c.remove();
    await giveKey(c.agent);

    await c.say("/key remove");
    await c.say("/key remove");
    await c.say("/key");

    expect(await c.received()).toEqual([t.keyRemoved, t.noKey, t.removed]);
    expect(await doRows(c.agent, "SELECT * FROM model_key")).toEqual([]);
    expect(JSON.stringify((await c.snapshot()).turns)).not.toContain("/key remove");
    expect(model.calls).toHaveLength(0);
  });

  test("removing a person again deletes a key they still had", async () => {
    const c = await devChat("rem6", { model: scripted([]), at: "2099-11-04T10:00", admission: "beta" });
    await c.say("/key");
    await c.received();
    await c.remove();
    await giveKey(c.agent);

    await c.remove();

    expect(await doRows(c.agent, "SELECT * FROM model_key")).toEqual([]);
    expect(c.logs("admission").map((r) => r.change)).toEqual(["consented", "removed"]);
  });

  test("a waitlisted person can send /key remove and is told they have no key, and it stays out of their history", async () => {
    const c = await devChat("wait1", { model: scripted([]), at: "2099-11-04T10:00", channel: "telegram", admission: "beta" });
    await c.say("hello");
    expect((await c.snapshot()).admission).toMatchObject({ state: "waitlisted" });
    await c.received();

    await c.say("/key remove");

    expect(await c.received()).toEqual([t.noKey]);
    expect((await c.snapshot()).turns).toEqual([]);
  });

  test("a removed person's box is retired without provisioning it further", async () => {
    const retry = { retryable: true, detail: "503" };
    const box = fakeBox({ host: [retry, retry, retry, retry, retry] });
    const c = await devChat("rem2", { model: scripted([]), at: "2099-11-04T10:00", admission: "beta", box: box.deps });
    await c.say("/claude");
    const calls = box.ensureCalls.length;
    expect((await c.snapshot()).box?.state).toBe("provisioning");

    await c.remove();
    await c.advanceTo("2099-11-04T11:00");

    expect(box.ensureCalls).toHaveLength(calls);
    expect(box.healthCalls).toEqual([]);
    expect((await c.snapshot()).box).toBeNull();
  });

  test("removing a person retires their connected box and frees its place, even on repeat removal", async () => {
    const box = fakeBox({ signedIn: true, maxBoxes: 1 });
    const ledger = memoryLedger();
    const c = await devChat("rem-connected", { model: null, at: "2099-11-04T10:00", admission: "beta", box: box.deps, ledger });
    const next = await devChat("rem-next", { model: null, at: "2099-11-04T10:00", admission: "beta", box: box.deps, ledger });
    await c.say("/claude");
    await c.received();
    expect((await c.snapshot()).box?.state).toBe("signed_in");

    await c.remove();
    await c.remove();
    await next.say("/claude");

    expect((await c.snapshot()).box).toBeNull();
    expect(box.destroyCalls).toEqual([await box.nameOf("rem-connected")]);
    expect(box.created.has(await box.nameOf("rem-connected"))).toBe(false);
    expect((await next.snapshot()).box?.state).toBe("signed_in");
    expect(await c.received()).toEqual([]);
  });

  test("a person removed before box retirement was added can still remove their box in open admission", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("rem-legacy-box", { model: null, at: "2099-11-04T10:00", admission: "open", box: box.deps });
    await c.say("/claude");
    await c.received();
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_a, state) =>
      new AgentStore(state.storage).remove(c.clock.now()),
    );
    expect((await c.snapshot()).box?.state).toBe("signed_in");

    await c.say("/claude remove");
    await c.say("/claude remove");
    await c.say("/claude");

    expect(await c.received()).toEqual([t.box.removing("", ""), t.box.removed("", ""), t.removed]);
    expect((await c.snapshot()).admission.state).toBe("removed");
    expect((await c.snapshot()).box).toBeNull();
    expect(box.created.size).toBe(0);
    expect(JSON.stringify((await c.snapshot()).turns)).not.toContain("/claude remove");
  });

  test("a disk retirement that always fails stays pending for the person and is reported on each retry", async () => {
    const box = fakeBox({ signedIn: true });
    const deps = {
      ...box.deps,
      host: {
        ...box.deps.host,
        retireWipedDisk: vi.fn(async () => ({ ok: false as const, retryable: true, detail: "disk stays live" })),
      },
    };
    const ledger = memoryLedger();
    const c = await devChat("rem-stuck", { model: null, at: "2099-11-04T10:00", admission: "beta", box: deps, ledger });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await c.say("/claude");
      await c.received();
      await c.remove();
      await c.say("/claude remove");
      await c.remove();
      expect(deps.host.retireWipedDisk).toHaveBeenCalledTimes(1);
      await c.advanceTo("2099-11-04T10:01");

      expect(deps.host.retireWipedDisk).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls).toEqual(Array.from({ length: 3 }, () => [{ code: "box_reclaim_failed" }]));
      expect(await c.received()).toEqual([t.box.removing("", "")]);
      expect((await c.snapshot()).box?.state).toBe("reclaiming");
      expect(ledger.boxes.has(c.agent)).toBe(true);
      expect(box.created.size).toBe(1);
      expect(box.destroyCalls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    ["stranger", "5541"], ["waitlisted", "5542"], ["consenting", "5543"],
  ] as const)("a person in the %s state can send /claude remove without changing their admission", async (state, user) => {
    const c = await devChat(user, { model: null, at: "2099-11-04T10:00", channel: "telegram", admission: "beta" });
    if (state === "waitlisted") await c.say("hello");
    if (state === "consenting") {
      await mint(CODE);
      await c.say(CODE);
    }
    await c.received();
    expect((await c.snapshot()).admission.state).toBe(state);

    await c.say("/claude remove");

    expect(await c.received()).toEqual([t.box.removed("", "")]);
    expect((await c.snapshot()).admission.state).toBe(state);
  });

  test("the first message can remove a Claude connection without creating an account", async () => {
    const c = await devChat("5544", { model: null, at: "2099-11-04T10:00", channel: "telegram", admission: "beta" });
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (agent) =>
      agent.withDeps({ firstContactConsent: true }),
    );

    await c.say("/claude remove");

    expect(await c.received()).toEqual([t.box.removed("", "")]);
    expect((await c.snapshot()).agent).toBeNull();
  });

  test("removal drops pending pushes with reason removed, nothing queued later is pushed, and the fixed reply still arrives", async () => {
    const c = await devChat("rem3", { model: scripted([chat("Hi.")]), at: "2099-11-04T10:00", admission: "beta", deliveries: [{ kind: "retry", afterMs: 10 * 60_000 }] });
    await c.say("hi");
    expect(await doRows(c.agent, "SELECT status FROM outbox")).toEqual([{ status: "pending" }]);

    await c.remove();
    expect(await doRows(c.agent, "SELECT status, drop_reason FROM outbox")).toEqual([{ status: "dropped", drop_reason: "removed" }]);

    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_a, state) =>
      new AgentStore(state.storage).notifyOnce("late", eventKey.billing("late"), { texts: ["A late push."], note: "A late push." }, local("2099-11-04T10:01")),
    );
    c.clock.set(local("2099-11-04T10:30"));
    await c.settle();
    await c.say("hello?");

    expect(await c.received()).toEqual([t.removed]);
    expect(await doRows(c.agent, "SELECT drop_reason FROM outbox WHERE status = 'dropped' ORDER BY rowid")).toEqual([{ drop_reason: "removed" }, { drop_reason: "removed" }]);
  });

  test("beta admission can't run with billing on, and is the default", () => {
    const base = { MODEL_BACKEND: "scripted", DEV_MODE: "1", ...STRIPE_VARS } as unknown as Env;
    expect(() => loadConfig({ ...base, ADMISSION: "beta" })).toThrow(/ADMISSION=beta/);
    expect(loadConfig({ ...base, ADMISSION: "open" }).admission).toBe("open");
    expect(loadConfig({ MODEL_BACKEND: "scripted", DEV_MODE: "1" } as Env).admission).toBe("beta");
  });
});
