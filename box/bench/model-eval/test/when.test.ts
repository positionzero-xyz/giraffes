import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Wall } from "../types.ts";
import { addMinutes, dayAt, nextWeekReadings, nextWeekday, parseWall, thaiDate, todayAt, weeklyReadings } from "../when.ts";

const w = (s: string) => parseWall(s) ?? assert.fail(`bad wall ${s}`);

describe("wall-time answer keys", () => {
  it("rejects a date that doesn't exist", () => assert.equal(parseWall("2026-02-30T10:00"), null));
  it("adds minutes across midnight", () => assert.equal(addMinutes(w("2026-12-31T23:50"), 20), "2027-01-01T00:10"));
  it("puts tomorrow at a time", () => assert.equal(dayAt(w("2026-11-30T10:00"), 1, "14:00"), "2026-12-01T14:00"));

  it("finds the next Monday from a Sunday, a Monday after 8, and a Friday", () => {
    assert.equal(nextWeekday(w("2026-11-29T10:00"), 0, "08:00"), "2026-11-30T08:00");
    assert.equal(nextWeekday(w("2026-11-30T10:00"), 0, "08:00"), "2026-12-07T08:00");
    assert.equal(nextWeekday(w("2026-11-30T07:00"), 0, "08:00"), "2026-11-30T08:00");
    assert.equal(nextWeekday(w("2026-12-04T10:00"), 0, "08:00"), "2026-12-07T08:00");
  });

  it("gives one reading of next Friday on a Sunday and two on a Wednesday", () => {
    assert.deepEqual(nextWeekReadings(w("2026-11-29T10:00"), 4, "10:00"), [{ label: "next week", at: "2026-12-04T10:00" }]);
    assert.deepEqual(nextWeekReadings(w("2026-11-25T10:00"), 4, "10:00"), [
      { label: "coming", at: "2026-11-27T10:00" },
      { label: "next week", at: "2026-12-04T10:00" },
    ]);
    assert.deepEqual(nextWeekReadings(w("2026-11-27T10:00"), 4, "10:00"), [{ label: "next week", at: "2026-12-04T10:00" }]);
  });

  it("reads next Friday, said on a Friday before its hour, as the Friday a week on", () =>
    assert.deepEqual(nextWeekReadings(w("2026-11-27T09:00"), 4, "10:00"), [{ label: "next week", at: "2026-12-04T10:00" }]));

  it("lets a weekly routine asked for at its own minute start now or next week, as the Worker accepts either", () => {
    assert.deepEqual(weeklyReadings(w("2026-11-30T08:00"), 0, "08:00"), [
      { label: "starting now", at: "2026-11-30T08:00" },
      { label: "next Monday 08:00", at: "2026-12-07T08:00" },
    ]);
    assert.deepEqual(weeklyReadings(w("2026-11-30T08:01"), 0, "08:00"), [{ label: "next Monday 08:00", at: "2026-12-07T08:00" }]);
    assert.deepEqual(weeklyReadings(w("2026-11-30T07:59"), 0, "08:00"), [{ label: "next Monday 08:00", at: "2026-11-30T08:00" }]);
  });

  it("writes a late-December date in the Buddhist era", () => {
    assert.equal(thaiDate(w("2026-12-15T09:00")), "15 ธ.ค. 2569");
    assert.equal(thaiDate(dayAt(w("2026-12-20T10:00"), 20, "09:00")), "9 ม.ค. 2570");
  });

  it("reads today in Bangkok, not in UTC", () => assert.equal(todayAt(new Date("2026-11-25T18:30:00Z"), "Asia/Bangkok", "10:00"), "2026-11-26T10:00" as Wall));
});
