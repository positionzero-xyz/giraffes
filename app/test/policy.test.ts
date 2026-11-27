import { describe, expect, expectTypeOf, test } from "vitest";
import { COMPACTION, CompactionOutputSchema, planCompaction } from "../src/agent/compaction";
import { COMPACTION_SYSTEM, TURN_SYSTEM } from "../src/agent/prompt";
import { TASKS } from "../src/agent/tasks";
import { AGENT_TOOLS, planTurn, planWithoutModel, TURN, TurnOutputSchema, type Batch, type InboxItem, type TurnOutput, type TurnView } from "../src/agent/turn";
import {
  CHECKIN_KEY,
  TASK_KINDS,
  eventKey,
  intentOf,
  type AgentEvent,
  type EpochMs,
  type LocalDate,
  type LocalDateTime,
  type MicroUsd,
  type TimeZone,
  type WakeupId,
  type WakeupKey,
} from "../src/domain";
import { bytesOf, renderPrompt } from "../src/model/prompt";
import { HAIKU_5_5 } from "../src/model/providers";
import { OUTPUT_TOKENS, PROMPT_OVERHEAD_TOKENS, routeFor } from "../src/model/routes";
import { NOTICES } from "../src/notices";
import { admitUnasked, quietUntil } from "../src/policy/outreach";
import { fireAt, isLate, nextAlarm, nextOccurrence, planFiring, wakeupOrigin, type PendingWakeup } from "../src/policy/schedule";
import { costOf, estimate, fits } from "../src/policy/spend";
import { fromLocal, nextLocalTime, parseLocalDateTime, parseTimeZone, toLocal } from "../src/policy/time";

const NOTICE = NOTICES.en;
const BKK = parseTimeZone("Asia/Bangkok")!;
const NYC = parseTimeZone("America/New_York")!;
const at = (iso: string) => Date.parse(iso) as EpochMs;
const usd = (n: number) => Math.round(n * 1e6) as MicroUsd;
const local = (s: string, tz: TimeZone = BKK) => fromLocal(s as LocalDateTime, tz);

describe("zone math", () => {
  test("model times must be real calendar minutes", () => {
    expect(parseLocalDateTime("2026-11-04T23:00")).toBe("2026-11-04T23:00");
    expect(parseLocalDateTime("2026-02-30T09:00")).toBeNull();
    expect(parseLocalDateTime("2026-11-04T24:00")).toBeNull();
    expect(parseLocalDateTime("2026-11-04 09:00")).toBeNull();
    expect(parseTimeZone("Mars/Olympus")).toBeNull();
  });

  test("a wall time skipped by spring-forward resolves to the first minute after the gap", () => {
    expect(fromLocal("2027-03-14T02:30" as LocalDateTime, NYC)).toBe(at("2027-03-14T07:00Z"));
    expect(toLocal(at("2027-03-14T07:00Z"), NYC)).toBe("2027-03-14T03:00");
  });

  test("a wall time repeated by fall-back resolves to the earlier instant", () => {
    expect(fromLocal("2026-11-01T01:30" as LocalDateTime, NYC)).toBe(at("2026-11-01T05:30Z"));
  });

  test("the next 09:00 across a DST change is 25 hours away, not 24", () => {
    expect(nextLocalTime(at("2026-10-31T13:00Z"), NYC, "09:00")).toBe(at("2026-11-01T14:00Z"));
  });
});

describe("quiet hours", () => {
  test("Bangkok: 21:59 is open, 22:00 is quiet until 08:00, 08:00 is open", () => {
    expect(quietUntil(at("2026-11-04T21:59+07:00"), BKK)).toBeNull();
    expect(quietUntil(at("2026-11-04T22:00+07:00"), BKK)).toBe(at("2026-11-05T08:00+07:00"));
    expect(quietUntil(at("2026-11-05T07:59+07:00"), BKK)).toBe(at("2026-11-05T08:00+07:00"));
    expect(quietUntil(at("2026-11-05T08:00+07:00"), BKK)).toBeNull();
  });

  test("New York: the night clocks fall back ends at 08:00 standard time", () => {
    expect(quietUntil(at("2026-10-31T23:00-04:00"), NYC)).toBe(at("2026-11-01T08:00-05:00"));
    expect(quietUntil(at("2026-11-01T07:30-05:00"), NYC)).toBe(at("2026-11-01T08:00-05:00"));
    expect(quietUntil(at("2026-11-01T08:00-05:00"), NYC)).toBeNull();
  });

  test("New York: the night clocks spring forward ends at 08:00 daylight time", () => {
    expect(quietUntil(at("2027-03-13T22:30-05:00"), NYC)).toBe(at("2027-03-14T08:00-04:00"));
    expect(quietUntil(at("2027-03-14T07:59-04:00"), NYC)).toBe(at("2027-03-14T08:00-04:00"));
    expect(quietUntil(at("2027-03-14T21:59-04:00"), NYC)).toBeNull();
  });
});

