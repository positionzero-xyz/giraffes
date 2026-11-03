import { describe, expect, test } from "vitest";
import { NOTICE } from "../src/agent/turn";
import { chat, crash, devChat, hold, local, memoryLedger, quiet, schedule, scripted, send, turn } from "./testkit";

const until = async (done: () => boolean) => {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!done()) throw new Error("condition never became true");
};

describe("conversation", () => {
  test("a message gets a reply", async () => {
    const model = scripted([chat("Hi! What can I do for you?")]);
    const c = await devChat("ann", { model, at: "2099-11-04T10:00" });

    await c.say("hello");

    expect(await c.received()).toEqual(["Hi! What can I do for you?"]);
    expect(model.calls[0].user).toContain("Person: hello");
    expect(c.logs("turn").map((l) => [l.eventKind, l.outcome])).toEqual([["message", "acted"]]);
    model.assertDone();
  });

  test("a second message during the model call gets its own turn, which sees the first reply", async () => {
    const model = scripted([hold(chat("First answer.")), chat("Second answer.")]);
    const c = await devChat("ben", { model, at: "2099-11-04T10:00" });

    await c.post("first question");
    await until(() => model.calls.length === 1);
    await c.post("second question");
    model.release();
    await c.settle();

    expect(await c.received()).toEqual(["First answer.", "Second answer."]);
    expect(model.calls[0].user).not.toContain("second question");
    expect(model.calls[1].user).toContain("You: First answer.");
    expect(model.calls[1].user).toContain("## New\nPerson: second question");
    model.assertDone();
  });
});

