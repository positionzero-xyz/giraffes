import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { ADMISSION } from "../src/agent/admission";
import { loadConfig, type Env } from "../src/config";
import type { InviteCode } from "../src/domain";
import { NOTICES } from "../src/notices";
import { chat, devChat, memoryLedger, schedule, scripted, send, STRIPE_VARS, turn } from "./testkit";

const t = NOTICES.en;
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

const follow = (c: { clock: { now(): number } }, code?: InviteCode) =>
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
    expect(await c.received()).toEqual([t.privacy, t.welcome]);
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
    expect(await said("903", CODE)).toEqual({ received: [t.waitlist.full], admission: { state: "waitlisted", reason: "full", toldOn: "2099-11-04" } });
  });

  test("a beta that filled up between the code and consent waitlists the person as full", async () => {
    await mint(CODE);
    const c = await devChat("5532", { model: scripted([]), at: "2099-11-04T10:00", channel: "telegram", admission: "beta" });
    await c.event(follow(c, CODE));
    await fillRecruits();

    await c.tap("c");

    expect((await c.received()).at(-1)).toBe(t.waitlist.full);
    expect((await c.snapshot()).admission).toMatchObject({ state: "waitlisted", reason: "full" });
    expect(await enrolled("p:telegram:5532")).toBeNull();
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

  test("a removed person's wake-ups are skipped and every message gets a fixed reply, without the model", async () => {
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

  test("beta admission can't run with billing on, and is the default", () => {
    const base = { MODEL_BACKEND: "scripted", DEV_MODE: "1", ...STRIPE_VARS } as unknown as Env;
    expect(() => loadConfig({ ...base, ADMISSION: "beta" })).toThrow(/ADMISSION=beta/);
    expect(loadConfig({ ...base, ADMISSION: "open" }).admission).toBe("open");
    expect(loadConfig({ MODEL_BACKEND: "scripted", DEV_MODE: "1" } as Env).admission).toBe("beta");
  });
});