describe("unasked budget", () => {
  const input = { tz: BKK, admittedDay: null, dailyBudget: 3, status: "active" as const, inQuotaReserve: false };

  test("the first three of a local day are sent, charged to the local date", () => {
    expect(admitUnasked({ ...input, now: at("2026-11-04T15:00+07:00"), sentToday: 2 })).toEqual({ verdict: "send", day: "2026-11-04" });
    expect(admitUnasked({ ...input, tz: NYC, now: at("2026-11-05T01:00Z"), sentToday: 0 })).toEqual({ verdict: "send", day: "2026-11-04" });
  });

  test("the fourth of the local day is dropped", () => {
    expect(admitUnasked({ ...input, now: at("2026-11-04T15:00+07:00"), sentToday: 3 })).toEqual({ verdict: "drop", reason: "budget" });
  });

  test("quiet hours defer before the budget is judged", () => {
    expect(admitUnasked({ ...input, now: at("2026-11-04T23:00+07:00"), sentToday: 3 })).toEqual({
      verdict: "defer",
      until: at("2026-11-05T08:00+07:00"),
    });
  });

  test("an admitted row is held by quiet hours on every attempt, and sends on its admitted day past the budget", () => {
    const admittedDay = "2026-11-04" as LocalDate;
    expect(admitUnasked({ ...input, admittedDay, now: at("2026-11-04T22:01+07:00"), sentToday: 0 })).toEqual({ verdict: "defer", until: at("2026-11-05T08:00+07:00") });
    expect(admitUnasked({ ...input, admittedDay, now: at("2026-11-04T21:00+07:00"), sentToday: 3 })).toEqual({ verdict: "send", day: admittedDay });
  });

  test("a row admitted on an earlier day is admitted again against the day it goes out", () => {
    const admittedDay = "2026-11-04" as LocalDate;
    expect(admitUnasked({ ...input, admittedDay, now: at("2026-11-05T08:00+07:00"), sentToday: 2 })).toEqual({ verdict: "send", day: "2026-11-05" });
    expect(admitUnasked({ ...input, admittedDay, now: at("2026-11-05T08:00+07:00"), sentToday: 3 })).toEqual({ verdict: "drop", reason: "budget" });
  });

  test("at the LINE quota reserve, a row is dropped after quiet hours and before the budget", () => {
    const reserve = { ...input, inQuotaReserve: true };
    expect(admitUnasked({ ...reserve, now: at("2026-11-04T23:00+07:00"), sentToday: 0 })).toEqual({ verdict: "defer", until: at("2026-11-05T08:00+07:00") });
    expect(admitUnasked({ ...reserve, now: at("2026-11-04T15:00+07:00"), sentToday: 0 })).toEqual({ verdict: "drop", reason: "quota" });
  });

  test("a blocked person is dropped before anything else", () => {
    expect(admitUnasked({ ...input, now: at("2026-11-04T23:00+07:00"), sentToday: 0, status: "blocked" })).toEqual({
      verdict: "drop",
      reason: "blocked",
    });
  });
});

const NOW = local("2026-11-04T10:00");

let seq = 0;
function item(event: AgentEvent): InboxItem {
  return { key: eventKey.dev(`e${++seq}`), event, attempts: 1, receivedAt: NOW };
}
const message = (text: string): AgentEvent => ({ kind: "message", text });

function view(over: Partial<TurnView> & { readonly batch?: Batch } = {}): TurnView {
  return {
    now: NOW,
    tz: BKK,
    language: "en",
    status: "active",
    statusAt: 0 as EpochMs,
    checkinLocal: "09:00",
    summary: "",
    notes: [],
    recent: [],
    historyLeftOut: 0,
    pending: [],
    batch: { items: [item(message("hi"))] },
    unaskedLeftToday: 3,
    openTasks: [],
    acceptable: null,
    tapped: [],
    admission: { state: "admitted", seat: { cohort: "staff", half: null, code: null, inviter: null }, at: 0 as EpochMs },
    ...over,
  };
}

function output(actions: TurnOutput["actions"], lateNotice?: string): TurnOutput {
  return lateNotice === undefined ? { actions, tasks: [], about: "" } : { actions, lateNotice, tasks: [], about: "" };
}

const schedule = (key: string, when: string, asked = true) =>
  ({ type: "schedule_wakeup", key, at: when, note: `note ${key}`, asked, task: "" }) as const;
const send = (text: string) => ({ type: "send", text }) as const;

let nextId = 1;
function reminder(key: string, dueAt: EpochMs, origin: "person" | "agent" = "person"): PendingWakeup {
  return { id: nextId++ as WakeupId, key: key as WakeupKey, kind: "reminder", origin, note: `note ${key}`, dueAt, task: null, bookkeeping: false, repeat: null };
}
function checkin(dueAt: EpochMs): PendingWakeup {
  return { id: nextId++ as WakeupId, key: CHECKIN_KEY, kind: "checkin", origin: "system", note: "Daily check-in", dueAt };
}
function wakeupEvent(dueAt: EpochMs, firedAt: EpochMs, origin: "person" | "agent" = "person"): AgentEvent {
  return { kind: "wakeup", wakeupId: 7 as WakeupId, key: "bins" as WakeupKey, origin, note: "Take the bins out", dueAt, firedAt, task: null, bookkeeping: false, repeat: null };
}

