import { describe, expect, test } from "vitest";
import type { EpochMs } from "../src/domain";
import { NOTICES } from "../src/notices";
import { chat, devChat, local, openTask, propose, schedule, scripted, send, turn } from "./testkit";

const NOTICE = NOTICES.en;
const DAY = 24 * 60 * 60 * 1000;
const TITLE = "Chiang Mai long weekend";
const PLAN = "Fri 18:30 overnight train from Bangkok\nSat Doi Suthep at 7 before the heat, Nimman cafes after\nSun 16:00 flight back";
const PLAN_2 = "Sat 07:00 flight from Don Mueang\nSat Doi Suthep at 10, Nimman cafes after\nSun 16:00 flight back";
const trip = (plan = PLAN) => propose("chiang-mai-trip", TITLE, plan);

describe("a task completes only on evidence", () => {
  test("a check-in offers a plan, the person taps Accept, and the task completes on that tap", async () => {
    const model = scripted([
      chat("Hi!"),
      turn({ actions: [send("Morning! The long weekend is close, so I sketched a trip.")], tasks: [trip()] }),
      chat("Great, I'll remind you on Friday."),
    ]);
    const c = await devChat("tia", { model, at: "2099-11-04T08:00" });
    await c.say("hello");
    await c.received();

    await c.advanceTo("2099-11-04T09:00");
    expect(c.channel.delivered.at(-1)).toMatchObject({
      text: `Morning! The long weekend is close, so I sketched a trip.\n${PLAN}`,
      button: { label: NOTICE.acceptButton, data: "a:1.1" },
    });
    await c.received();

    await c.tap("a:1.1");

    expect(await c.received()).toEqual([`Great, I'll remind you on Friday.\n${NOTICE.planAccepted(TITLE)}`]);
    expect(model.calls[2].user).toContain("The person tapped Accept on plan 1.1.");
    const [task] = (await c.snapshot()).tasks;
    expect(task).toMatchObject({ id: 1, ref: "chiang-mai-trip", kind: "plan", title: TITLE, status: "completed" });
    expect(task.facts.map((f) => [f.kind, f.ref, f.completes, f.personDecision])).toEqual([
      ["opened", "", false, false],
      ["proposed", "1.1", false, false],
      ["plan_accepted", "1.1", true, true],
    ]);
    expect(c.logs("task_fact").filter((f) => f.completes).map((f) => [f.taskId, f.kind, f.causeKind])).toEqual([
      ["p:dev:tia|t1", "plan_accepted", "choice"],
    ]);
    expect(c.logs("unasked").map((u) => [u.status, u.purpose, u.taskId])).toEqual([["sent", "task_followup", "p:dev:tia|t1"]]);
    model.assertDone();
  });

  test("a plain typed yes accepts the plan on the newest message the person received", async () => {
    const model = scripted([turn({ actions: [send("Here's a plan.")], tasks: [trip()] }), chat("Booked in my notes.")]);
    const c = await devChat("tom", { model, at: "2099-11-04T10:00" });
    await c.say("plan me a weekend in Chiang Mai");
    await c.received();

    await c.say("ok ka");

    expect(await c.received()).toEqual([`Booked in my notes.\n${NOTICE.planAccepted(TITLE)}`]);
    const [task] = (await c.snapshot()).tasks;
    expect(task.status).toBe("completed");
    expect(task.facts.at(-1)).toMatchObject({ kind: "plan_accepted", completes: true, detail: { via: "typed", version: 1 } });
  });

  test("an accept tap still commits, and is confirmed, when the model fails on that turn", async () => {
    const model = scripted([turn({ actions: [send("Here's a plan.")], tasks: [trip()] }), { kind: "fail", failure: "refused_by_model" }]);
    const c = await devChat("uma", { model, at: "2099-11-04T10:00" });
    await c.say("plan me a weekend in Chiang Mai");
    await c.received();

    await c.tap("a:1.1");

    expect(await c.received()).toEqual([NOTICE.planAccepted(TITLE)]);
    expect((await c.snapshot()).tasks[0].status).toBe("completed");
    expect(c.logs("turn").at(-1)?.outcome).toBe("model_failed");
  });

  test("a newer plan supersedes the old one, whose tap records nothing and says the plan changed", async () => {
    const model = scripted([
      turn({ actions: [send("Here's a plan.")], tasks: [trip()] }),
      turn({ actions: [send("Moved it to Saturday.")], tasks: [trip(PLAN_2)] }),
      chat("That one's older."),
      chat("Done."),
      chat("Already on it."),
    ]);
    const c = await devChat("vik", { model, at: "2099-11-04T10:00" });
    await c.say("plan me a weekend in Chiang Mai");
    await c.say("make it Saturday");
    expect(c.channel.delivered.map((d) => d.button?.data)).toEqual(["a:1.1", "a:1.2"]);
    await c.received();

    await c.tap("a:1.1");
    expect(await c.received()).toEqual([`That one's older.\n${NOTICE.planChanged}`]);
    expect((await c.snapshot()).tasks[0].status).toBe("open");

    await c.tap("a:1.2");
    await c.received();
    await c.tap("a:1.2");
    expect(await c.received()).toEqual(["Already on it."]);
    const [task] = (await c.snapshot()).tasks;
    expect(task.status).toBe("completed");
    expect(task.facts.filter((f) => f.kind === "plan_accepted").map((f) => f.ref)).toEqual(["1.2"]);
    model.assertDone();
  });

  test("the prompt lists open tasks, and a closed task can't be completed by a later tap", async () => {
    const model = scripted([
      turn({ actions: [send("Here's a plan.")], tasks: [trip()] }),
      turn({ actions: [send("Dropped it.")], tasks: [{ op: "close", ref: "chiang-mai-trip", kind: "plan", title: TITLE, plan: "" }] }),
      chat("It was cancelled."),
    ]);
    const c = await devChat("wen", { model, at: "2099-11-04T10:00" });
    await c.say("plan me a weekend in Chiang Mai");
    await c.say("never mind");
    expect(model.calls[1].user).toContain(`## Open tasks\n- chiang-mai-trip (plan): ${TITLE}. Plan 1.1 offered.`);

    await c.tap("a:1.1");

    const [task] = (await c.snapshot()).tasks;
    expect(task.status).toBe("closed");
    expect(task.facts.map((f) => [f.kind, f.completes])).toEqual([
      ["opened", false],
      ["proposed", false],
      ["closed", false],
      ["plan_accepted", false],
    ]);
  });
});