describe("reminders", () => {
  test("'remind me at 18:00' fires through the alarm and is delivered", async () => {
    const model = scripted([
      turn({ actions: [schedule("call-clinic", "2099-11-04T18:00", "Remind: call the clinic"), send("Done.")], task: ["reminder", "call-clinic", "started"] }),
      turn({ actions: [send("Time to call the clinic.")], task: ["reminder", "call-clinic", "completed"] }),
    ]);
    const c = await devChat("cat", { model, at: "2099-11-04T10:00" });

    await c.say("remind me at 6pm to call the clinic");
    expect(await c.received()).toEqual(["Done."]);

    await c.advanceTo("2099-11-04T17:59");
    expect(await c.received()).toEqual([]);

    await c.advanceTo("2099-11-04T18:00");
    expect(await c.received()).toEqual(["Time to call the clinic."]);
    expect(model.calls[1].user).toContain('Your wake-up "call-clinic" fired: Remind: call the clinic.');
    expect(c.logs("turn").map((l) => l.taskStatus)).toEqual(["started", "completed"]);
    model.assertDone();
  });

  test("a reminder the person asked for at 23:00 arrives at 23:00 and isn't counted as unasked", async () => {
    const model = scripted([
      turn({ actions: [schedule("bins", "2099-11-04T23:00", "Take the bins out"), send("Will do.")], task: ["reminder", "bins", "started"] }),
      turn({ actions: [send("Take the bins out!")], task: ["reminder", "bins", "completed"] }),
    ]);
    const c = await devChat("dan", { model, at: "2099-11-04T21:30" });

    await c.say("remind me at 11pm to take the bins out");
    expect(await c.received()).toEqual(["Will do."]);

    await c.advanceTo("2099-11-04T23:00");
    expect(await c.received()).toEqual(["Take the bins out!"]);
    expect((await c.snapshot()).unaskedSentToday).toBe(0);
    expect(c.logs("unasked")).toEqual([]);
  });

  test("the agent's own wake-up at 23:00 waits for 08:00 and says it is late", async () => {
    const model = scripted([
      turn({ actions: [schedule("bins", "2099-11-04T23:00", "Ask about the bins", false), send("OK.")], task: ["chat", "bins", "started"] }),
      turn({ actions: [send("Did the bins go out?")], lateNotice: "Sorry, this was due at 23:00 last night.", task: ["chat", "bins", "completed"] }),
    ]);
    const c = await devChat("eve", { model, at: "2099-11-04T21:30" });

    await c.say("I need to take the bins out later");
    await c.received();

    await c.advanceTo("2099-11-05T07:59");
    expect(await c.received()).toEqual([]);

    await c.advanceTo("2099-11-05T08:00");
    expect(await c.received()).toEqual(["Sorry, this was due at 23:00 last night.\nDid the bins go out?"]);
    expect((await c.snapshot()).unaskedSentToday).toBe(1);
  });

  test("the daily check-in fires once per local day", async () => {
    const model = scripted([
      chat("Hi!"),
      chat("Morning! Anything on today?"),
      turn({ actions: [quiet()], task: ["chat", "checkin", "none"] }),
      chat("Morning! How did the interview go?"),
    ]);
    const c = await devChat("fay", { model, at: "2099-11-04T10:00" });
    await c.say("hi");
    await c.received();

    await c.advanceTo("2099-11-07T12:00");
    await c.alarm();
    await c.alarm();

    expect(await c.received()).toEqual(["Morning! Anything on today?", "Morning! How did the interview go?"]);
    const checkins = c.logs("turn").filter((l) => l.eventKind === "checkin");
    expect(checkins.map((l) => l.id.split("|")[1])).toEqual(["checkin:2099-11-05", "checkin:2099-11-06", "checkin:2099-11-07"]);
    model.assertDone();
  });

  test("the fourth unasked message of a local day is dropped and logged", async () => {
    const own = (key: string, at: string) => schedule(key, at, `Follow up ${key}`, false);
    const model = scripted([
      turn({ actions: [own("a", "2099-11-04T11:00"), own("b", "2099-11-04T12:00"), own("c", "2099-11-04T13:00"), own("d", "2099-11-04T14:00"), send("Noted.")], task: ["plan", "trip", "started"] }),
      chat("Update a."),
      chat("Update b."),
      chat("Update c."),
      chat("Update d."),
    ]);
    const c = await devChat("gus", { model, at: "2099-11-04T10:00" });
    await c.say("plan my trip");
    await c.received();

    await c.advanceTo("2099-11-04T15:00");

    expect(await c.received()).toEqual(["Update a.", "Update b.", "Update c."]);
    expect(c.logs("unasked").map((l) => [l.text, l.status])).toEqual([
      ["Update a.", "sent"],
      ["Update b.", "sent"],
      ["Update c.", "sent"],
      ["Update d.", "dropped_budget"],
    ]);
  });
});

describe("crash and duplicate safety", () => {
  test("a redelivered webhook is processed once", async () => {
    const model = scripted([chat("Got it.")]);
    const c = await devChat("hal", { model, at: "2099-11-04T10:00" });

    await c.say("hello", { id: "evt-1" });
    expect(await c.received()).toEqual(["Got it."]);

    expect((await c.post("hello", { id: "evt-1" })).status).toBe(200);
    await c.settle();

    expect(await c.received()).toEqual([]);
    expect(model.calls).toHaveLength(1);
    expect((await c.snapshot()).turns.filter((t) => t.role === "person")).toHaveLength(1);
  });

  test("running the alarm twice, even concurrently, fires a wake-up once", async () => {
    const model = scripted([
      turn({ actions: [schedule("stretch", "2099-11-04T10:05", "Stretch"), send("Sure.")], task: ["reminder", "stretch", "started"] }),
      turn({ actions: [send("Time to stretch.")], task: ["reminder", "stretch", "completed"] }),
    ]);
    const c = await devChat("ivy", { model, at: "2099-11-04T10:00" });
    await c.say("remind me to stretch in 5 minutes");
    await c.received();

    c.clock.set(local("2099-11-04T10:05"));
    await Promise.all([c.alarm(), c.alarm()]);
    await c.alarm();
    await c.settle();

    expect(await c.received()).toEqual(["Time to stretch."]);
    expect(c.logs("turn").filter((l) => l.eventKind === "wakeup")).toHaveLength(1);
    model.assertDone();
  });

  test("a crash during the model call re-runs the turn once and applies it once", async () => {
    const model = scripted([crash(), chat("hi")]);
    const c = await devChat("jon", { model, at: "2099-11-04T10:00" });

    await c.say("hello");

    expect(await c.received()).toEqual(["hi"]);
    expect(c.logs("model_call").map((l) => l.status)).toEqual(["recovered_after_crash", "settled"]);
    expect(c.logs("turn").map((l) => [l.outcome, l.attempts])).toEqual([["acted", 2]]);
    expect((await c.snapshot()).turns.map((t) => [t.role, t.text])).toEqual([
      ["person", "hello"],
      ["agent", "hi"],
    ]);
  });

  test("an event that crashes three times is poisoned with a fixed apology", async () => {
    const model = scripted([crash(), crash(), crash()]);
    const c = await devChat("kim", { model, at: "2099-11-04T10:00" });

    await c.say("hello");

    expect(await c.received()).toEqual([NOTICE.failed]);
    expect(c.logs("turn").map((l) => l.outcome)).toEqual(["poison"]);
    expect(c.logs("model_call").map((l) => l.status)).toEqual(["recovered_after_crash", "recovered_after_crash", "recovered_after_crash"]);
    model.assertDone();
  });
});