describe("agent tools", () => {
  test("each tool asks for exactly what the turn schema requires, with optional fields left optional and no type field", () => {
    const schedule = AGENT_TOOLS.find((t) => t.name === "schedule_wakeup")?.inputSchema as { required: string[]; properties: Record<string, unknown> };
    expect(schedule.required).toEqual(["key", "at", "note", "asked", "task"]);
    expect(Object.keys(schedule.properties)).toEqual(["key", "at", "note", "asked", "task", "repeat"]);
    expect(AGENT_TOOLS.map((t) => [t.name, (t.inputSchema as { required: string[] }).required])).toEqual([
      ["schedule_wakeup", ["key", "at", "note", "asked", "task"]],
      ["cancel_wakeup", ["key"]],
      ["remember", ["note"]],
      ["set_locale", ["timeZone", "language"]],
      ["task", ["op", "ref", "kind", "title", "plan"]],
    ]);
    const task = AGENT_TOOLS.find((t) => t.name === "task")?.inputSchema;
    expect(task).toMatchObject({ properties: { op: { enum: ["open", "propose", "close"] }, kind: { enum: ["plan", "booking", "site", "group", "other"] } } });
    expect(AGENT_TOOLS.filter((t) => "$schema" in t.inputSchema)).toEqual([]);
  });
});