describe("why an unasked message was sent", () => {
  test("the agent's wake-up for a task follows that task up", async () => {
    const model = scripted([
      turn({ actions: [schedule("trip-check", "2099-11-04T18:00", "Ask if the dates work", false, "chiang-mai-trip"), send("Here's a plan.")], tasks: [trip()] }),
      turn({ actions: [send("Do those dates still work?")] }),
    ]);
    const c = await devChat("xia", { model, at: "2099-11-04T10:00" });
    await c.say("plan me a weekend in Chiang Mai");

    await c.advanceTo("2099-11-04T18:00");

    expect((await c.received()).at(-1)).toBe("Do those dates still work?");
    expect(c.logs("unasked").map((u) => [u.purpose, u.taskId])).toEqual([["task_followup", "p:dev:xia|t1"]]);
  });

  test("a check-in about no task is unlinked", async () => {
    const model = scripted([chat("Hi!"), turn({ actions: [send("Morning!")], about: "nothing-like-this" })]);
    const c = await devChat("yan", { model, at: "2099-11-04T08:00" });
    await c.say("hello");

    await c.advanceTo("2099-11-04T09:00");

    expect(c.logs("unasked").map((u) => [u.purpose, u.taskId])).toEqual([["unlinked", null]]);
  });
});

test("an open task nobody touched for 30 days expires, with a fact that says so", async () => {
  const model = scripted([turn({ actions: [send("Noted.")], tasks: [openTask("visa", "Renew the visa")] })]);
  const c = await devChat("zoe", { model, at: "2099-11-04T10:00" });
  await c.say("I need to renew my visa at some point");
  await c.say("/block");

  c.clock.set((local("2099-11-04T10:00") + 31 * DAY) as EpochMs);
  await c.settle();

  const [task] = (await c.snapshot()).tasks;
  expect(task.status).toBe("expired");
  expect(task.facts.map((f) => f.kind)).toEqual(["opened", "expired"]);
  expect(c.logs("task_fact").map((f) => f.kind)).toEqual(["opened", "expired"]);
});
