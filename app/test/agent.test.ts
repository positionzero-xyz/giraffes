import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { AGENT_SYSTEM } from "../src/agent/prompt";
import { MIGRATIONS, migrate } from "../src/agent/schema";
import { AgentStore } from "../src/agent/store";
import { TURN } from "../src/agent/turn";
import type { ChannelAdapter, ChannelRegistry } from "../src/channels/channel";
import { lineChannel } from "../src/channels/line";
import { telegramChannel } from "../src/channels/telegram";
import { eventKey, type EpochMs, type LocalDateTime, type TimeZone } from "../src/domain";
import { DEV_CAP_MICRO } from "../src/access/access";
import { HAIKU_5_5 } from "../src/model/providers";
import { routeFor } from "../src/model/routes";
import type { ScriptStep } from "../src/model/scripted";
import { NOTICES } from "../src/notices";
import { costOf } from "../src/policy/spend";
import { fromLocal, toLocal } from "../src/policy/time";
import type { Env } from "../src/config";
import worker from "../src/worker";
import { cancel, chat, devChat, hold, local, memoryLedger, postTelegramUpdate, quiet, rewindForgetCommandSchema, routine, schedule, scripted, send, throws, turn, wall } from "./testkit";

const NOTICE = NOTICES.en;
const inputThatSpendsTheCap = (DEV_CAP_MICRO * 1_000_000) / HAIKU_5_5.inputPerM;

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

  test("a reply quote reaches the model as context, not as the person's new words", async () => {
    const model = scripted([chat("Moved it to 5.")]);
    const c = await devChat("quote-telegram", { model, at: "2099-11-04T10:00", channel: "telegram" });

    await c.event({ kind: "message", text: "move this to 5", quote: { kind: "text", text: "I'll remind you at 4.", at: local("2099-11-04T09:59") } });

    expect(model.calls[0].user).toContain('Person: move this to 5\nEarlier message being replied to (context, not a request): "I\'ll remind you at 4."');
    expect(model.calls[0].system).toContain("text marked as an earlier message being replied to");
    model.assertDone();
  });

  test("an edited message reaches the model marked as a correction", async () => {
    const model = scripted([chat("Changed to 5.")]);
    const c = await devChat("edit-telegram", { model, at: "2099-11-04T10:00", channel: "telegram" });

    await c.event({ kind: "message", text: "actually, make it 5", edited: true });

    expect(model.calls[0].user).toContain("Person edited their earlier message. Corrected text: actually, make it 5");
    model.assertDone();
  });

  test("an edited command word still reaches the model as a correction", async () => {
    const model = scripted([chat("What would you like me to forget?")]);
    const c = await devChat("edit-command", { model, at: "2099-11-04T10:00", channel: "telegram" });

    await c.event({ kind: "message", text: "/forget", edited: true });

    expect(model.calls[0].user).toContain("Person edited their earlier message. Corrected text: /forget");
    model.assertDone();
  });

  test("a LINE quote id resolves to the matching sent message before the turn", async () => {
    const model = scripted([chat("I'll remind you at 4."), chat("Moved it to 5.")]);
    const c = await devChat("quote-line", {
      model,
      at: "2099-11-04T10:00",
      channel: "line",
      deliveries: [{ kind: "sent", providerMessages: [{ id: "461230966842064897", position: 0 }] }],
    });

    await c.say("remind me at 4");
    expect(await c.received()).toEqual(["I'll remind you at 4."]);
    await c.event({ kind: "message", text: "move this to 5", quote: { kind: "reference", id: "461230966842064897" } });

    expect(model.calls[1].user).toContain('Person: move this to 5\nEarlier message being replied to (context, not a request): "I\'ll remind you at 4."');
    model.assertDone();
  });

  test("an unknown LINE quote id reaches the turn with no quoted text", async () => {
    const model = scripted([chat("I need a little more context.")]);
    const c = await devChat("quote-line-unknown", { model, at: "2099-11-04T10:00", channel: "line" });

    await c.event({ kind: "message", text: "move this to 5", quote: { kind: "reference", id: "461230966842064897" } });

    expect(model.calls[0].user).toContain("Person: move this to 5");
    expect(model.calls[0].user).not.toContain("Earlier message being replied to");
    model.assertDone();
  });
});

describe("working on it", () => {
  test.each(["telegram", "line"] as const)("on %s, the person sees a reply being made until it is sent, refreshed for a long turn", async (channel) => {
    const model = scripted([hold(chat("Here's your day."))]);
    const c = await devChat("ida", { model, at: "2099-11-04T10:00", channel });

    await c.post("what's on today?");
    await until(() => c.channel.shown.length >= 3);
    expect(await c.received()).toEqual([]);
    model.release();
    await c.settle();
    const shownByReply = c.channel.shown.length;
    await new Promise((r) => setTimeout(r, 50));

    expect(await c.received()).toEqual(["Here's your day."]);
    expect(c.channel.shown.length).toBe(shownByReply);
    expect(new Set(c.channel.shown.map((to) => `${to.channel}:${to.channelUserId}`))).toEqual(new Set([`${channel}:ida`]));
    model.assertDone();
  });

  test("a check-in nobody asked for shows nothing", async () => {
    const model = scripted([chat("Hi!"), chat("Morning! Anything on today?")]);
    const c = await devChat("jon", { model, at: "2099-11-04T10:00", channel: "telegram" });
    await c.say("hi");
    const shownByReply = c.channel.shown.length;
    expect(shownByReply).toBeGreaterThan(0);

    await c.advanceTo("2099-11-05T12:00");

    expect(await c.received()).toEqual(["Hi!", "Morning! Anything on today?"]);
    expect(c.channel.shown.length).toBe(shownByReply);
    model.assertDone();
  });
});