describe("reminders", () => {
  test("a routine keeps its local time across a clock change, and weekdays skip the weekend", () => {
    const london = "Europe/London" as TimeZone;
    const daily = { every: "daily", anchor: "2026-03-28T08:00" as LocalDateTime } as const;
    expect(toLocal(nextOccurrence(daily, fromLocal(daily.anchor, london), london), london)).toBe("2026-03-29T08:00");
    const weekdays = { every: "weekdays", anchor: "2026-11-20T08:00" as LocalDateTime } as const;
    expect(toLocal(nextOccurrence(weekdays, fromLocal(weekdays.anchor, london), london), london)).toBe("2026-11-23T08:00");
  });

  test("with 21 reminders already pending, every fresh one is refused and the earlier ones are left alone", () => {
    const pending = Array.from({ length: 21 }, (_, i) => reminder(`old-${i}`, local("2026-11-10T10:00")));
    const commit = planTurn(output([schedule("new-a", "2026-11-04T20:00"), schedule("new-b", "2026-11-04T21:00"), send("Done.")]), view({ pending }));
    expect(commit.wakeupsAdd).toEqual([]);
    expect(commit.wakeupsCancel).toEqual([]);
    expect(commit.rejected).toEqual([
      { action: "schedule_wakeup:new-a", reason: "limit" },
      { action: "schedule_wakeup:new-b", reason: "limit" },
    ]);
    expect(commit.outbound?.texts).toEqual(["Done.", NOTICE.reminderLimit]);
  });

  test("a reminder is admitted in the person's zone", () => {
    const commit = planTurn(output([schedule("bins", "2026-11-04T23:00"), send("Will do.")]), view());
    expect(commit.wakeupsAdd).toEqual([
      { key: "bins", kind: "reminder", origin: "person", note: "note bins", dueAt: at("2026-11-04T23:00+07:00"), bookkeeping: false, task: null, repeat: null },
    ]);
    expect(commit.outbound?.texts).toEqual(["Will do."]);
  });

  test("at 10:00:59, 10:00 is still now and 09:59 has passed", () => {
    const commit = planTurn(output([schedule("now", "2026-11-04T10:00"), schedule("gone", "2026-11-04T09:59")]), view({ now: (NOW + 59_000) as EpochMs }));
    expect(commit.wakeupsAdd.map((w) => w.key)).toEqual(["now"]);
    expect(commit.rejected).toEqual([{ action: "schedule_wakeup:gone", reason: "past" }]);
  });

  test("the agent's own wake-up needs a minute's lead; the person's may be for the current minute", () => {
    const commit = planTurn(
      output([schedule("asked", "2026-11-04T10:00"), schedule("mine", "2026-11-04T10:00", false), schedule("soon", "2026-11-04T10:01", false)]),
      view({ now: (NOW + 10_000) as EpochMs }),
    );
    expect(commit.wakeupsAdd.map((w) => w.key)).toEqual(["asked"]);
    expect(commit.rejected).toEqual([
      { action: "schedule_wakeup:mine", reason: "past" },
      { action: "schedule_wakeup:soon", reason: "past" },
    ]);
  });

  test("a key that is already pending is dropped, within a turn and across turns", () => {
    const pending = [reminder("dentist", local("2026-11-06T09:00"))];
    const commit = planTurn(output([schedule("dentist", "2026-11-07T09:00"), schedule("gym", "2026-11-05T07:00"), schedule("gym", "2026-11-05T08:00")]), view({ pending }));
    expect(commit.wakeupsAdd.map((w) => [w.key, w.dueAt])).toEqual([["gym", local("2026-11-05T07:00")]]);
    expect(commit.rejected.map((r) => r.reason)).toEqual(["duplicate", "duplicate"]);
  });

  test("cancel then schedule of one key in a turn reschedules it", () => {
    const pending = [reminder("dentist", local("2026-11-06T09:00"))];
    const commit = planTurn(output([{ type: "cancel_wakeup", key: "dentist" }, schedule("dentist", "2026-11-07T09:00")]), view({ pending }));
    expect(commit.wakeupsCancel).toEqual(["dentist"]);
    expect(commit.wakeupsAdd.map((w) => w.dueAt)).toEqual([local("2026-11-07T09:00")]);
  });

  test("a reminder moves whichever order the cancel and the schedule come in", () => {
    const pending = [reminder("dentist", local("2026-11-06T09:00"))];
    const commit = planTurn(output([schedule("dentist", "2026-11-07T09:00"), { type: "cancel_wakeup", key: "dentist" }]), view({ pending }));
    expect(commit.wakeupsCancel).toEqual(["dentist"]);
    expect(commit.wakeupsAdd.map((w) => w.dueAt)).toEqual([local("2026-11-07T09:00")]);
    expect(commit.rejected).toEqual([]);
  });

  test("a move whose new time is rejected keeps the original reminder, and the correction says so", () => {
    const pending = [reminder("dentist", local("2026-11-06T09:00"))];
    const commit = planTurn(output([{ type: "cancel_wakeup", key: "dentist" }, schedule("dentist", "friday at 9"), send("Moved!")]), view({ pending }));
    expect(commit.wakeupsCancel).toEqual([]);
    expect(commit.wakeupsAdd).toEqual([]);
    expect(commit.outbound?.texts).toEqual(["Moved!", `${NOTICE.reminderBadTime}\n(Your reminder is still set for 2026-11-06 09:00.)`]);
  });

  test("with 20 pending, one can be replaced whichever order the model writes it in", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => reminder(`r${i}`, local("2026-11-06T09:00")));
    const commit = planTurn(output([schedule("new", "2026-11-06T10:00"), { type: "cancel_wakeup", key: "r0" }]), view({ pending: twenty }));
    expect(commit.wakeupsCancel).toEqual(["r0"]);
    expect(commit.wakeupsAdd.map((w) => w.key)).toEqual(["new"]);
  });

  test("with 20 pending, a failed move takes back its slot from a new reminder in the same turn", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => reminder(`r${i}`, local("2026-11-06T09:00")));
    const commit = planTurn(
      output([{ type: "cancel_wakeup", key: "r0" }, schedule("rent", "2026-11-07T09:00"), schedule("r0", "2026-11-04T09:00"), send("Done.")]),
      view({ pending: twenty }),
    );
    expect(commit.wakeupsCancel).toEqual([]);
    expect(commit.wakeupsAdd).toEqual([]);
    expect(commit.rejected).toEqual([
      { action: "schedule_wakeup:r0", reason: "past" },
      { action: "schedule_wakeup:rent", reason: "limit" },
    ]);
  });

  test("a new time zone reads the turn's times in that zone and keeps pending reminders at their local times", () => {
    const london = parseTimeZone("Europe/London")!;
    const pending = [reminder("dentist", local("2026-11-05T15:00")), checkin(local("2026-11-05T09:00"))];
    const commit = planTurn(
      output([schedule("gym", "2026-11-04T18:00"), { type: "set_locale", timeZone: "Europe/London", language: "th" }]),
      view({ pending }),
    );
    expect(commit.locale).toEqual({ tz: london, language: "th" });
    expect(commit.wakeupsAdd.map((w) => [w.key, w.dueAt])).toEqual([["gym", local("2026-11-04T18:00", london)]]);
    expect(commit.wakeupsRetime).toEqual([
      { key: "dentist", dueAt: local("2026-11-05T15:00", london) },
      { key: CHECKIN_KEY, dueAt: local("2026-11-04T09:00", london) },
    ]);
  });

  test("an unknown time zone is rejected and changes nothing but the language", () => {
    const commit = planTurn(output([{ type: "set_locale", timeZone: "Bangkok time", language: "th" }]), view({ pending: [reminder("dentist", local("2026-11-05T15:00"))] }));
    expect(commit.locale).toEqual({ tz: BKK, language: "th" });
    expect(commit.wakeupsRetime).toEqual([]);
    expect(commit.rejected).toEqual([{ action: "set_locale", reason: "bad_zone" }]);
    expect(commit.outbound?.texts).toEqual([NOTICES.th.badZone]);
  });

  test("the check-in can't be cancelled or scheduled by the model", () => {
    const pending = [checkin(local("2026-11-05T09:00"))];
    const commit = planTurn(output([{ type: "cancel_wakeup", key: CHECKIN_KEY }, schedule(CHECKIN_KEY, "2026-11-05T10:00")]), view({ pending }));
    expect(commit.wakeupsCancel).toEqual([]);
    expect(commit.wakeupsAdd).toEqual([]);
    expect(commit.rejected.map((r) => r.reason)).toEqual(["reserved_key", "reserved_key"]);
  });

  test("the 21st pending reminder is rejected with a notice; the check-in doesn't count", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => reminder(`r${i}`, local("2026-11-06T09:00")));
    const full = planTurn(output([schedule("one-more", "2026-11-06T10:00"), send("Done.")]), view({ pending: [checkin(local("2026-11-05T09:00")), ...twenty] }));
    expect(full.wakeupsAdd).toEqual([]);
    expect(full.outbound?.texts).toEqual(["Done.", NOTICE.reminderLimit]);

    const nineteen = twenty.slice(1);
    const room = planTurn(output([schedule("one-more", "2026-11-06T10:00")]), view({ pending: [checkin(local("2026-11-05T09:00")), ...nineteen] }));
    expect(room.wakeupsAdd.map((w) => w.key)).toEqual(["one-more"]);
  });

  test("a notice displaces the last of three sends", () => {
    const commit = planTurn(output([send("a"), send("b"), send("c"), schedule("late", "2026-11-04T09:00")]), view());
    expect(commit.outbound?.texts).toEqual(["a", "b", NOTICE.reminderPast]);
  });
});

