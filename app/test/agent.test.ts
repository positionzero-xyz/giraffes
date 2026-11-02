/**
 * Behavior tests for the agent loop. Each names the property the design promises (see RATIONALE.md,
 * "Failure cases"). Sketch: the bodies show the shape; they run once the sketch is filled in.
 */
import { describe, expect, test } from "vitest";
import { devChat, quiet, schedule, scripted, send, turn } from "./testkit";

describe("reminders", () => {
  test("a reminder set at 21:30 for 23:00 is held until 08:00 and says it is late", async () => {
    const model = scripted([
      turn({ actions: [schedule("bins", "2026-11-04T23:00", "Take the bins out"), send("Will do.")], task: ["reminder", "bins", "started"] }),
      turn({ actions: [send("Take the bins out!")], lateNotice: "Sorry, this was due at 23:00 last night.", task: ["reminder", "bins", "completed"] }),
    ]);
    const chat = await devChat("alice", { model, at: "2026-11-04T21:30", tz: "Asia/Bangkok" });

    await chat.say("remind me at 11pm to take the bins out");
    expect(await chat.received()).toEqual([
      "Will do.\n(I don't send messages between 22:00 and 08:00, so this reminder will come at 08:00.)",
    ]);

    await chat.advanceTo("2026-11-05T08:00");
    expect(await chat.received()).toEqual(["Sorry, this was due at 23:00 last night.\nTake the bins out!"]);
    expect(chat.logs("turn").map((l) => l.taskStatus)).toEqual(["started", "completed"]);
  });

  test("scheduling a key that is already pending is dropped, not doubled", async () => {
    const model = scripted([
      turn({ actions: [schedule("dentist", "2026-11-06T09:00", "Dentist"), send("Set.")], task: ["reminder", "dentist", "started"] }),
      turn({ actions: [schedule("dentist", "2026-11-06T09:00", "Dentist"), send("Already set.")], task: ["reminder", "dentist", "progressed"] }),
    ]);
    const chat = await devChat("bob", { model, at: "2026-11-04T10:00" });
    await chat.say("remind me friday 9 about the dentist");
    await chat.say("did you set it?");
    expect((await chat.snapshot()).pendingWakeups.filter((w) => w.key === "dentist")).toHaveLength(1);
  });
});

describe("budget", () => {
  test("the fourth unasked message of a local day is dropped and logged", async () => {
    // four reminders at 10:00, 11:00, 12:00, 13:00; each fires and sends
    // expect received() to have 3 unasked texts and logs("unasked") to have one dropped_budget row
  });
});

describe("crash and duplicate safety", () => {
  test("a redelivered webhook is processed once", async () => {
    // POST the same { id } twice → one model call (model.assertDone with one step), one reply
  });

  test("a crash during the model call re-runs the turn and applies it once", async () => {
    const model = scripted([
      turn({ actions: [send("hi")], task: ["chat", "hello", "none"] }), // consumed by the crashed attempt
      turn({ actions: [send("hi")], task: ["chat", "hello", "none"] }),
    ]);
    const chat = await devChat("carol", { model, at: "2026-11-04T10:00" });
    await chat.crashDuringNextModelCall();
    await chat.say("hello");
    expect(await chat.received()).toEqual(["hi"]);
    // spend: one model_call row recovered_after_crash at estimate, one settled
    expect(chat.logs("model_call").map((l) => l.status).sort()).toEqual(["recovered_after_crash", "settled"]);
  });

  test("running the alarm twice fires a wake-up once", async () => {
    // schedule at 10:05; advanceTo 10:05; call runDurableObjectAlarm again → one wake turn, one delivery
  });

  test("a message that arrives during a model call is answered in the next turn", async () => {
    // "hold" step on the first call; send a second message while held; release
    // expect two turns, the second's prompt (model.calls[1].user) contains the second message
    void quiet;
  });
});
