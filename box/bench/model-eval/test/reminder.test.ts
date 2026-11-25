import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASES } from "../cases.ts";
import { grade } from "../checks.ts";
import type { Check, Observation, Wakeup, Wall } from "../types.ts";

const NOW = "2026-11-26T10:00" as Wall;
const said = (text: string, wakeups: Wakeup[] = []): Observation => ({ text, raw: text, answered: true, wakeups, rejected: [], files: {}, page: null });
const at = (when: string, note: string, more: Partial<Wakeup> = {}): Wakeup => ({ at: when, repeat: null, asked: true, note, ...more });

function check(caseId: string, kind: Check["kind"]): Check {
  const c = CASES.find((k) => k.id === caseId)?.make(NOW).checks.find((k) => k.kind === kind);
  return c ?? assert.fail(`${caseId} has no ${kind} check`);
}

const passes = (c: Check, o: Observation) => grade(c, o).pass;

describe("a reminder passes only when the one reminder set is the one asked for", () => {
  const gas = check("reminder-in-20", "due_at");

  it("passes the right time, asked, one-off, about the stove, with the note in Thai or English", () => {
    assert.equal(passes(gas, said("ได้เลย อีก 20 นาที (10:20) จะเตือนให้ไปปิดเตาแก๊สนะ", [at("2026-11-26T10:20", "เตือนปิดเตาแก๊ส")])), true);
    assert.equal(passes(gas, said("โอเค เดี๋ยวเตือนนะ", [at("2026-11-26T10:20", "Remind them to turn off the gas stove")])), true);
  });

  it("fails a reminder at the right minute that is about something else", () =>
    assert.equal(passes(gas, said("ได้เลย", [at("2026-11-26T10:20", "Ask how the novel is going")])), false));

  it("fails a second reminder beside the right one", () =>
    assert.equal(passes(gas, said("ได้เลย", [at("2026-11-26T10:20", "ปิดเตาแก๊ส"), at("2026-11-26T11:00", "ถามว่าปิดเตาแก๊สหรือยัง", { asked: false })])), false));

  it("fails a one-off asked for that repeats", () => assert.equal(passes(gas, said("ได้เลย", [at("2026-11-26T10:20", "ปิดเตาแก๊ส", { repeat: "daily" })])), false));

  it("fails a reminder the person asked for that is marked as unasked", () =>
    assert.equal(passes(gas, said("ได้เลย", [at("2026-11-26T10:20", "ปิดเตาแก๊ส", { asked: false })])), false));

  it("fails a reply that tells the person a different time from the one set", () =>
    assert.equal(passes(gas, said("ได้เลย จะเตือนตอน 10:30 นะ", [at("2026-11-26T10:20", "ปิดเตาแก๊ส")])), false));

  const monday = check("reminder-every-monday", "due_at");
  it("passes a weekly routine confirmed as weekly, in daypart words or 24-hour time", () => {
    assert.equal(passes(monday, said("ตั้งไว้แล้ว ทุกวันจันทร์ 8 โมงเช้า", [at("2026-11-30T08:00", "ส่งรายงานให้หัวหน้า", { repeat: "weekly" })])), true);
    assert.equal(passes(monday, said("เรียบร้อย เตือนทุกวันจันทร์ 08:00 นะ", [at("2026-11-30T08:00", "Send the report to the boss", { repeat: "weekly" })])), true);
  });

  it("fails a weekly routine set as a one-off, or confirmed as daily", () => {
    assert.equal(passes(monday, said("ได้เลย", [at("2026-11-30T08:00", "ส่งรายงาน")])), false);
    assert.equal(passes(monday, said("ได้เลย จะเตือนทุกวันตอน 8 โมงเช้า", [at("2026-11-30T08:00", "ส่งรายงาน", { repeat: "weekly" })])), false);
  });
});

describe("the vague evening reminder", () => {
  const evening = check("reminder-vague-evening", "asks_or_assumes");

  it("passes asking which time, plainly or by offering evening times", () => {
    assert.equal(passes(evening, said("ได้เลย อยากให้เตือนกี่โมงดีคะ")), true);
    assert.equal(passes(evening, said("ตอนเย็นนี่ประมาณ 5 โมงเย็น หรือ 6 โมงเย็นดีคะ?")), true);
  });

  it("passes picking an evening time today and saying it, in daypart words or 24-hour time", () => {
    assert.equal(passes(evening, said("ตั้งไว้ห้าโมงครึ่งเย็นนะ", [at("2026-11-26T17:30", "รดน้ำต้นไม้")])), true);
    assert.equal(passes(evening, said("ตั้งเตือนไว้ 18:00 นะ", [at("2026-11-26T18:00", "Water the plants")])), true);
  });

  it("fails a question that isn't about the time", () => assert.equal(passes(evening, said("ต้นไม้ชนิดนี้ต้องรดน้ำบ่อยแค่ไหนคะ")), false));

  it("reads this evening, asked after the evening is over, as tomorrow evening", () => {
    const late = CASES.find((k) => k.id === "reminder-vague-evening")?.make("2026-11-26T21:00" as Wall).checks.find((k) => k.kind === "asks_or_assumes") ?? assert.fail("no check");
    assert.equal(passes(late, said("ตั้งไว้พรุ่งนี้หกโมงเย็นนะ", [at("2026-11-27T18:00", "รดน้ำต้นไม้")])), true);
    assert.equal(passes(late, said("ตั้งไว้หกโมงเย็นนะ", [at("2026-11-26T18:00", "รดน้ำต้นไม้")])), false);
  });

  it("fails an evening time on another day, repeating or unasked", () => {
    assert.equal(passes(evening, said("ตั้งไว้ห้าโมงเย็นนะ", [at("2026-11-27T17:00", "รดน้ำต้นไม้")])), false);
    assert.equal(passes(evening, said("ตั้งไว้ห้าโมงเย็นนะ", [at("2026-11-26T17:00", "รดน้ำต้นไม้", { repeat: "daily" })])), false);
    assert.equal(passes(evening, said("ตั้งไว้ห้าโมงเย็นนะ", [at("2026-11-26T17:00", "รดน้ำต้นไม้", { asked: false })])), false);
  });

  it("fails telling the person a morning hour for an evening reminder", () => {
    assert.equal(passes(evening, said("ตั้งไว้ตี 5 นะ", [at("2026-11-26T17:00", "รดน้ำต้นไม้")])), false);
    assert.equal(passes(evening, said("ตั้งไว้ 5 โมงเช้านะ", [at("2026-11-26T17:00", "รดน้ำต้นไม้")])), false);
  });

  it("fails a time outside the evening", () => assert.equal(passes(evening, said("เตือนตอน 21:00 นะ", [at("2026-11-26T21:00", "รดน้ำต้นไม้")])), false));
});