describe("corrections", () => {
  const checkinEvent: AgentEvent = { kind: "checkin", day: "2026-11-04" as LocalDate, dueAt: NOW, firedAt: NOW };

  test("a wake-up or check-in turn that confirms a rejected action is corrected too", () => {
    const fired = planTurn(output([{ type: "cancel_wakeup", key: "gym" }, send("I cancelled the gym reminder.")]), view({ batch: { items: [item(wakeupEvent(NOW, NOW))] } }));
    expect(fired.outbound).toMatchObject({ intent: "requested", texts: ["I cancelled the gym reminder.", NOTICE.cancelNotFound] });

    const checkin = planTurn(output([schedule("dentist", "tomorrow 9"), send("Your dentist reminder is set.")]), view({ batch: { items: [item(checkinEvent)] } }));
    expect(checkin.outbound).toMatchObject({ intent: "unasked", texts: ["Your dentist reminder is set.", NOTICE.reminderBadTime] });
  });

  test("a rejected wake-up the agent set for itself is logged, never shown", () => {
    const pending = [reminder("follow-up", local("2026-11-06T10:00"), "agent")];
    const commit = planTurn(output([schedule("follow-up", "2026-11-07T10:00", false), send("Nice.")]), view({ pending }));
    expect(commit.outbound?.texts).toEqual(["Nice."]);
    expect(commit.rejected).toEqual([{ action: "schedule_wakeup:follow-up", reason: "duplicate" }]);
  });

  test("a person who wrote in hears the correction even when the model sent nothing", () => {
    const commit = planTurn(output([schedule("dentist", "tomorrow 9")]), view());
    expect(commit.outbound).toMatchObject({ intent: "reply", texts: [NOTICE.reminderBadTime] });
    expect(commit.rejected).toEqual([{ action: "schedule_wakeup:dentist", reason: "bad_time" }]);
  });

  test("a check-in that sends nothing shows no correction, and still logs the rejection", () => {
    const commit = planTurn(output([schedule("dentist", "tomorrow 9")]), view({ batch: { items: [item(checkinEvent)] } }));
    expect(commit.outbound).toBeNull();
    expect(commit.rejected).toEqual([{ action: "schedule_wakeup:dentist", reason: "bad_time" }]);
  });
});

describe("caps", () => {
  const over = (cap: number) => "x".repeat(cap + 1);

  test("a send or a note past its cap is cut to fit and logged, and its action still applies", () => {
    const commit = planTurn(
      output([
        send(over(TURN.maxTextChars)),
        { type: "schedule_wakeup", key: "bins", at: "2026-11-04T23:00", note: over(TURN.maxNoteBytes), asked: true, task: "" },
        { type: "remember", note: over(TURN.maxNoteBytes) },
      ]),
      view(),
    );
    expect(commit.outbound?.texts.map((t) => t.length)).toEqual([TURN.maxTextChars]);
    expect(commit.wakeupsAdd.map((w) => bytesOf(w.note) <= TURN.maxNoteBytes && w.note.endsWith("…"))).toEqual([true]);
    expect(commit.notes.map((n) => bytesOf(n) <= TURN.maxNoteBytes && n.endsWith("…"))).toEqual([true]);
    expect(commit.rejected).toEqual([
      { action: "send", reason: "too_long" },
      { action: "schedule_wakeup:bins", reason: "too_long" },
      { action: "remember", reason: "too_long" },
    ]);
  });

  test("a late notice past its cap is cut to fit and logged", () => {
    const due = local("2026-11-04T08:00");
    const late = view({ batch: { items: [item(wakeupEvent(due, NOW))] } });
    const commit = planTurn(output([send("Call the clinic.")], over(TURN.maxLateNoticeChars)), late);
    expect(commit.outbound?.texts[0].split("\n")[0].length).toBe(TURN.maxLateNoticeChars);
    expect(commit.rejected).toEqual([{ action: "late_notice", reason: "too_long" }]);
  });

  test("actions past the cap are dropped and logged, and a dropped reminder the person asked for is corrected", () => {
    const notes = Array.from({ length: TURN.maxActions - 1 }, (_, i) => ({ type: "remember", note: `fact ${i}` }) as const);
    const commit = planTurn(output([send("All set."), ...notes, schedule("bins", "2026-11-04T23:00")]), view());
    expect(commit.notes).toHaveLength(TURN.maxActions - 1);
    expect(commit.wakeupsAdd).toEqual([]);
    expect(commit.outbound?.texts).toEqual(["All set.", "(That was more than I can do in one message, so I skipped some of it.)"]);
    expect(commit.rejected).toEqual([{ action: "schedule_wakeup:bins", reason: "too_many_actions" }]);
  });
});

