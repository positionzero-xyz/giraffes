import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type { AgentKey } from "../src/domain";
import { NOTICES } from "../src/notices";
import { chat, devChat, NOTICE_URL, scripted } from "./testkit";

const doRows = (agent: AgentKey, sql: string): Promise<unknown[]> =>
  runInDurableObject(env.AGENT.get(env.AGENT.idFromName(agent)), (_a, state) => state.storage.sql.exec(sql).toArray());

describe("open admission asks for consent before anything else", () => {
  test.each(["line", "telegram"] as const)("a new %s person gets the consent message and button, and nothing they wrote is kept or answered", async (channel) => {
    const model = scripted([]);
    const c = await devChat(channel === "line" ? "U00000000000000000000000000000c01" : "6101", { model, at: "2099-11-04T10:00", channel });
    const t = NOTICES[channel === "line" ? "th" : "en"];

    await c.say("my sister Ploy has a clinic visit on Friday");
    await c.say("are you there?");

    expect(c.channel.delivered.map((d) => ({ text: d.text, button: d.button }))).toEqual([
      { text: t.privacy(NOTICE_URL), button: { label: t.consentButton, data: "c2" } },
      { text: t.privacy(NOTICE_URL), button: { label: t.consentButton, data: "c2" } },
    ]);
    expect((await c.snapshot()).admission).toEqual({ state: "stranger" });
    expect(c.logs("admission")).toEqual([]);
    expect(model.calls).toEqual([]);
    expect((await c.snapshot()).pendingWakeups).toEqual([]);
    expect(JSON.stringify(await doRows(c.agent, "SELECT text FROM turn"))).not.toContain("Ploy");
    expect(JSON.stringify(await doRows(c.agent, "SELECT payload FROM inbox"))).not.toContain("Ploy");
  });

  test.each(["/memory", "/key remove"])("a new person's first %s gets the consent message, not an answer", async (command) => {
    const c = await devChat("6104", { model: scripted([]), at: "2099-11-04T10:00", channel: "telegram" });

    await c.say(command);

    expect(await c.received()).toEqual([NOTICES.en.privacy(NOTICE_URL)]);
    expect((await c.snapshot()).admission).toEqual({ state: "stranger" });
  });


  test("the consent tap admits the person, logs consent once, starts check-ins, and their next message is answered", async () => {
    const model = scripted([chat("Hi! What do you need?")]);
    const c = await devChat("6102", { model, at: "2099-11-04T10:00", channel: "telegram" });
    const t = NOTICES.en;

    await c.say("hello");
    await c.tap("c2");

    expect(await c.received()).toEqual([t.privacy(NOTICE_URL), t.welcome]);
    const s = await c.snapshot();
    expect(s.admission).toMatchObject({ state: "admitted", seat: { cohort: "staff" } });
    expect(s.pendingWakeups.map((w) => w.kind)).toEqual(["checkin"]);
    expect(c.logs("admission").map((r) => r.change)).toEqual(["consented"]);

    await c.say("hello again");
    expect(await c.received()).toEqual(["Hi! What do you need?"]);
    model.assertDone();
  });

  test("a person the operator removed stays removed under open admission", async () => {
    const c = await devChat("6103", { model: scripted([]), at: "2099-11-04T10:00", channel: "telegram" });
    await c.consent();
    await c.remove();

    await c.say("let me back in");
    await c.tap("c2");

    expect(await c.received()).toEqual([NOTICES.en.removed, NOTICES.en.removed]);
    expect((await c.snapshot()).admission).toMatchObject({ state: "removed" });
    expect(c.logs("admission").map((r) => r.change)).toEqual(["consented", "removed"]);
  });

  test("a dev person is still admitted at first contact", async () => {
    const c = await devChat("open-dev", { model: scripted([chat("Hi.")]), at: "2099-11-04T10:00" });
    await c.say("hello");
    expect(await c.received()).toEqual(["Hi."]);
    expect(c.logs("admission").map((r) => r.change)).toEqual(["consented"]);
  });
});
