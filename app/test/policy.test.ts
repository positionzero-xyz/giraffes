import { describe, expect, test } from "vitest";
import { CompactionOutputSchema, planCompaction } from "../src/agent/compaction";
import { COMPACTION_SYSTEM, TURN_SYSTEM } from "../src/agent/prompt";
import { NOTICE, planTurn, planWithoutModel, TURN, TurnOutputSchema, type Batch, type InboxItem, type TurnOutput, type TurnView } from "../src/agent/turn";
import {
  CHECKIN_KEY,
  TASK_KINDS,
  TASK_STATUSES,
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
import { priceOf, routeOf } from "../src/model/model";
import { admitUnasked, quietUntil } from "../src/policy/outreach";
import { fireAt, isLate, nextAlarm, planFiring, wakeupOrigin, type PendingWakeup } from "../src/policy/schedule";
import { costOf, decideReservation, estimate, SCHEMA_ALLOWANCE_TOKENS, SPEND } from "../src/policy/spend";
import { fromLocal, nextLocalTime, parseLocalDateTime, parseTimeZone, toLocal } from "../src/policy/time";

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
  const input = { tz: BKK, admitted: null, dailyBudget: 3, status: "active" as const };

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
    const admitted = "2026-11-04" as LocalDate;
    expect(admitUnasked({ ...input, admitted, now: at("2026-11-04T22:01+07:00"), sentToday: 0 })).toEqual({ verdict: "defer", until: at("2026-11-05T08:00+07:00") });
    expect(admitUnasked({ ...input, admitted, now: at("2026-11-04T21:00+07:00"), sentToday: 3 })).toEqual({ verdict: "send", day: admitted });
  });

  test("a row admitted on an earlier day is admitted again against the day it goes out", () => {
    const admitted = "2026-11-04" as LocalDate;
    expect(admitUnasked({ ...input, admitted, now: at("2026-11-05T08:00+07:00"), sentToday: 2 })).toEqual({ verdict: "send", day: "2026-11-05" });
    expect(admitUnasked({ ...input, admitted, now: at("2026-11-05T08:00+07:00"), sentToday: 3 })).toEqual({ verdict: "drop", reason: "budget" });
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
    status: "active",
    statusAt: 0 as EpochMs,
    checkinLocal: "09:00",
    summary: "",
    notes: [],
    recent: [],
    pending: [],
    batch: { items: [item(message("hi"))] },
    unaskedLeftToday: 3,
    ...over,
  };
}

function output(actions: TurnOutput["actions"], lateNotice?: string): TurnOutput {
  const task = { kind: "reminder" as const, key: "t", status: "started" as const };
  return lateNotice === undefined ? { actions, task } : { actions, lateNotice, task };
}

const schedule = (key: string, when: string, asked = true) =>
  ({ type: "schedule_wakeup", key, at: when, note: `note ${key}`, asked }) as const;
const send = (text: string) => ({ type: "send", text }) as const;

let nextId = 1;
function reminder(key: string, dueAt: EpochMs, origin: "person" | "agent" = "person"): PendingWakeup {
  return { id: nextId++ as WakeupId, key: key as WakeupKey, kind: "reminder", origin, note: `note ${key}`, dueAt };
}
function checkin(dueAt: EpochMs): PendingWakeup {
  return { id: nextId++ as WakeupId, key: CHECKIN_KEY, kind: "checkin", origin: "system", note: "Daily check-in", dueAt };
}
function wakeupEvent(dueAt: EpochMs, firedAt: EpochMs, origin: "person" | "agent" = "person"): AgentEvent {
  return { kind: "wakeup", wakeupId: 7 as WakeupId, key: "bins" as WakeupKey, origin, note: "Take the bins out", dueAt, firedAt };
}