describe("lateness", () => {
  test("exactly one hour is on time; a minute more is late", () => {
    expect(isLate({ dueAt: at("2026-11-04T09:00Z"), firedAt: at("2026-11-04T10:00Z") })).toBe(false);
    expect(isLate({ dueAt: at("2026-11-04T09:00Z"), firedAt: at("2026-11-04T10:01Z") })).toBe(true);
  });

  const due = local("2026-11-04T09:00");
  const fired = (minutesLate: number) => view({ now: (due + minutesLate * 60_000) as EpochMs, batch: { items: [item(wakeupEvent(due, (due + minutesLate * 60_000) as EpochMs))] } });

  test("a wake-up fired exactly one hour after its due time carries no late notice", () => {
    const commit = planTurn(output([send("Call the clinic.")], "Sorry, this is late."), fired(60));
    expect(commit.outbound?.texts).toEqual(["Call the clinic."]);
  });

  test("a wake-up more than an hour late leads with the model's late notice", () => {
    const commit = planTurn(output([send("Call the clinic.")], "Sorry, this was due at 09:00."), fired(61));
    expect(commit.outbound?.texts).toEqual(["Sorry, this was due at 09:00.\nCall the clinic."]);
  });

  test("a late wake-up whose model forgot the notice gets the fixed one", () => {
    const commit = planTurn(output([send("Call the clinic.")]), fired(90));
    expect(commit.outbound?.texts).toEqual([`${NOTICE.lateFallback("2026-11-04 09:00")}\nCall the clinic.`]);
  });

  test("a late requested reminder written by code also says it is late", () => {
    const commit = planWithoutModel(fired(90), { kind: "model_failed" });
    expect(commit.outbound).toMatchObject({ intent: "requested", texts: [`${NOTICE.lateFallback("2026-11-04 09:00")}\nReminder: Take the bins out`] });
  });
});

describe("wake-up origin", () => {
  test("only the person's own message can make a person wake-up, and only when asked", () => {
    expect(wakeupOrigin("message", true)).toBe("person");
    expect(wakeupOrigin("message", false)).toBe("agent");
    expect(wakeupOrigin("wakeup", true)).toBe("agent");
    expect(wakeupOrigin("checkin", true)).toBe("agent");
    expect(wakeupOrigin("lifecycle", true)).toBe("agent");
  });

  test("a proactive turn can never create a person wake-up, whatever the model claims", () => {
    for (const trigger of [wakeupEvent(NOW, NOW), { kind: "checkin", day: "2026-11-04", dueAt: NOW, firedAt: NOW } as AgentEvent]) {
      const commit = planTurn(output([schedule("follow-up", "2026-11-05T10:00", true)]), view({ batch: { items: [item(trigger)] } }));
      expect(commit.wakeupsAdd.map((w) => w.origin)).toEqual(["agent"]);
    }
  });

  test("a person reminder fires at the chosen time even at night; the agent's own waits for 08:00", () => {
    const night = local("2026-11-04T23:00");
    expect(fireAt({ origin: "person", dueAt: night }, BKK)).toBe(night);
    expect(fireAt({ origin: "agent", dueAt: night }, BKK)).toBe(local("2026-11-05T08:00"));
    expect(fireAt({ origin: "system", dueAt: night }, BKK)).toBe(local("2026-11-05T08:00"));

    const firings = planFiring(night, BKK, "active", "09:00", [reminder("bins", night, "person"), reminder("peek", night, "agent")]);
    expect(firings.map((f) => f.wakeup.key)).toEqual(["bins"]);
  });

  test("a person reminder is requested, not unasked; the agent's own is unasked", () => {
    expect(intentOf(wakeupEvent(NOW, NOW, "person"))).toBe("requested");
    expect(intentOf(wakeupEvent(NOW, NOW, "agent"))).toBe("unasked");
    expect(intentOf({ kind: "checkin", day: "2026-11-04", dueAt: NOW, firedAt: NOW } as AgentEvent)).toBe("unasked");
    expect(intentOf(message("hi"))).toBe("reply");
  });

  test("a blocked person's wake-ups are skipped, and the check-in gets no successor", () => {
    const due = local("2026-11-05T09:00");
    const firings = planFiring(due, BKK, "blocked", "09:00", [checkin(due), reminder("bins", due)]);
    expect(firings.map((f) => f.kind)).toEqual(["skip", "skip"]);
  });

  test("a fired check-in is keyed by its local day and schedules the next one", () => {
    const due = local("2026-11-05T09:00");
    expect(planFiring(due, BKK, "active", "09:00", [checkin(due)])).toMatchObject([
      { kind: "fire", key: "checkin:2026-11-05", next: { key: CHECKIN_KEY, dueAt: local("2026-11-06T09:00") } },
    ]);
  });
});