describe("reminders", () => {
  test("a reminder or cancel that code rejects is corrected in the same message, and why is logged", async () => {
    const model = scripted([
      turn({
        actions: [schedule("dentist", "tomorrow at 9", "Dentist at 9"), cancel("gym"), send("Done! Dentist reminder set, gym one cancelled.")],
      }),
    ]);
    const c = await devChat("zed", { model, at: "2099-11-04T10:00" });

    await c.say("remind me about the dentist tomorrow at 9, and cancel the gym reminder");

    expect(await c.received()).toEqual([
      [
        "Done! Dentist reminder set, gym one cancelled.",
        "(I couldn't find that reminder, so nothing was cancelled.)\n(I couldn't read that time, so I didn't set the reminder.)",
      ].join("\n"),
    ]);
    expect((await c.snapshot()).pendingWakeups.filter((w) => w.kind === "reminder")).toEqual([]);
    expect(c.logs("rejection").map((l) => l.reason)).toEqual([
      "not_pending",
      "bad_time",
    ]);
  });

  test("a move whose new time code rejects keeps the original reminder, and the person is told", async () => {
    const model = scripted([
      turn({ actions: [schedule("dentist", "2099-11-05T09:00", "Dentist"), send("Set for 9.")] }),
      turn({ actions: [schedule("dentist", "tomorrow at 10", "Dentist"), cancel("dentist"), send("Moved to 10!")] }),
    ]);
    const c = await devChat("mo", { model, at: "2099-11-04T10:00" });
    await c.say("remind me about the dentist tomorrow at 9");
    await c.received();

    await c.say("actually make it 10");

    expect(await c.received()).toEqual([
      ["Moved to 10!", NOTICE.reminderBadTime, "(Your reminder is still set for 2099-11-05 09:00.)"].join("\n"),
    ]);
    const reminders = (await c.snapshot()).pendingWakeups.filter((w) => w.kind === "reminder");
    expect(reminders.map((w) => [w.key, wall(w.dueAt)])).toEqual([["dentist", "2099-11-05T09:00"]]);
  });

  test("a move that frees a slot for a new reminder still leaves at most 20 pending", async () => {
    const five = (from: number) =>
      turn({
        actions: [...Array.from({ length: 5 }, (_, i) => schedule(`r${from + i}`, "2099-11-06T09:00", `Reminder ${from + i}`)), send("Set.")],
      });
    const model = scripted([
      five(0),
      five(5),
      five(10),
      five(15),
      turn({
        actions: [cancel("r0"), schedule("rent", "2099-11-07T09:00", "Pay rent"), schedule("r0", "2099-11-08T09:00", "Reminder 0"), send("Moved it and added rent.")],
      }),
    ]);
    const c = await devChat("ida", { model, at: "2099-11-04T10:00" });
    for (let i = 0; i < 4; i++) await c.say(`set five more (${i})`);
    await c.received();

    await c.say("move r0 to the 8th and remind me to pay rent on the 7th");

    const reminders = (await c.snapshot()).pendingWakeups.filter((w) => w.kind === "reminder");
    expect(reminders).toHaveLength(20);
    expect(reminders.find((w) => w.key === "r0")?.dueAt).toBe(local("2099-11-08T09:00"));
    expect(await c.received()).toEqual([["Moved it and added rent.", NOTICE.reminderLimit].join("\n")]);
    expect(c.logs("rejection").map((l) => l.reason)).toEqual(["limit"]);
    model.assertDone();
  });

  test("a send past the length cap is cut to fit and logged, and the reminder in the same answer is set", async () => {
    const model = scripted([
      turn({ actions: [schedule("call-mom", "2099-11-04T18:00", "Call mom"), send("x".repeat(TURN.maxTextChars + 1))] }),
    ]);
    const c = await devChat("kyo", { model, at: "2099-11-04T10:00" });

    await c.say("remind me at 6pm to call mom, and tell me all about Kyoto");

    expect((await c.received()).map((t) => t.length)).toEqual([TURN.maxTextChars]);
    expect((await c.snapshot()).pendingWakeups.filter((w) => w.kind === "reminder").map((w) => w.key)).toEqual(["call-mom"]);
    expect(c.logs("rejection").map((l) => l.reason)).toEqual(["too_long"]);
    model.assertDone();
  });

  test("'remind me at 18:00' fires through the alarm and is delivered", async () => {
    const model = scripted([
      turn({ actions: [schedule("call-clinic", "2099-11-04T18:00", "Remind: call the clinic"), send("Done.")] }),
      turn({ actions: [send("Time to call the clinic.")] }),
    ]);
    const c = await devChat("cat", { model, at: "2099-11-04T10:00" });

    await c.say("remind me at 6pm to call the clinic");
    expect(await c.received()).toEqual(["Done."]);

    await c.advanceTo("2099-11-04T17:59");
    expect(await c.received()).toEqual([]);

    await c.advanceTo("2099-11-04T18:00");
    expect(await c.received()).toEqual(["Time to call the clinic."]);
    expect(model.calls[1].user).toContain('Your wake-up "call-clinic" fired: Remind: call the clinic.');
    model.assertDone();
  });

  test("a reminder for the current or next minute is accepted, and one already reached fires at once", async () => {
    const model = scripted([
      turn({ actions: [schedule("stretch", "2099-11-04T14:01", "Stretch"), schedule("water", "2099-11-04T14:00", "Drink water"), send("OK.")] }),
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
      turn({ actions: [schedule("bins", "2099-11-04T23:00", "Take the bins out"), send("Will do.")] }),
      turn({ actions: [send("Take the bins out!")] }),
    ]);
    const c = await devChat("dan", { model, at: "2099-11-04T21:30" });

    await c.say("remind me at 11pm to take the bins out");
    expect(await c.received()).toEqual(["Will do."]);

    await c.advanceTo("2099-11-04T23:00");
    expect(await c.received()).toEqual(["Take the bins out!"]);
    expect((await c.snapshot()).unaskedSentToday).toBe(0);
    expect(c.logs("unasked")).toEqual([]);
  });

  test("the agent's own wake-up can't re-arm itself for the minute it fires in", async () => {
    const again = turn({ actions: [schedule("check", "2099-11-04T10:01", "Check again", false)] });
    const model = scripted([
      turn({ actions: [schedule("check", "2099-11-04T10:01", "Check the thing", false), send("OK.")] }),
      again,
    ]);
    const c = await devChat("lou", { model, at: "2099-11-04T10:00" });
    await c.say("keep an eye on it");

    await c.advanceTo("2099-11-04T10:05");

    expect(model.calls).toHaveLength(2);
    expect(c.logs("rejection").map((l) => l.reason)).toEqual(["past"]);
    model.assertDone();
  });

  test("the agent's own wake-up at 23:00 waits for 08:00 and says it is late", async () => {
    const model = scripted([
      turn({ actions: [schedule("bins", "2099-11-04T23:00", "Ask about the bins", false), send("OK.")] }),
      turn({ actions: [send("Did the bins go out?")], lateNotice: "Sorry, this was due at 23:00 last night." }),
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
      turn({ actions: [quiet()] }),
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
      turn({ actions: [own("a", "2099-11-04T11:00"), own("b", "2099-11-04T12:00"), own("c", "2099-11-04T13:00"), own("d", "2099-11-04T14:00"), send("Noted.")] }),
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
    expect(c.logs("unasked").map((l) => l.status)).toEqual([
      "sent",
      "sent",
      "sent",
      "dropped_budget",
    ]);
  });
});

describe("routines", () => {
  const reminders = async (c: Awaited<ReturnType<typeof devChat>>) =>
    (await c.snapshot()).pendingWakeups.filter((w) => w.kind === "reminder").map((w) => [w.key, wall(w.dueAt), w.kind === "reminder" ? w.repeat : null]);
  const fireEarly = async (c: Awaited<ReturnType<typeof devChat>>, user: string, key: string) => {
    const res = await SELF.fetch("https://agent.test/dev/fire", {
      method: "POST",
      body: JSON.stringify({ user, key }),
    });
    expect(res.status).toBe(200);
    await c.settle();
  };

  test("a daily routine fires at its time every day, and code schedules each next one", async () => {
    const model = scripted([
      turn({ actions: [routine("stretch", "2099-11-04T08:00", "Remind: stretch", "daily"), send("Every day at 8.")] }),
      chat("Stretch time."),
      turn({ actions: [quiet()] }),
      chat("Stretch again."),
    ]);
    const c = await devChat("rut", { model, at: "2099-11-04T07:00" });

    await c.say("every morning at 8 remind me to stretch");
    await c.advanceTo("2099-11-04T08:00");
    expect(await c.received()).toEqual(["Every day at 8.", "Stretch time."]);
    expect(await reminders(c)).toEqual([["stretch", "2099-11-05T08:00", { every: "daily", anchor: "2099-11-04T08:00" }]]);
    expect(model.calls[1].user).toContain("It repeats daily at 08:00, and the next one is already scheduled.");
    expect(model.calls[1].user).toMatch(/- stretch · .+ · repeats daily · Remind: stretch/);

    await c.advanceTo("2099-11-05T08:00");
    expect(await c.received()).toEqual(["Stretch again."]);
    expect(c.channel.delivered.slice(1).map((d) => wall(d.at))).toEqual(["2099-11-04T08:00", "2099-11-05T08:00"]);
    model.assertDone();
  });

  test("an asked routine stops at six for 24 hours, logs the drop, and lets a one-off through", async () => {
    const model = scripted([
      turn({ actions: [
        routine("stretch", "2099-11-04T22:30", "Stretch", "daily"),
        schedule("pills", "2099-11-04T23:00", "Take your pills"),
      ] }),
      ...Array.from({ length: 7 }, () => chat("Stretch time.")),
      chat("Take your pills."),
      chat("Stretch time."),
      chat("Stretch time."),
      turn({ actions: [quiet()] }),
      chat("Stretch time."),
    ]);
    const user = "routine-limit";
    const c = await devChat(user, { model, at: "2099-11-04T22:29" });

    await c.say("Remind me to stretch every day, and to take my pills tonight.");
    await c.advanceTo("2099-11-04T22:30");
    for (let i = 0; i < 5; i++) await fireEarly(c, user, "stretch");
    expect(await c.received()).toEqual(Array.from({ length: 6 }, () => "Stretch time."));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await fireEarly(c, user, "stretch");
      expect(warn).toHaveBeenCalledWith({ code: "routine_delivery_budget" });
    } finally {
      warn.mockRestore();
    }
    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).outbox.filter((o) => o.status === "dropped")).toHaveLength(1);
    expect((await reminders(c)).find(([key]) => key === "stretch")?.[1]).toBe("2099-11-05T22:30");

    await c.advanceTo("2099-11-04T23:00");
    expect(await c.received()).toEqual(["Take your pills."]);
    await c.advanceTo("2099-11-05T00:01");
    await fireEarly(c, user, "stretch");
    expect(await c.received()).toEqual([]);

    const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
    await runInDurableObject(stub, async (agent) => {
      const { op } = await agent.beginForget({ at: c.clock.now(), seq: null });
      await agent.endForget(op);
    });
    await c.advanceTo("2099-11-05T00:03");
    await fireEarly(c, user, "stretch");
    expect(await c.received()).toEqual([]);

    await c.advanceTo("2099-11-05T22:30");
    expect(await c.received()).toEqual(["Stretch time."]);
    model.assertDone();
  });

  test("unasked and asked routines share the same rolling allowance", async () => {
    const routines = Array.from({ length: 7 }, (_, i) => ({
      ...routine(`routine-${i}`, "2099-11-04T11:00", `Routine ${i}`, "daily"), asked: i >= 2 && i < 6,
    }));
    const model = scripted([
      turn({ actions: routines.slice(0, 4) }),
      turn({ actions: routines.slice(4) }),
      ...Array.from({ length: 7 }, (_, i) => chat(`Routine ${i}`)),
    ]);
    const c = await devChat("routine-mixed", { model, at: "2099-11-04T10:00" });

    await c.say("Set up my first routines.");
    await c.say("Set up the rest of my routines.");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await c.advanceTo("2099-11-04T11:00");
      expect(warn).toHaveBeenCalledWith({ code: "routine_delivery_budget" });
    } finally {
      warn.mockRestore();
    }

    expect(await c.received()).toEqual(Array.from({ length: 6 }, (_, i) => `Routine ${i}`));
    expect((await c.snapshot()).outbox.filter((o) => o.status === "dropped")).toHaveLength(1);
    expect(c.logs("unasked").map((row) => row.status)).toEqual(["sent", "sent", "dropped_budget"]);
    expect(await reminders(c)).toHaveLength(7);
    model.assertDone();
  });

  test.each([
    { kind: "in_doubt", afterMs: 60_000 },
    { kind: "throw" },
  ] as const)("a routine retry after $kind still needs room in the rolling allowance", async (step) => {
    const model = scripted([
      turn({ actions: Array.from({ length: 6 }, (_, i) => routine(`routine-${i}`, "2099-11-04T11:00", `Routine ${i}`, "daily")) }),
      ...Array.from({ length: 6 }, (_, i) => chat(`Routine ${i}`)),
    ]);
    const c = await devChat(`routine-${step.kind}`, {
      model,
      at: "2099-11-04T10:00",
      deliveries: [step],
    });

    await c.say("Set up my routines.");
    await c.advanceTo("2099-11-04T11:01");
    expect(await c.received()).toHaveLength(5);
    expect((await c.snapshot()).outbox.filter((o) => o.status === "dropped")).toHaveLength(1);
    expect(await reminders(c)).toHaveLength(6);
    model.assertDone();
  });

  test.each(["line", "telegram"] as const)("%s routines recover all six sends after six refused requests", async (channel) => {
    const texts = Array.from({ length: 6 }, (_, i) => `Routine ${i}`);
    const model = scripted([
      turn({ actions: texts.map((text, i) => routine(`r-${i}`, i < 2 ? "2099-11-04T10:00" : "2099-11-04T18:00", text, "daily")) }),
      ...texts.map(chat),
    ]);
    const c = await devChat("routine-outage", { model, at: "2099-11-04T09:30", channel });
    await c.say("Set up my routines.");
    const adapter = channel === "line"
      ? lineChannel({ channelSecret: "test", accessToken: "test" })
      : telegramChannel({ botToken: "123:abc", webhookSecret: "test" });
    const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
    await runInDurableObject(stub, (agent) => agent.withDeps({
      channels: { line: c.channel, telegram: c.channel, dev: c.channel, [channel]: { receive: adapter.receive, deliver: adapter.deliver } },
    }));
    let requests = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      requests++;
      return requests <= 6 ? Response.json({}, { status: requests % 2 === 0 ? 503 : 429 }) : Response.json({});
    });
    try {
      await c.advanceTo("2099-11-04T20:00");
      const outbox = (await c.snapshot()).outbox;
      expect(outbox.map((row) => [row.texts[0], row.status])).toEqual(texts.map((text) => [text, "sent"]));
      expect(requests).toBe(12);
      model.assertDone();
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("westward time-zone changes leave no extra room for routines", async () => {
    const user = "routine-zone-change";
    const stretches = (count: number) => Array.from({ length: count }, () => chat("Stretch time."));
    const model = scripted([
      turn({ actions: [routine("stretch", "2099-11-04T00:10", "Stretch", "daily")] }),
      ...stretches(6),
      turn({ actions: [{ type: "set_locale", timeZone: "Asia/Dhaka", language: "en" }] }),
      ...stretches(6),
      turn({ actions: [{ type: "set_locale", timeZone: "Asia/Karachi", language: "en" }] }),
      ...stretches(6),
    ]);
    const c = await devChat(user, { model, at: "2099-11-04T00:05" });
    await c.say("Remind me to stretch every day.");
    await c.advanceTo("2099-11-04T00:10");
    for (let i = 0; i < 5; i++) await fireEarly(c, user, "stretch");
    expect(await c.received()).toHaveLength(6);

    for (const [at, city] of [["2099-11-04T01:15", "Dhaka"], ["2099-11-04T02:20", "Karachi"]]) {
      await c.advanceTo(at);
      await c.say(`I live in ${city} now.`);
      for (let i = 0; i < 6; i++) await fireEarly(c, user, "stretch");
    }
    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).agent?.tz).toBe("Asia/Karachi");
    expect((await c.snapshot()).outbox.filter((o) => o.status === "dropped")).toHaveLength(12);
    model.assertDone();
  });

  test("the first capped release counts recent sent and uncertain routines from the old outbox", async () => {
    const user = "routine-upgrade";
    const model = scripted([
      turn({ actions: [routine("stretch", "2099-11-04T11:00", "Stretch", "daily"), schedule("once", "2099-11-04T11:30", "One-off")] }),
      chat("Stretch time."),
      chat("Stretch time."),
      chat("Maybe delivered."),
      chat("One-off."),
      ...Array.from({ length: 4 }, () => chat("Stretch time.")),
    ]);
    const c = await devChat(user, {
      model,
      at: "2099-11-04T10:00",
      deliveries: [{ kind: "sent" }, { kind: "sent" }, { kind: "in_doubt", afterMs: 60 * 60_000 }],
    });
    await c.say("Remind me to stretch daily, and once at 11:30.");
    await c.advanceTo("2099-11-04T11:00");
    await fireEarly(c, user, "stretch");
    await fireEarly(c, user, "stretch");
    await c.advanceTo("2099-11-04T11:30");
    expect(await c.received()).toEqual(["Stretch time.", "Stretch time.", "One-off."]);

    const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
    await runInDurableObject(stub, (_agent, { storage }) => {
      storage.sql.exec("DROP TABLE routine_delivery");
      rewindForgetCommandSchema(storage.sql);
      const routineCap = MIGRATIONS.findIndex((migration) => migration.includes("CREATE TABLE routine_delivery"));
      storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'schema_version'", String(routineCap));
      migrate(storage);
    });
    for (let i = 0; i < 4; i++) await fireEarly(c, user, "stretch");
    expect(await c.received()).toEqual(["Stretch time.", "Stretch time.", "Stretch time."]);
    expect((await c.snapshot()).outbox.filter((o) => o.status === "dropped")).toHaveLength(1);
    model.assertDone();
  });

  test("a weekday routine that fires on Friday comes back on Monday", async () => {
    const model = scripted([turn({ actions: [routine("standup", "2099-11-06T09:00", "Ask for today's top task", "weekdays"), send("Weekdays at 9.")] }), chat("Top task today?")]);
    const c = await devChat("wkd", { model, at: "2099-11-06T08:00" });

    await c.say("every weekday at 9 ask me for my top task");
    await c.advanceTo("2099-11-06T09:00");

    expect(await reminders(c)).toEqual([["standup", "2099-11-09T09:00", { every: "weekdays", anchor: "2099-11-06T09:00" }]]);
    model.assertDone();
  });

  test("a weekly routine comes back on the same weekday", async () => {
    const model = scripted([turn({ actions: [routine("plan-week", "2099-11-08T19:00", "Plan the week", "weekly"), send("Sundays at 7pm.")] }), chat("Let's plan the week.")]);
    const c = await devChat("wkl", { model, at: "2099-11-04T10:00" });

    await c.say("every Sunday at 7pm help me plan the week");
    await c.advanceTo("2099-11-08T19:00");

    expect(await reminders(c)).toEqual([["plan-week", "2099-11-15T19:00", { every: "weekly", anchor: "2099-11-08T19:00" }]]);
    model.assertDone();
  });

  test("cancelling a routine stops every later one", async () => {
    const model = scripted([
      turn({ actions: [routine("water", "2099-11-04T08:00", "Drink water", "daily"), send("Daily at 8.")] }),
      chat("Water!"),
      turn({ actions: [cancel("water"), send("Stopped.")] }),
    ]);
    const c = await devChat("cnr", { model, at: "2099-11-04T07:00" });

    await c.say("every day at 8 remind me to drink water");
    await c.advanceTo("2099-11-04T08:00");
    await c.say("stop the water reminders");
    await c.advanceTo("2099-11-06T09:00");

    expect(await c.received()).toEqual(["Daily at 8.", "Water!", "Stopped."]);
    expect(await reminders(c)).toEqual([]);
    model.assertDone();
  });

  test("/dev/fire makes a pending wake-up due now, and it goes out through the alarm without a message", async () => {
    const model = scripted([turn({ actions: [schedule("call-clinic", "2099-11-13T09:00", "Call the clinic"), send("Friday at 9.")] }), chat("Time to call the clinic.")]);
    const c = await devChat("ffw", { model, at: "2099-11-06T11:45" });

    await c.say("remind me Friday 9 am to call the clinic");
    const res = await SELF.fetch("https://agent.test/dev/fire", { method: "POST", body: JSON.stringify({ user: "ffw", key: "call-clinic" }) });
    expect(res.status).toBe(200);
    await c.settle();

    expect(await c.received()).toEqual(["Friday at 9.", "Time to call the clinic."]);
    expect(c.channel.delivered[1]).toMatchObject({ via: "push" });
    expect(await reminders(c)).toEqual([]);
    expect((await SELF.fetch("https://agent.test/dev/fire", { method: "POST", body: JSON.stringify({ user: "ffw", key: "nothing" }) })).status).toBe(404);
    model.assertDone();
  });
});