describe("spend", () => {
  test("an over-cap person is refused without a model call, told once a day, and logged", async () => {
    const model = scripted([turn({ actions: [send("Here's a long answer.")], task: ["chat", "x", "none"], usage: { inputTokens: 150_000_000 } })]);
    const c = await devChat("lea", { model, at: "2099-11-04T10:00" });
    await c.say("tell me everything");
    await c.received();

    await c.say("are you there?");
    await c.say("hello?");

    expect(await c.received()).toEqual([NOTICE.monthlyLimit]);
    expect(model.calls).toHaveLength(1);
    expect(c.logs("turn").map((l) => [l.outcome, l.refusedForBudget])).toEqual([
      ["acted", false],
      ["refused_budget", true],
      ["refused_budget", true],
    ]);
    expect(c.logs("model_call").map((l) => l.status)).toEqual(["settled", "refused_user_cap", "refused_user_cap"]);
  });

  test("when the global ceiling has no lease left, the call is refused before the model", async () => {
    const model = scripted([]);
    const c = await devChat("max", { model, at: "2099-11-04T10:00", ledger: memoryLedger({ ceilingMicro: 0 }) });

    await c.say("hello");

    expect(await c.received()).toEqual([NOTICE.monthlyLimit]);
    expect(c.logs("model_call").map((l) => l.status)).toEqual(["refused_global_ceiling"]);
  });
});

describe("reachability", () => {
  test("a blocked person gets no proactive message, and an older replayed follow doesn't unblock them", async () => {
    const model = scripted([chat("Hi!"), chat("Welcome back!")]);
    const c = await devChat("ned", { model, at: "2099-11-04T10:00" });
    await c.say("hi");
    await c.received();

    await c.say("/block", { at: local("2099-11-04T11:00") });
    await c.say("/follow", { at: local("2099-11-04T10:30") });
    expect((await c.snapshot()).agent?.status).toBe("blocked");

    await c.advanceTo("2099-11-05T12:00");
    expect(await c.received()).toEqual([]);
    expect(model.calls).toHaveLength(1);
    expect(c.logs("turn").map((l) => [l.eventKind, l.outcome])).toEqual([
      ["message", "acted"],
      ["lifecycle", "no_model"],
      ["lifecycle", "stale"],
    ]);

    await c.say("/follow");
    expect(await c.received()).toEqual(["Welcome back!"]);
    const after = await c.snapshot();
    expect(after.agent?.status).toBe("active");
    expect(after.pendingWakeups.map((w) => [w.kind, w.dueAt])).toEqual([["checkin", local("2099-11-06T09:00")]]);
    model.assertDone();
  });
});