describe("lifecycle order", () => {
  const follow = (t: EpochMs): AgentEvent => ({ kind: "lifecycle", change: "follow", at: t });

  test("a follow older than the last block changes nothing", () => {
    const commit = planTurn(output([send("Hi again!")]), view({ status: "blocked", statusAt: local("2026-11-04T09:00"), batch: { items: [item(follow(local("2026-11-04T08:00")))] } }));
    expect(commit.reachability).toBeNull();
    expect(commit.ensureCheckin).toBeNull();
  });

  test("a newer follow unblocks and ensures a check-in", () => {
    const commit = planTurn(output([send("Hi again!")]), view({ status: "blocked", statusAt: local("2026-11-04T09:00"), batch: { items: [item(follow(local("2026-11-04T09:30")))] } }));
    expect(commit.reachability).toEqual({ status: "active", at: local("2026-11-04T09:30") });
    expect(commit.ensureCheckin?.dueAt).toBe(local("2026-11-05T09:00"));
  });

  test("a message unblocks like a follow, but not one written before the platform's block", () => {
    const written = (t: EpochMs): Batch => ({ items: [{ ...item(message("hi")), receivedAt: t }] });
    const blocked = { status: "blocked" as const, statusAt: local("2026-11-04T09:00") };
    const after = planTurn(output([send("Hi again!")]), view({ ...blocked, batch: written(local("2026-11-04T09:30")) }));
    expect(after.reachability).toEqual({ status: "active", at: local("2026-11-04T09:30") });
    expect(after.ensureCheckin?.dueAt).toBe(local("2026-11-05T09:00"));

    const before = planTurn(output([send("Hi again!")]), view({ ...blocked, batch: written(local("2026-11-04T08:59")) }));
    expect(before.reachability).toBeNull();
  });
});

describe("spend", () => {
  const haiku = routeFor({ kind: "key", provider: "anthropic", model: "claude-haiku-5-5" }, "turn");
  const usage = (o: Partial<{ inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }>) => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    ...o,
  });

  test("the estimate prices every prompt byte and the overhead at the dearer input rate, plus the full output budget", () => {
    expect(estimate(haiku, 3_000)).toBe(Math.ceil(((3_000 + PROMPT_OVERHEAD_TOKENS) * HAIKU_5_5.cacheWritePerM + haiku.maxTokens * HAIKU_5_5.outputPerM) / 1_000_000));
    expect(costOf(haiku, usage({ inputTokens: 1 }), null)).toBe(1);
  });

  test("Haiku prompts over 100K tokens are billed on the long-context rate card", () => {
    expect(costOf(haiku, usage({ inputTokens: 100_000, outputTokens: 1_000 }), null)).toBe(10_000 + 500);
    expect(costOf(haiku, usage({ inputTokens: 120_000, outputTokens: 1_000 }), null)).toBe(60_000 + 2_500);
  });

  test("a cost the provider reported wins over the card, and a provider's fee is added to either", () => {
    expect(costOf(haiku, usage({ inputTokens: 1_000_000 }), 42 as MicroUsd)).toBe(42);
    const openrouter = routeFor({ kind: "key", provider: "openrouter", model: "anthropic/claude-haiku-5.5" }, "turn");
    expect(costOf(openrouter, usage({}), 1_000 as MicroUsd)).toBe(1_055);
    expect(estimate(openrouter, 3_000)).toBe(Math.ceil(estimate(haiku, 3_000) * 1.055));
  });

  test("open reservations count against the cap", () => {
    expect(fits({ spent: usd(4), reserved: usd(0.5) }, usd(0.5), usd(5))).toBe(true);
    expect(fits({ spent: usd(4), reserved: usd(0.999) }, usd(0.002), usd(5))).toBe(false);
  });
});

describe("output budgets", () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const mostBytes = (n: number) => "ก".repeat(n);
  const longest = <T extends string>(xs: readonly T[]) => xs.reduce((a, b) => (b.length > a.length ? b : a));

  test("the largest turn output code keeps whole fits the turn's output budget", () => {
    const key = "k".repeat(40);
    const actions = [
      { type: "send", text: mostBytes(TURN.maxTextChars) },
      { type: "schedule_wakeup", key, at: "2099-11-04T10:00", note: mostBytes(TURN.maxNoteBytes / 3), asked: false, task: key },
      { type: "cancel_wakeup", key },
      { type: "remember", note: mostBytes(TURN.maxNoteBytes / 3) },
    ];
    const biggest = actions.reduce((a, b) => (bytes(b) > bytes(a) ? b : a));
    const output = {
      actions: Array.from({ length: TURN.maxActions }, () => biggest),
      lateNotice: mostBytes(TURN.maxLateNoticeChars),
      tasks: [
        { op: "propose", ref: key, kind: longest(TASK_KINDS), title: mostBytes(TASKS.maxTitleBytes / 3), plan: mostBytes(TASKS.maxPlanChars) },
        ...Array.from({ length: TASKS.maxOps - 1 }, () => ({ op: "open", ref: key, kind: longest(TASK_KINDS), title: mostBytes(TASKS.maxTitleBytes / 3), plan: "" })),
      ],
      about: key,
    };

    expect(TurnOutputSchema.safeParse(output).success).toBe(true);
    expect(bytes(output)).toBeLessThanOrEqual(OUTPUT_TOKENS.turn);
  });

  test("the longest summary the compaction schema accepts fits the compaction's output budget", () => {
    const output = { summary: mostBytes(Math.floor(COMPACTION.maxSummaryBytes / 3)) };

    expect(CompactionOutputSchema.safeParse(output).success).toBe(true);
    expect(bytes(output)).toBeLessThanOrEqual(OUTPUT_TOKENS.compaction);
  });
});