describe("reminders", () => {
  test("a reminder is admitted in the person's zone", () => {
    const commit = planTurn(output([schedule("bins", "2026-11-04T23:00"), send("Will do.")]), view());
    expect(commit.wakeupsAdd).toEqual([{ key: "bins", kind: "reminder", origin: "person", note: "note bins", dueAt: at("2026-11-04T23:00+07:00") }]);
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
  test("estimates and costs are whole micro-dollars, rounded up", () => {
    const haiku = priceOf("claude-haiku-5-5");
    expect(estimate("claude-haiku-5-5", 3_000, 1_200)).toBe(((3_000 + SCHEMA_ALLOWANCE_TOKENS) * haiku.cacheWritePerM + 1_200 * haiku.outputPerM) / 1_000_000);
    expect(costOf("claude-haiku-5-5", { inputTokens: 1, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBe(1);
    expect(costOf("claude-sonnet-5-5", { inputTokens: 1_000, outputTokens: 100, cacheWriteTokens: 1_000, cacheReadTokens: 10_000 })).toBe(2_000 + 1_000 + 2_500 + 2_000);
  });

  test("Haiku prompts over 100K tokens are billed on the long-context rate card", () => {
    expect(costOf("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBe(10_000 + 500);
    expect(costOf("claude-haiku-5-5", { inputTokens: 120_000, outputTokens: 1_000, cacheWriteTokens: 0, cacheReadTokens: 0 })).toBe(60_000 + 2_500);
    expect(costOf("claude-haiku-5-5", { inputTokens: 1_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 100_000 })).toBe(500 + 5_000);
  });

  test("the estimate for a long prompt covers its bill on the long-context card", () => {
    const worst = costOf("claude-haiku-5-5", { inputTokens: 0, outputTokens: 1_000, cacheWriteTokens: 150_000, cacheReadTokens: 0 });
    expect(estimate("claude-haiku-5-5", 150_000, 1_000)).toBeGreaterThanOrEqual(worst);
  });

  test("within the lease, a call is reserved locally", () => {
    expect(decideReservation({ spent: usd(1), reserved: usd(0.1), leased: usd(1.5) }, usd(0.002))).toEqual({ kind: "reserve" });
  });

  test("the user cap refuses before asking for a lease", () => {
    expect(decideReservation({ spent: usd(14.999), reserved: usd(0), leased: usd(15) }, usd(0.002))).toEqual({ kind: "refuse", scope: "user_cap" });
  });

  test("open reservations count against the cap", () => {
    expect(decideReservation({ spent: usd(14), reserved: usd(0.999), leased: usd(15) }, usd(0.002))).toEqual({ kind: "refuse", scope: "user_cap" });
  });

  test("a short lease asks for a chunk, capped by what the user cap leaves", () => {
    expect(decideReservation({ spent: usd(1), reserved: usd(0), leased: usd(1) }, usd(0.002))).toEqual({ kind: "need_lease", chunk: SPEND.leaseChunkMicro });
    expect(decideReservation({ spent: usd(14.6), reserved: usd(0), leased: usd(14.6) }, usd(0.002))).toEqual({ kind: "need_lease", chunk: usd(0.4) });
  });
});

describe("output budgets", () => {
  // Every token is at least one UTF-8 byte, and Thai takes 3 bytes a character, so the byte length of the
  // largest output the schema accepts, written in Thai, is the most tokens a valid output can need.
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const thai = (n: number) => "ก".repeat(n);
  const longest = <T extends string>(xs: readonly T[]) => xs.reduce((a, b) => (b.length > a.length ? b : a));

  test("the largest turn output the schema accepts fits the turn's output budget", () => {
    const key = "k".repeat(40);
    const actions = [
      { type: "send", text: thai(TURN.maxTextChars) },
      { type: "schedule_wakeup", key, at: "2099-11-04T10:00", note: thai(TURN.maxNoteChars), asked: false },
      { type: "cancel_wakeup", key },
      { type: "remember", note: thai(TURN.maxNoteChars) },
    ];
    const biggest = actions.reduce((a, b) => (bytes(b) > bytes(a) ? b : a));
    const output = {
      actions: Array.from({ length: TURN.maxActions }, () => biggest),
      lateNotice: thai(TurnOutputSchema.shape.lateNotice.unwrap().maxLength ?? 0),
      task: { kind: longest(TASK_KINDS), key, status: longest(TASK_STATUSES) },
    };

    expect(TurnOutputSchema.safeParse(output).success).toBe(true);
    expect(bytes(output)).toBeLessThanOrEqual(routeOf("turn").maxTokens);
  });

  test("the longest summary the compaction schema accepts fits the compaction's output budget", () => {
    const output = { summary: thai(CompactionOutputSchema.shape.summary.maxLength ?? 0) };

    expect(CompactionOutputSchema.safeParse(output).success).toBe(true);
    expect(bytes(output)).toBeLessThanOrEqual(routeOf("compaction").maxTokens);
  });
});

describe("alarm and compaction", () => {
  test("the alarm is the earliest need, never in the past, and absent when nothing waits", () => {
    const now = at("2026-11-04T10:00Z");
    const none = { inboxReadyAt: null, wakeupFireAt: null, outboxReadyAt: null, logsReadyAt: null, compactionRetryAt: null };
    expect(nextAlarm({ ...none, now, wakeupFireAt: at("2026-11-04T12:00Z"), outboxReadyAt: at("2026-11-04T11:00Z") })).toBe(at("2026-11-04T11:00Z"));
    expect(nextAlarm({ ...none, now, inboxReadyAt: at("2026-11-04T09:00Z") })).toBe(now);
    expect(nextAlarm({ ...none, now })).toBeNull();
  });

  test("compaction folds the oldest turns, keeping the newest 30, once there are more than 60", () => {
    const oldestTurns = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, role: "person" as const, text: `t${i + 1}`, at: NOW }));
    const input = { summary: "", throughSeq: 0, oldestTurns, noteCount: 0, oldestNotes: [] };
    expect(planCompaction({ ...input, turnCount: 60 })).toBeNull();
    expect(planCompaction({ ...input, turnCount: 61 })?.foldThroughSeq).toBe(30);
  });

  test("the turn prompt asks only for what a model without tools can do", () => {
    expect(TURN_SYSTEM).not.toMatch(/search|sources|price ranges/i);
    expect(TURN_SYSTEM.match(/opportunistic by default/gi)).toHaveLength(1);
    expect(TURN_SYSTEM).toContain("Never invent an event, a price or an opening.");
  });

  test("system prompts are byte-stable constants", () => {
    for (const p of [TURN_SYSTEM, COMPACTION_SYSTEM]) expect(p).not.toContain("${");
  });
});