describe("requested reminders without a model", () => {
  const setClinic = (usage?: { inputTokens: number }) =>
    turn({ actions: [schedule("clinic", "2099-11-04T18:00", "call the clinic"), send("Done.")], usage });
  const unavailable: ScriptStep = { kind: "fail", failure: "unavailable" };

  test.each([
    ["the model's output is invalid", "wes", [{ kind: "fail", failure: "invalid_output" }]],
    ["the model refuses", "wim", [{ kind: "fail", failure: "refused_by_model" }]],
    ["the model call crashes three times", "wyn", [throws(), throws(), throws()]],
    ["the model is unavailable for minutes", "wyatt", Array.from({ length: 5 }, () => unavailable)],
    ["the model answers with quiet", "wren", [turn({ actions: [quiet()] })]],
    ["the model answers with only a note", "wade", [turn({ actions: [{ type: "remember", note: "Calls the clinic" }] })]],
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

describe("order across retries", () => {
  const unavailable: ScriptStep = { kind: "fail", failure: "unavailable" };

  test("a message sent while an earlier one waits out a model outage is answered after it, in one turn that sees both", async () => {
    const model = scripted([unavailable, turn({ actions: [send("OK, no reminder then.")] })]);
    const c = await devChat("ola", { model, at: "2099-11-04T10:00" });

    await c.say("remind me at 6pm to call the clinic");
    c.clock.set((local("2099-11-04T10:00") + 5_000) as EpochMs);
    await c.say("actually, cancel that");
    expect(model.calls).toHaveLength(1);

    await c.advanceTo("2099-11-04T10:05");

    expect(await c.received()).toEqual(["OK, no reminder then."]);
    expect(model.calls[1].user).toContain("## New\nPerson: remind me at 6pm to call the clinic\nPerson: actually, cancel that");
    model.assertDone();
  });

  test("a cancel that waits out a model outage still stops the reminder that falls due meanwhile", async () => {
    const model = scripted([
      turn({ actions: [schedule("clinic", "2099-11-04T18:00", "call the clinic"), send("Done.")] }),
      unavailable,
      turn({ actions: [cancel("clinic"), send("Cancelled.")] }),
    ]);
    const c = await devChat("oto", { model, at: "2099-11-04T10:00" });
    await c.say("remind me at 6pm to call the clinic");
    await c.received();

    c.clock.set((local("2099-11-04T17:59") + 50_000) as EpochMs);
    await c.say("cancel the clinic reminder");
    await c.advanceTo("2099-11-04T18:30");

    expect(await c.received()).toEqual(["Cancelled."]);
    expect((await c.snapshot()).pendingWakeups.filter((w) => w.kind === "reminder")).toEqual([]);
    expect(c.logs("rejection")).toEqual([]);
    model.assertDone();
  });
});

describe("time zone and language", () => {
  const LONDON = "Europe/London" as TimeZone;
  const london = (s: string) => fromLocal(s as LocalDateTime, LONDON);
  const locale = (timeZone: string, language: string) => ({ type: "set_locale", timeZone, language });

  test("a person in London gets the check-in at 09:00, quiet hours and reminders on London time", async () => {
    const model = scripted([
      turn({ actions: [schedule("dentist", "2099-11-05T15:00", "Dentist"), send("Set for 3pm.")] }),
      turn({
        actions: [locale("Europe/London", "en"), schedule("follow-up", "2099-11-04T23:00", "Ask about the flat", false), send("Got it, London time.")],
      }),
      chat("Morning!"),
      turn({ actions: [send("Did you hear back about the flat?")], lateNotice: "This was due last night." }),
      chat("Morning again!"),
    ]);
    const c = await devChat("lyn", { model, at: "2099-11-04T10:00" });
    await c.say("remind me about the dentist tomorrow at 3pm");

    await c.say("by the way, I live in London");

    const after = await c.snapshot();
    expect(after.agent?.tz).toBe("Europe/London");
    expect(after.pendingWakeups.map((w) => [w.key, toLocal(w.dueAt, LONDON)])).toEqual([
      ["daily-checkin", "2099-11-04T09:00"],
      ["follow-up", "2099-11-04T23:00"],
      ["dentist", "2099-11-05T15:00"],
    ]);

    await c.advanceTo(toLocal(london("2099-11-05T09:30"), "Asia/Bangkok" as TimeZone));

    expect(c.channel.delivered.map((d) => [d.text, toLocal(d.at, LONDON)])).toEqual([
      ["Set for 3pm.", "2099-11-04T03:00"],
      ["Got it, London time.", "2099-11-04T03:00"],
      ["Morning!", "2099-11-04T09:00"],
      ["This was due last night.\nDid you hear back about the flat?", "2099-11-05T08:00"],
      ["Morning again!", "2099-11-05T09:00"],
    ]);
    expect(model.calls.at(-1)?.user).toContain("Europe/London");
    model.assertDone();
  });

  test("in the turn that changes the zone, the model is told Now still shows the old zone's time and not to state the time", async () => {
    const model = scripted([turn({ actions: [locale("Europe/London", "en"), send("Welcome to London!")] })]);
    const c = await devChat("noa", { model, at: "2099-11-04T21:40" });

    await c.say("I just moved to London");

    const call = model.calls.at(-1);
    expect(call?.user).toContain("2099-11-04 21:40 (Wednesday), Asia/Bangkok");
    for (const system of [call?.system, AGENT_SYSTEM]) {
      expect(system).toMatch(/set_locale[^\n]*the time under Now is still in the old zone, so don't tell the person the time in that turn/);
    }
    expect((await c.snapshot()).agent?.tz).toBe("Europe/London");
  });

  test("a time zone code can't read is rejected, logged and corrected, and the zone stays", async () => {
    const model = scripted([turn({ actions: [locale("Mars/Olympus", "en"), send("Switched to Mars time.")] })]);
    const c = await devChat("mae", { model, at: "2099-11-04T10:00" });

    await c.say("I live on Mars now");

    expect(await c.received()).toEqual(["Switched to Mars time.\n(I couldn't find that time zone, so I kept the one you had.)"]);
    expect(c.logs("rejection").map((l) => l.reason)).toEqual(["bad_zone"]);
    expect((await c.snapshot()).agent?.tz).toBe("Asia/Bangkok");
  });

  test("a person who asks for Thai gets code-written corrections in Thai from that turn on", async () => {
    const model = scripted([
      turn({ actions: [locale("Asia/Bangkok", "th"), schedule("dentist", "tomorrow at 9", "Dentist"), send("ตั้งให้แล้วค่ะ")] }),
    ]);
    const c = await devChat("pim", { model, at: "2099-11-04T10:00" });

    await c.say("คุยภาษาไทยนะ แล้วเตือนไปหาหมอฟันพรุ่งนี้เก้าโมง");

    expect(await c.received()).toEqual(["ตั้งให้แล้วค่ะ\n(อ่านเวลานั้นไม่ออก เลยยังไม่ได้ตั้งเตือนให้ค่ะ)"]);
  });

  test("a LINE person's fixed notices are in Thai from the first message", async () => {
    const model = scripted([throws(), throws(), throws()]);
    const c = await devChat("U0123456789abcdef0123456789abcdef", { model, at: "2099-11-04T10:00", channel: "line" });

    await c.say("สวัสดี");

    expect(await c.received()).toEqual(["ขอโทษค่ะ ตอนนี้ยังตอบข้อความนั้นไม่ได้ ช่วยส่งมาใหม่อีกครั้งได้ไหมคะ"]);
    model.assertDone();
  });

  async function telegramMessage(chatId: number, updateId: number, text: string, languageCode: unknown) {
    const body = {
      update_id: updateId,
      message: {
        date: Date.UTC(2099, 10, 4, 3) / 1000,
        chat: { id: chatId, type: "private" },
        from: { id: chatId, is_bot: false, first_name: "Pim", language_code: languageCode },
        text,
      },
    };
    const response = await postTelegramUpdate(body);
    expect(response.status).toBe(200);
  }

  test.each([
    { text: "/start", code: "th", notice: /^ต้องมี AI/ },
    { text: "สวัสดี", code: "TH-th", notice: /^ต้องมี AI/ },
    { text: "/key", code: "th", notice: /^ใส่ API key/ },
    { text: "/key", code: "en-US", notice: /^Add your API key/ },
    { text: "/key", code: "ja", notice: /^Add your API key/ },
    { text: "/key", code: undefined, notice: /^Add your API key/ },
    { text: "/key", code: 123, notice: /^Add your API key/ },
  ])("a new Telegram person's $text notice uses their $code language before a model call", async ({ text, code, notice }) => {
    const c = await devChat("777000111", { model: null, at: "2099-11-04T10:00", channel: "telegram" });

    await telegramMessage(777000111, 1, text, code);
    await c.settle();

    expect(await c.received()).toEqual([expect.stringMatching(notice)]);
    expect(c.logs("model_call")).toEqual([]);
  });

  test.each([
    { code: "th", notice: /^ต้องมี AI/ },
    { code: "en", notice: /^I need an AI/ },
  ])("a new Telegram person's first member update uses their $code language before a model call", async ({ code, notice }) => {
    const c = await devChat("777000111", { model: null, at: "2099-11-04T10:00", channel: "telegram" });

    const response = await postTelegramUpdate({
      update_id: 1,
      my_chat_member: {
        date: Date.UTC(2099, 10, 4, 3) / 1000,
        chat: { id: 777000111, type: "private" },
        from: { id: 777000111, is_bot: false, first_name: "Pim", language_code: code },
        new_chat_member: { status: "member" },
      },
    });
    expect(response.status).toBe(200);
    await c.settle();

    expect(await c.received()).toEqual([expect.stringMatching(notice)]);
    expect(c.logs("model_call")).toEqual([]);
  });

  test.each([
    { code: "th", notice: NOTICES.th.noKey },
    { code: "en", notice: NOTICES.en.noKey },
  ])("a new Telegram person's first button tap uses their $code language before a model call", async ({ code, notice }) => {
    const c = await devChat("777000111", { model: null, at: "2099-11-04T10:00", channel: "telegram" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true, result: true }));
    try {
      const response = await postTelegramUpdate({
        update_id: 1,
        callback_query: {
          id: "cb1",
          from: { id: 777000111, is_bot: false, first_name: "Pim", language_code: code },
          message: { message_id: 9, date: Date.UTC(2099, 10, 4, 3) / 1000, chat: { id: 777000111, type: "private" } },
          data: "b",
        },
      });
      expect(response.status).toBe(200);
      await c.settle();

      expect(await c.received()).toEqual([notice]);
      expect(c.logs("model_call")).toEqual([]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test("Telegram's language hint does not replace the language set during a conversation", async () => {
    const model = scripted([turn({ actions: [locale("Asia/Bangkok", "en"), send("English from now on.")] })]);
    const c = await devChat("777000111", { model, at: "2099-11-04T10:00", channel: "telegram" });

    await telegramMessage(777000111, 1, "คุยภาษาอังกฤษนะ", "th");
    await c.settle();
    expect(await c.received()).toEqual(["English from now on."]);

    await telegramMessage(777000111, 2, "/key", "th");
    await c.settle();
    expect(await c.received()).toEqual([expect.stringMatching(/^Add your API key/)]);
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
      turn({ actions: [schedule("stretch", "2099-11-04T10:05", "Stretch"), send("Sure.")] }),
      turn({ actions: [send("Time to stretch.")] }),
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
      turn({ actions: [schedule("bins", "2099-11-04T21:59", "Ask about the bins", false), send("OK.")] }),
      chat("Did the bins go out?"),
    ]);
    const c = await devChat("uma", { model, at: "2099-11-04T21:00", deliveries: [{ kind: "sent" }, { kind: "retry", afterMs: 120_000 }] });
    await c.say("I need to take the bins out later");

    await c.advanceTo("2099-11-05T08:30");

    expect(c.channel.delivered.map((d) => [d.text, wall(d.at)])).toEqual([
      ["OK.", "2099-11-04T21:00"],
      ["Did the bins go out?", "2099-11-05T08:00"],
    ]);
    expect(c.logs("unasked").map((l) => [l.status, l.day])).toEqual([["sent", "2099-11-05"]]);
    model.assertDone();
  });

  test("an unasked message a retry carries into the next day counts against that day's budget", async () => {
    const own = (key: string, at: string) => schedule(key, at, `Follow up ${key}`, false);
    const model = scripted([
      turn({
        actions: [own("a", "2099-11-04T21:59"), own("b", "2099-11-05T08:10"), own("c", "2099-11-05T08:20"), own("d", "2099-11-05T08:30"), send("Noted.")],
      }),
      chat("Update a."),
      chat("Update b."),
      chat("Update c."),
      chat("Update d."),
    ]);
    const c = await devChat("una", { model, at: "2099-11-04T21:00", deliveries: [{ kind: "sent" }, { kind: "retry", afterMs: 120_000 }] });
    await c.say("plan my trip");

    await c.advanceTo("2099-11-05T08:45");

    expect(c.channel.delivered.map((d) => [d.text, wall(d.at)])).toEqual([
      ["Noted.", "2099-11-04T21:00"],
      ["Update a.", "2099-11-05T08:00"],
      ["Update b.", "2099-11-05T08:10"],
      ["Update c.", "2099-11-05T08:20"],
    ]);
    expect(c.logs("unasked").map((l) => [l.status, l.day])).toEqual([
      ["sent", "2099-11-05"],
      ["sent", "2099-11-05"],
      ["sent", "2099-11-05"],
      ["dropped_budget", null],
    ]);
    expect((await c.snapshot()).unaskedSentToday).toBe(3);
    model.assertDone();
  });

  test("at the LINE reserve, unasked messages are dropped and logged, while replies and requested reminders still go", async () => {
    const model = scripted([
      turn({
        actions: [schedule("nudge", "2099-11-04T11:00", "Ask about the trip", false), schedule("pills", "2099-11-04T11:30", "Take your pills"), send("OK.")],
      }),
      chat("How is the trip planning going?"),
      chat("Time for your pills."),
    ]);
    const ledger = memoryLedger();
    ledger.lineQuotaReading = { at: local("2099-11-04T09:00"), month: "2099-11", limit: 1000, used: 950 };
    const c = await devChat("U00000000000000000000000000000001", { model, at: "2099-11-04T10:00", ledger, channel: "line" });

    await c.say("remind me at 11:30 to take my pills");
    await c.advanceTo("2099-11-04T12:00");

    expect(await c.received()).toEqual(["OK.", "Time for your pills."]);
    expect(c.logs("unasked").map((l) => l.status)).toEqual(["dropped_quota"]);
    model.assertDone();
  });

  test("a reading from last month doesn't hold back this month's unasked messages", async () => {
    const model = scripted([
      turn({ actions: [schedule("nudge", "2099-11-01T11:00", "Ask about the trip", false), send("OK.")] }),
      chat("How is the trip planning going?"),
    ]);
    const ledger = memoryLedger();
    ledger.lineQuotaReading = { at: local("2099-10-31T23:00"), month: "2099-10", limit: 1000, used: 990 };
    const c = await devChat("U00000000000000000000000000000002", { model, at: "2099-11-01T10:00", ledger, channel: "line" });

    await c.say("I'm planning a trip");
    await c.advanceTo("2099-11-01T12:00");

    expect(await c.received()).toEqual(["OK.", "How is the trip planning going?"]);
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

  test.each([
    { channel: "line", user: "U00000000000000000000000000000003", key: (n: number) => eventKey.line(`timeout-${n}`) },
    { channel: "telegram", user: "777000111", key: (n: number) => eventKey.telegram(900000 + n) },
  ] as const)("a hung $channel send ends within its time limit and the next queued message goes out", async ({ channel, user, key }) => {
    const model = scripted([chat("Hi!")]);
    const c = await devChat(user, { model, at: "2099-11-04T10:00", channel });
    await c.say("hello");
    expect(await c.received()).toEqual(["Hi!"]);

    const timeoutMs = 30;
    const real = channel === "line"
      ? lineChannel({ channelSecret: "line-channel-secret-for-tests", accessToken: "line-access-token" }, undefined, timeoutMs)
      : telegramChannel({ botToken: "123:abc", webhookSecret: "tg-webhook-secret" }, timeoutMs);
    const kinds: string[] = [];
    const sent: string[] = [];
    const adapter: ChannelAdapter = {
      receive: (req) => real.receive(req),
      async deliver(msg, now, live) {
        const delivery = await real.deliver(msg, now, live);
        kinds.push(delivery.kind);
        if (delivery.kind === "sent") sent.push(msg.texts.join("\n"));
        return delivery;
      },
    };
    const channels: ChannelRegistry = channel === "line"
      ? { line: adapter, telegram: c.channel, dev: c.channel }
      : { line: c.channel, telegram: adapter, dev: c.channel };
    const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
    await runInDurableObject(stub, (agent) => agent.withDeps({ channels }));

    const first = `${channel} first`;
    const second = `${channel} second`;
    await runInDurableObject(stub, (_agent, state) => {
      const store = new AgentStore(state.storage);
      const at = c.clock.now();
      store.notifyOnce(`${channel}-timeout-one`, key(1), { texts: [first], note: first }, at);
      store.notifyOnce(`${channel}-timeout-two`, key(2), { texts: [second], note: second }, at);
    });

    const requests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      requests.push(String(input));
      if (requests.length > 1) return Promise.resolve(Response.json({}));
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    try {
      await c.settle();

      expect(kinds).toEqual(["retry", "sent"]);
      expect(sent).toEqual([second]);
      expect(requests).toHaveLength(2);
      const rows = (await c.snapshot()).outbox.filter((row) => row.texts[0] === first || row.texts[0] === second);
      expect(rows.map((row) => [row.texts[0], row.status])).toEqual([
        [first, "pending"],
        [second, "sent"],
      ]);
      model.assertDone();
    } finally {
      fetchMock.mockRestore();
    }
  }, 2_000);
});

describe("spend", () => {
  test("a Thai message's reservation covers the worst-case bill: every prompt byte a cache-write token, plus full output", async () => {
    const model = scripted([chat("สวัสดีค่ะ")]);
    const c = await devChat("ray", { model, at: "2099-11-04T10:00" });

    await c.say("ช่วยเตือนฉันพรุ่งนี้ตอนเก้าโมงให้โทรหาคลินิกทันตกรรมเพื่อเลื่อนนัดหน่อยนะคะ ".repeat(40));

    const [call] = model.calls;
    const bytes = new TextEncoder().encode(call.system + call.user).length;
    const route = routeFor({ kind: "dev", model: "claude-haiku-5-5" }, "turn");
    const worst = costOf(route, { inputTokens: 0, outputTokens: route.maxTokens, cacheWriteTokens: bytes, cacheReadTokens: 0 }, null);
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

  test("a request the API rejected is charged nothing, retried after a backoff, then answered with the fixed apology", async () => {
    const rejected: ScriptStep = { kind: "fail", failure: "rejected" };
    const model = scripted([rejected, rejected, rejected]);
    const c = await devChat("rex", { model, at: "2099-11-04T10:00" });

    await c.say("hello");
    await c.advanceTo("2099-11-04T10:05");

    expect(await c.received()).toEqual([NOTICE.failed]);
    expect(c.logs("model_call").map((l) => [l.status, l.costMicro])).toEqual([
      ["rejected", 0],
      ["rejected", 0],
      ["rejected", 0],
    ]);
    expect((await c.snapshot()).spendThisMonthMicro).toBe(0);
    model.assertDone();
  });

  test("an over-cap person is refused without a model call, told once a day, and logged", async () => {
    const model = scripted([turn({ actions: [send("Here's a long answer.")], usage: { inputTokens: inputThatSpendsTheCap } })]);
    const c = await devChat("lea", { model, at: "2099-11-04T10:00" });
    await c.say("tell me everything");
    await c.received();

    await c.say("are you there?");
    await c.say("hello?");

    expect(await c.received()).toEqual([NOTICE.includedCapReached]);
    expect(model.calls).toHaveLength(1);
    expect(c.logs("turn").map((l) => [l.outcome, l.refusedForBudget])).toEqual([
      ["acted", false],
      ["refused_budget", true],
      ["refused_budget", true],
    ]);
    expect(c.logs("model_call").map((l) => l.status)).toEqual(["settled", "refused_user_cap", "refused_user_cap"]);
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

  test("a Telegram edit after a block does not resume delivery until a new message", async () => {
    const user = 10509;
    const model = scripted([chat("Hi!"), chat("Edited."), chat("Welcome back!")]);
    const c = await devChat(String(user), { model, at: "2099-11-04T10:00", channel: "telegram" });
    const originalDate = c.clock.now() / 1000;
    const privateChat = { id: user, type: "private" };
    await c.say("Hi");
    expect(await c.received()).toEqual(["Hi!"]);

    await c.advanceTo("2099-11-04T10:01");
    expect((await postTelegramUpdate({
      update_id: 10_509,
      my_chat_member: { date: c.clock.now() / 1000, chat: privateChat, new_chat_member: { status: "kicked" } },
    })).status).toBe(200);
    await c.settle();
    expect((await c.snapshot()).agent?.status).toBe("blocked");

    await c.advanceTo("2099-11-04T10:02");
    expect((await postTelegramUpdate({
      update_id: 10_510,
      edited_message: { chat: privateChat, date: originalDate, edit_date: c.clock.now() / 1000, text: "Hello!" },
    })).status).toBe(200);
    await c.settle();
    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).agent?.status).toBe("blocked");

    expect((await postTelegramUpdate({
      update_id: 10_511,
      message: { chat: privateChat, date: c.clock.now() / 1000, text: "Are you there?" },
    })).status).toBe(200);
    await c.settle();
    expect(await c.received()).toEqual(["Welcome back!"]);
    expect((await c.snapshot()).agent?.status).toBe("active");
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

  test("a failed compaction on an otherwise idle agent is retried at its backoff time, with no new message", async () => {
    const replies = Array.from({ length: 31 }, (_, i) => chat(`Reply ${i}.`));
    const model = scripted(replies, { compaction: [{ kind: "fail", failure: "invalid_output" }, { kind: "output", value: { summary: "Summary." } }] });
    const c = await devChat("cyd", { model, at: "2099-11-04T10:00" });
    for (let i = 0; i < 31; i++) await c.say(`message ${i}`);

    await c.advanceTo("2099-11-04T12:00");

    const compactions = c.logs("model_call").filter((l) => l.purpose === "compaction");
    expect(compactions.map((l) => wall(l.at))).toEqual(["2099-11-04T10:00", "2099-11-04T10:05"]);
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
    expect(pages[1].user).toContain("## Current summary\nSummary 1.");
    expect(pages[1].user).toContain("Person: message 15\n");
    expect(pages[2].user).toContain("Person: message 30\n");
    model.assertDone();
  });

  test("every earlier message is either folded into the summary or shown in the next turn's prompt", async () => {
    const replies = Array.from({ length: 45 }, (_, i) => chat(`Reply ${i}.`));
    const model = scripted(replies, { compaction: [summary("Summary 1.")] });
    const c = await devChat("noa", { model, at: "2099-11-04T10:00" });

    for (let i = 0; i < 45; i++) {
      await c.say(`message ${i}`);
      const folded = model.calls.filter((call) => call.purpose === "compaction").map((call) => call.user).join("\n");
      const prompt = model.calls.filter((call) => call.purpose === "turn").at(-1)!.user;
      for (let j = 0; j < i; j++) {
        const line = `Person: message ${j}\n`;
        expect(folded.includes(line) || prompt.includes(line), `message ${j} in the prompt of turn ${i}`).toBe(true);
      }
    }
    expect(model.calls.filter((call) => call.purpose === "compaction")).toHaveLength(1);
    model.assertDone();
  });

  test("while compaction is backing off, a turn's prompt carries at most the newest 50 notes", async () => {
    const facts = (from: number) => Array.from({ length: 6 }, (_, i) => ({ type: "remember", note: `fact ${from + i}` }));
    const replies = Array.from({ length: 11 }, (_, i) => turn({ actions: facts(i * 6) }));
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

describe("dev runs", () => {
  test("without DEV_MODE every dev route answers 404, even for a wake-up that exists", async () => {
    const model = scripted([turn({ actions: [schedule("call-clinic", "2099-11-13T09:00", "Call the clinic"), send("Friday at 9.")] })]);
    const c = await devChat("lok", { model, at: "2099-11-06T11:45" });
    await c.say("remind me Friday 9 am to call the clinic");
    const live = { ...env, MODEL_BACKEND: "", DEV_MODE: "" } as Env;
    const post = (path: string, body: unknown) => worker.fetch(new Request(`https://agent.test${path}`, { method: "POST", body: JSON.stringify(body) }), live);

    expect((await post("/dev/fire", { user: "lok", key: "call-clinic" })).status).toBe(404);
    expect((await post("/dev/script", { user: "lok", turns: [] })).status).toBe(404);
    expect((await post("/dev/remove", { agent: c.agent })).status).toBe(404);
    expect((await post("/webhook/dev", { user: "lok", text: "hi", id: "x1" })).status).toBe(404);
    for (const path of ["/dev", "/dev/transcript?user=lok"]) expect((await worker.fetch(new Request(`https://agent.test${path}`), live)).status).toBe(404);
    expect((await c.snapshot()).pendingWakeups.map((w) => w.key)).toContain("call-clinic");
  });

  test("a scripted dev run answers from the outputs posted to /dev/script", async () => {
    const output = { actions: [{ type: "send", text: "Scripted hello." }], tasks: [], about: "" };
    expect((await SELF.fetch("https://agent.test/dev/script", { method: "POST", body: JSON.stringify({ user: "sia", turns: [output] }) })).status).toBe(200);

    await SELF.fetch("https://agent.test/webhook/dev", { method: "POST", body: JSON.stringify({ user: "sia", text: "hello", id: "sia-1" }) });

    const snapshot = async () => (await SELF.fetch("https://agent.test/dev/transcript?user=sia")).json<{ outbox: { texts: string[]; status: string }[] }>();
    let outbox = (await snapshot()).outbox;
    for (let i = 0; i < 100 && outbox[0]?.status !== "sent"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      outbox = (await snapshot()).outbox;
    }
    expect(outbox).toEqual([expect.objectContaining({ texts: ["Scripted hello."], status: "sent" })]);
  });
});

describe("legacy data over the reminder cap", () => {
  test("a turn that adds reminders to 21 already pending commits, refusing the fresh ones, and is not poisoned", async () => {
    const model = scripted([chat("Hi."), turn({ actions: [schedule("one-more", "2099-11-04T20:00", "x"), schedule("and-another", "2099-11-04T21:00", "y"), send("Done.")] })]);
    const c = await devChat("cap21", { model, at: "2099-11-04T10:00" });
    await c.say("hi first");
    await c.received();
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_a, state) => {
      for (let i = 0; i < 21; i++) {
        state.storage.sql.exec(
          "INSERT INTO wakeup (key, kind, origin, note, due_at, created_at, created_by, bookkeeping) VALUES (?, 'reminder', 'person', 'old', ?, ?, 'test', 0)",
          `old-${i}`,
          local("2099-11-10T10:00"),
          local("2099-11-04T10:00"),
        );
      }
    });

    await c.say("remind me twice");

    expect(await c.received()).toEqual([`Done.\n${NOTICES.en.reminderLimit}`]);
    expect((await c.snapshot()).pendingWakeups.filter((w) => w.kind === "reminder")).toHaveLength(21);
    expect(c.logs("turn").map((l) => l.outcome)).toEqual(["acted", "acted"]);
  });
});