describe("alarm and compaction", () => {
  test("the alarm is the earliest need, never in the past, and absent when nothing waits", () => {
    const now = at("2026-11-04T10:00Z");
    const none = { inboxReadyAt: null, wakeupFireAt: null, outboxReadyAt: null, billingAlertAt: null, logsReadyAt: null, compactionRetryAt: null, boxAt: null };
    expect(nextAlarm({ ...none, now, wakeupFireAt: at("2026-11-04T12:00Z"), outboxReadyAt: at("2026-11-04T11:00Z") })).toBe(at("2026-11-04T11:00Z"));
    expect(nextAlarm({ ...none, now, inboxReadyAt: at("2026-11-04T09:00Z") })).toBe(now);
    expect(nextAlarm({ ...none, now, boxAt: at("2026-11-04T10:00:30Z"), logsReadyAt: at("2026-11-04T10:05Z") })).toBe(at("2026-11-04T10:00:30Z"));
    expect(nextAlarm({ ...none, now })).toBeNull();
  });

  test("requires the billing alert deadline and includes it in the earliest alarm", () => {
    expectTypeOf<Pick<Parameters<typeof nextAlarm>[0], "billingAlertAt">>().toEqualTypeOf<{ readonly billingAlertAt: EpochMs | null }>();
    const now = at("2026-11-04T10:00Z");
    const billingAlertAt = at("2026-11-04T10:05Z");
    expect(nextAlarm({ now, inboxReadyAt: null, wakeupFireAt: null, outboxReadyAt: at("2026-11-04T10:10Z"),
      billingAlertAt, logsReadyAt: null, compactionRetryAt: null, boxAt: null })).toBe(billingAlertAt);
  });

  test("compaction folds the oldest turns, keeping the newest 30, once there are more than 60", () => {
    const oldestTurns = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, role: "person" as const, text: `t${i + 1}`, at: NOW }));
    const input = { summary: "", throughSeq: 0, oldestTurns, noteCount: 0, oldestNotes: [] };
    expect(planCompaction({ ...input, turnCount: 60 }, Infinity)).toBeNull();
    expect(planCompaction({ ...input, turnCount: 61 }, Infinity)?.foldThroughSeq).toBe(30);
  });

  test("a compaction page folds only as many whole turns as its budget holds, and a turn too big for any page as a placeholder", () => {
    const long = "ก".repeat(5_000);
    const oldestTurns = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, role: "person" as const, text: `${i + 1} ${long}`, at: NOW }));
    const plan = planCompaction({ summary: "", throughSeq: 0, oldestTurns, turnCount: 61, noteCount: 0, oldestNotes: [] }, 24_000);
    const text = renderPrompt(plan!.prompt);
    expect(bytesOf(text)).toBeLessThanOrEqual(24_000);
    expect(plan?.foldThroughSeq).toBeGreaterThanOrEqual(1);
    expect(text).toContain(`Person: ${plan?.foldThroughSeq} `);
    expect(text).not.toContain(`Person: ${(plan?.foldThroughSeq ?? 0) + 1} `);
    const tiny = planCompaction({ summary: "", throughSeq: 0, oldestTurns, turnCount: 61, noteCount: 0, oldestNotes: [] }, 300);
    expect(tiny?.foldThroughSeq).toBeGreaterThanOrEqual(1);
    expect(tiny?.foldSeqs).toEqual([]);
    expect(renderPrompt(tiny!.prompt)).toContain("[long message on");
  });

  test("the turn prompt asks only for what a model without tools can do", () => {
    expect(TURN_SYSTEM).not.toMatch(/search|sources|price ranges|you found/i);
    expect(TURN_SYSTEM.match(/opportunistic by default/gi)).toHaveLength(1);
    expect(TURN_SYSTEM).toContain("Never invent an event, a price or an opening.");
  });

  test("the turn prompt says a pending key can't be scheduled again", () => {
    expect(TURN_SYSTEM).not.toContain("is ignored");
    expect(TURN_SYSTEM).toContain("Scheduling a key that is still pending is rejected.");
  });

  test("system prompts are byte-stable constants", () => {
    for (const p of [TURN_SYSTEM, COMPACTION_SYSTEM]) expect(p).not.toContain("${");
  });
});
