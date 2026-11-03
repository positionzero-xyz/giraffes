import { describe, expect, test } from "vitest";
import { NOTICE } from "../src/agent/turn";
import type { EpochMs } from "../src/domain";
import { priceOf, routeOf } from "../src/model/model";
import { costOf, SPEND } from "../src/policy/spend";
import { type ScriptStep } from "../src/model/scripted";
import { cancel, chat, devChat, hold, local, memoryLedger, quiet, schedule, scripted, send, throws, turn, wall } from "./testkit";

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
  test("a reminder or cancel that code rejects is corrected in the same message, and why is logged", async () => {
    const model = scripted([
      turn({
        actions: [schedule("dentist", "tomorrow at 9", "Dentist at 9"), cancel("gym"), send("Done! Dentist reminder set, gym one cancelled.")],
        task: ["reminder", "dentist", "started"],
      }),
    ]);
    const c = await devChat("zed", { model, at: "2099-11-04T10:00" });

    await c.say("remind me about the dentist tomorrow at 9, and cancel the gym reminder");

    expect(await c.received()).toEqual([
      [
        "Done! Dentist reminder set, gym one cancelled.",
        "(I couldn't read that time, so I didn't set the reminder.)\n(I couldn't find that reminder, so nothing was cancelled.)",
      ].join("\n"),
    ]);
    expect((await c.snapshot()).pendingWakeups.filter((w) => w.kind === "reminder")).toEqual([]);
    expect(c.logs("rejection").map((l) => [l.action, l.reason])).toEqual([
      ["schedule_wakeup:dentist", "bad_time"],
      ["cancel_wakeup:gym", "not_pending"],
    ]);
  });

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

  test("a reminder for the current or next minute is accepted, and one already reached fires at once", async () => {
    const model = scripted([
      turn({ actions: [schedule("stretch", "2099-11-04T14:01", "Stretch"), schedule("water", "2099-11-04T14:00", "Drink water"), send("OK.")], task: ["reminder", "breaks", "started"] }),
      chat("Drink some water."),
      chat("Time to stretch."),
    ]);
    const c = await devChat("abe", { model, at: "2099-11-04T14:00" });
    c.clock.set((local("2099-11-04T14:00") + 10_000) as EpochMs);

    await c.say("remind me now to drink water, and at 14:01 to stretch");
    await c.advanceTo("2099-11-04T14:05");

    expect(c.channel.delivered.map((d) => [d.text, wall(d.at)])).toEqual([
      ["OK.", "2099-11-04T14:00"],
      ["Drink some water.", "2099-11-04T14:00"],
      ["Time to stretch.", "2099-11-04T14:01"],
    ]);
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

describe("requested reminders without a model", () => {
  const setClinic = (usage?: { inputTokens: number }) =>
    turn({ actions: [schedule("clinic", "2099-11-04T18:00", "call the clinic"), send("Done.")], task: ["reminder", "clinic", "started"], usage });
  const unavailable: ScriptStep = { kind: "fail", failure: "unavailable" };

  test.each([
    ["the model's output is invalid", "wes", [{ kind: "fail", failure: "invalid_output" }]],
    ["the model refuses", "wim", [{ kind: "fail", failure: "refused_by_model" }]],
    ["the model call crashes three times", "wyn", [throws(), throws(), throws()]],
    ["the model is unavailable for minutes", "wyatt", Array.from({ length: 5 }, () => unavailable)],
  ] satisfies [string, string, ScriptStep[]][])("a reminder still arrives, written by code, when %s", async (_, user, atFiring) => {
    const model = scripted([setClinic(), ...atFiring]);
    const c = await devChat(user, { model, at: "2099-11-04T10:00" });
    await c.say("remind me at 6pm to call the clinic");
    await c.received();

    await c.advanceTo("2099-11-04T18:30");

    expect(await c.received()).toEqual(["Reminder: call the clinic"]);
    expect((await c.snapshot()).outbox.at(-1)?.intent).toBe("requested");
    model.assertDone();
  });

  test("a reminder still arrives, written by code, when the person is over their monthly cap", async () => {
    const inputThatSpendsTheCap = (SPEND.userCapMicro * 1_000_000) / priceOf(routeOf("turn").model).inputPerM;
    const model = scripted([setClinic({ inputTokens: inputThatSpendsTheCap })]);
    const c = await devChat("xia", { model, at: "2099-11-04T10:00" });
    await c.say("remind me at 6pm to call the clinic");
    await c.received();

    await c.advanceTo("2099-11-04T18:00");

    expect(c.channel.delivered.map((d) => [d.text, wall(d.at)])).toEqual([
      ["Done.", "2099-11-04T10:00"],
      ["Reminder: call the clinic", "2099-11-04T18:00"],
    ]);
  });

  test("the model gets minutes, not seconds, to come back before the code-written reminder", async () => {
    const model = scripted([setClinic(), unavailable, unavailable, unavailable, chat("Time to call the clinic!")]);
    const c = await devChat("yan", { model, at: "2099-11-04T10:00" });
    await c.say("remind me at 6pm to call the clinic");
    await c.received();

    await c.advanceTo("2099-11-04T18:30");

    expect(c.channel.delivered.slice(1).map((d) => [d.text, wall(d.at)])).toEqual([["Time to call the clinic!", "2099-11-04T18:03"]]);
    model.assertDone();
  });
});

describe("failure and duplicate safety", () => {
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

  test("a model call that throws re-runs the turn once, applies it once, and charges the failed call at its estimate", async () => {
    const model = scripted([throws(), chat("hi")]);
    const c = await devChat("jon", { model, at: "2099-11-04T10:00" });

    await c.say("hello");

    expect(await c.received()).toEqual(["hi"]);
    expect(c.logs("model_call").map((l) => l.status)).toEqual(["in_doubt", "settled"]);
    expect(c.logs("turn").map((l) => [l.outcome, l.attempts])).toEqual([["acted", 2]]);
    expect((await c.snapshot()).turns.map((t) => [t.role, t.text])).toEqual([
      ["person", "hello"],
      ["agent", "hi"],
    ]);
  });

  test("an event whose model call throws three times is poisoned with a fixed apology", async () => {
    const model = scripted([throws(), throws(), throws()]);
    const c = await devChat("kim", { model, at: "2099-11-04T10:00" });

    await c.say("hello");

    expect(await c.received()).toEqual([NOTICE.failed]);
    expect(c.logs("turn").map((l) => l.outcome)).toEqual(["poison"]);
    expect(c.logs("model_call").map((l) => l.status)).toEqual(["in_doubt", "in_doubt", "in_doubt"]);
    model.assertDone();
  });
});

describe("delivery", () => {
  test("an unasked message admitted at 21:59 whose send fails waits for 08:00 on retry", async () => {
    const model = scripted([
      turn({ actions: [schedule("bins", "2099-11-04T21:59", "Ask about the bins", false), send("OK.")], task: ["chat", "bins", "started"] }),
      chat("Did the bins go out?"),
    ]);
    const c = await devChat("uma", { model, at: "2099-11-04T21:00", deliveries: [{ kind: "sent" }, { kind: "retry", afterMs: 120_000 }] });
    await c.say("I need to take the bins out later");

    await c.advanceTo("2099-11-05T08:30");

    expect(c.channel.delivered.map((d) => [d.text, wall(d.at)])).toEqual([
      ["OK.", "2099-11-04T21:00"],
      ["Did the bins go out?", "2099-11-05T08:00"],
    ]);
    expect(c.logs("unasked").map((l) => [l.status, l.day])).toEqual([["sent", "2099-11-04"]]);
    model.assertDone();
  });

  test.each([
    ["the channel can't tell whether it was delivered", { kind: "in_doubt", afterMs: 1000 } as const],
    ["the send was cut off by a crash", { kind: "throw" } as const],
  ])("a reply that may already have reached the person goes out by push, never with its token again: %s", async (_, step) => {
    const model = scripted([chat("Hi!")]);
    const c = await devChat(`vic-${step.kind}`, { model, at: "2099-11-04T10:00", deliveries: [step] });

    await c.say("hello");
    await c.advanceTo("2099-11-04T10:01");

    expect(c.channel.delivered.map((d) => [d.text, d.via])).toEqual([["Hi!", "push"]]);
  });
});

describe("spend", () => {
  test("a Thai message's reservation covers the worst-case bill: every prompt byte a cache-write token, plus full output", async () => {
    const model = scripted([chat("สวัสดีค่ะ")]);
    const c = await devChat("ray", { model, at: "2099-11-04T10:00" });

    await c.say("ช่วยเตือนฉันพรุ่งนี้ตอนเก้าโมงให้โทรหาคลินิกทันตกรรมเพื่อเลื่อนนัดหน่อยนะคะ ".repeat(40));

    const [call] = model.calls;
    const bytes = new TextEncoder().encode(call.system + call.user).length;
    const route = routeOf("turn");
    const worst = costOf(route.model, { inputTokens: 0, outputTokens: route.maxTokens, cacheWriteTokens: bytes, cacheReadTokens: 0 });
    expect(c.logs("model_call")[0].estimateMicro).toBeGreaterThanOrEqual(worst);
  });

  test("a model call that times out is charged at its estimate, not $0, and the turn is retried", async () => {
    const model = scripted([{ kind: "fail", failure: "in_doubt" }, chat("Here now.")]);
    const c = await devChat("sam", { model, at: "2099-11-04T10:00" });

    await c.say("hello");
    await c.advanceTo("2099-11-04T10:01");

    expect(await c.received()).toEqual(["Here now."]);
    const calls = c.logs("model_call");
    expect(calls.map((l) => l.status)).toEqual(["in_doubt", "settled"]);
    expect(calls[0].costMicro).toBe(calls[0].estimateMicro);
    expect((await c.snapshot()).spendThisMonthMicro).toBe(calls[0].estimateMicro + calls[1].costMicro);
  });

  test("an over-cap person is refused without a model call, told once a day, and logged", async () => {
    const inputThatSpendsTheCap = (SPEND.userCapMicro * 1_000_000) / priceOf(routeOf("turn").model).inputPerM;
    const model = scripted([turn({ actions: [send("Here's a long answer.")], task: ["chat", "x", "none"], usage: { inputTokens: inputThatSpendsTheCap } })]);
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

  test("a blocked person who writes again is answered, and their check-ins resume", async () => {
    const model = scripted([chat("Hi!"), chat("Welcome back!")]);
    const c = await devChat("pat", { model, at: "2099-11-04T10:00" });
    await c.say("hi");
    await c.received();
    await c.say("/block", { at: local("2099-11-04T11:00") });
    await c.advanceTo("2099-11-05T12:00");

    await c.say("are you still there?");

    expect(await c.received()).toEqual(["Welcome back!"]);
    const after = await c.snapshot();
    expect(after.agent?.status).toBe("active");
    expect(after.pendingWakeups.map((w) => [w.kind, wall(w.dueAt)])).toEqual([["checkin", "2099-11-06T09:00"]]);
    model.assertDone();
  });

  test("a failed send doesn't make a follow stamped earlier in the same second look stale", async () => {
    const model = scripted([chat("Hi!"), chat("Welcome back!")]);
    const c = await devChat("rho", { model, at: "2099-11-04T10:00", deliveries: [{ kind: "gone" }] });
    const second = local("2099-11-04T10:00");
    c.clock.set((second + 500) as EpochMs);

    await c.say("hi", { at: second });
    expect((await c.snapshot()).agent?.status).toBe("blocked");
    await c.say("/follow", { at: second });

    expect(await c.received()).toEqual(["Welcome back!"]);
    expect((await c.snapshot()).agent?.status).toBe("active");
    model.assertDone();
  });
});

describe("housekeeping", () => {
  test("a compaction call that always throws is retried only after a backoff, while turns are answered and logs ship", async () => {
    const replies = Array.from({ length: 33 }, (_, i) => chat(`Reply ${i}.`));
    const model = scripted(replies, { compaction: [throws(), throws()] });
    const c = await devChat("oli", { model, at: "2099-11-04T10:00" });
    const compactions = () => model.calls.filter((call) => call.purpose === "compaction").length;
    for (let i = 0; i < 30; i++) await c.say(`message ${i}`);
    expect(compactions()).toBe(0);

    await c.post("message 30");
    for (let i = 0; i < 5; i++) await c.alarm();

    expect(compactions()).toBe(1);
    await c.settle();
    expect((await c.received()).at(-1)).toBe("Reply 30.");
    expect(c.logs("turn")).toHaveLength(31);
    const calls = c.logs("model_call");
    expect(calls.filter((l) => l.purpose === "compaction").map((l) => l.status)).toEqual(["in_doubt"]);
    expect((await c.snapshot()).spendThisMonthMicro).toBe(calls.reduce((sum, l) => sum + l.costMicro, 0));

    c.clock.set(local("2099-11-04T10:01"));
    await c.say("message 31");
    expect(compactions()).toBe(1);

    c.clock.set(local("2099-11-04T10:06"));
    await c.say("message 32");
    expect(compactions()).toBe(2);
    expect(await c.received()).toEqual(["Reply 31.", "Reply 32."]);
    model.assertDone();
  });
});

describe("compaction", () => {
  const foldedTurns = (user: string) => user.match(/^\[\d{4}-\d\d-\d\dT\d\d:\d\dZ\] (Person|Assistant|Note):/gm)?.length ?? 0;
  const summary = (text: string): ScriptStep => ({ kind: "output", value: { summary: text } });

  test("a backlog left by failed compactions is folded in bounded pages, oldest first", async () => {
    const replies = Array.from({ length: 72 }, (_, i) => chat(`Reply ${i}.`));
    const model = scripted(replies, { compaction: [{ kind: "fail", failure: "invalid_output" }, summary("Summary 1."), summary("Summary 2."), summary("Summary 3.")] });
    const c = await devChat("pia", { model, at: "2099-11-04T10:00" });
    for (let i = 0; i < 71; i++) await c.say(`message ${i}`);

    c.clock.set(local("2099-11-04T10:06"));
    await c.say("message 71");

    const pages = model.calls.filter((call) => call.purpose === "compaction").slice(1);
    expect(pages.map((p) => foldedTurns(p.user))).toEqual([30, 30, 30]);
    expect(pages[0].user).toContain("Person: message 0\n");
    expect(pages[1].user).toContain("Current summary:\nSummary 1.");
    expect(pages[1].user).toContain("Person: message 15\n");
    expect(pages[2].user).toContain("Person: message 30\n");
    model.assertDone();
  });

  test("while compaction is backing off, a turn's prompt carries at most the newest 50 notes", async () => {
    const facts = (from: number) => Array.from({ length: 6 }, (_, i) => ({ type: "remember", note: `fact ${from + i}` }));
    const replies = Array.from({ length: 11 }, (_, i) => turn({ actions: facts(i * 6), task: ["chat", "facts", "none"] }));
    const model = scripted(replies, { compaction: [throws()] });
    const c = await devChat("quinn", { model, at: "2099-11-04T10:00" });
    for (let i = 0; i < 11; i++) await c.say(`fact batch ${i}`);

    const last = model.calls.filter((call) => call.purpose === "turn").at(-1)!.user;
    const notes = last.match(/^- fact \d+$/gm) ?? [];
    expect(notes).toHaveLength(50);
    expect(notes.at(-1)).toBe("- fact 59");
    model.assertDone();
  });
});
