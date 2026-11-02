/**
 * Pure policy tests: no Worker runtime, no storage. Sketch of the cases that pin the brief's rules.
 */
import { describe, expect, test } from "vitest";
import type { EpochMs, MicroUsd, TimeZone } from "../src/domain";
import { admitUnasked, quietUntil } from "../src/policy/outreach";
import { isLate } from "../src/policy/schedule";
import { decideReservation, SPEND } from "../src/policy/spend";

const BKK = "Asia/Bangkok" as TimeZone;
const at = (iso: string) => Date.parse(iso) as EpochMs;
const usd = (n: number) => Math.round(n * 1e6) as MicroUsd;

describe("quiet hours", () => {
  test("21:59 is open, 22:00 is quiet until 08:00, 08:00 is open", () => {
    expect(quietUntil(at("2026-11-04T21:59+07:00"), BKK)).toBeNull();
    expect(quietUntil(at("2026-11-04T22:00+07:00"), BKK)).toBe(at("2026-11-05T08:00+07:00"));
    expect(quietUntil(at("2026-11-05T07:59+07:00"), BKK)).toBe(at("2026-11-05T08:00+07:00"));
    expect(quietUntil(at("2026-11-05T08:00+07:00"), BKK)).toBeNull();
  });
});

describe("unasked budget", () => {
  test("fourth of the local day is dropped", () => {
    expect(admitUnasked({ now: at("2026-11-04T15:00+07:00"), tz: BKK, sentToday: 3, dailyBudget: 3, status: "active" }))
      .toEqual({ verdict: "drop", reason: "budget" });
  });
  test("quiet hours defer before the budget is judged", () => {
    expect(admitUnasked({ now: at("2026-11-04T23:00+07:00"), tz: BKK, sentToday: 3, dailyBudget: 3, status: "active" }))
      .toEqual({ verdict: "defer", until: at("2026-11-05T08:00+07:00") });
  });
});

describe("lateness", () => {
  test("exactly one hour is on time; a minute more is late", () => {
    expect(isLate({ dueAt: at("2026-11-04T09:00Z"), firedAt: at("2026-11-04T10:00Z") })).toBe(false);
    expect(isLate({ dueAt: at("2026-11-04T09:00Z"), firedAt: at("2026-11-04T10:01Z") })).toBe(true);
  });
});

describe("spend", () => {
  test("user cap refuses before asking for a lease", () => {
    expect(decideReservation({ spent: usd(14.999), reserved: usd(0), leased: usd(15) }, usd(0.002)))
      .toEqual({ kind: "refuse", scope: "user_cap" });
  });
  test("short lease asks for a chunk, capped by what the user cap leaves", () => {
    expect(decideReservation({ spent: usd(14.6), reserved: usd(0), leased: usd(14.6) }, usd(0.002)))
      .toEqual({ kind: "need_lease", chunk: usd(0.4) });
    void SPEND;
  });
});
