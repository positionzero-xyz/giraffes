import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { grade, thaiShare } from "../checks.ts";
import { squash, statedRepeats, statedTimes, thaiNumber } from "../thai.ts";
import type { Check, Observation, PageReport, Wall } from "../types.ts";

const turn = (text: string, more: Partial<Observation> = {}): Observation => ({ text, wakeups: [], rejected: [], files: {}, page: null, ...more });
const page = (p: Partial<PageReport>): Observation => turn("", { page: { loaded: true, errors: [], text: "", persist: null, ...p } });
const w = (s: string) => s as Wall;

function both(check: Check, good: Observation, bad: Observation) {
  const g = grade(check, good);
  const b = grade(check, bad);
  assert.equal(g.pass, true, `known-good should pass ${check.kind}: ${g.detail}`);
  assert.equal(b.pass, false, `known-bad should fail ${check.kind}: ${b.detail}`);
}

describe("every check passes its known-good and fails its known-bad", () => {
  it("thai", () => both({ kind: "thai", min: 0.8 }, turn("ลองยืดคอค้างไว้ 10 วินาทีนะ 🙂 ใช้ LINE ก็ได้"), turn("ok ลองดู stretching แบบ simple ก่อนนะ")));

  it("no_jargon", () => both({ kind: "no_jargon" }, turn("ตั้งเตือนไว้ให้แล้วนะ พรุ่งนี้บ่ายสอง"), turn("ตั้ง wake-up ด้วย schedule_wakeup ให้แล้ว")));

  it("mentions", () => both({ kind: "mentions", what: "principal", any: ["เงินต้น"] }, turn("ดอกเบี้ยจะถูกรวมกับเงิน ต้น ทุกปี"), turn("มันคือดอกเบี้ยแบบหนึ่ง")));

  it("fits_reply", () => both({ kind: "fits_reply" }, turn("ก".repeat(600)), turn("ก".repeat(601))));

  it("worker_accepts", () => both({ kind: "worker_accepts" }, turn("ok"), turn("ok", { rejected: ["schedule_wakeup:rent past"] })));

  it("facts", () =>
    both(
      { kind: "facts", facts: [{ label: "price", any: ["65"] }, { label: "dates", any: ["1-7 ธ"] }] },
      turn("ลาเต้แก้วละ ๖๕ บาท วันที่ 1 – 7 ธ.ค. นี้"),
      turn("ลาเต้แก้วละ 56 บาท วันที่ 1-7 ธ.ค. นี้"),
    ));

  it("length", () => both({ kind: "length", min: 10, max: 20 }, turn("ก".repeat(15)), turn("ก".repeat(25))));

  it("file", () => both({ kind: "file", path: "index.html" }, turn("", { files: { "index.html": "<html></html>" } }), turn("", { files: { "menu.html": "<html></html>" } })));

  it("html_complete", () =>
    both(
      { kind: "html_complete", path: "index.html" },
      turn("", { files: { "index.html": "<!doctype html>\n<html lang=\"th\"><body>x</body></html>\n" } }),
      turn("", { files: { "index.html": "<!doctype html>\n<html lang=\"th\"><body><ul><li>ก๋วยเตี๋ยว" } }),
    ));

  it("page_has", () =>
    both({ kind: "page_has", items: [{ label: "pork", any: ["เรือหมู"] }, { label: "50", any: ["50"] }] }, page({ text: "ก๋วยเตี๋ยวเรือหมู 50 บาท" }), page({ text: "ก๋วยเตี๋ยวเรือเนื้อ 60 บาท" })));

  it("loads_clean", () => both({ kind: "loads_clean" }, page({}), page({ errors: ["ReferenceError: total is not defined"] })));

  it("loads_clean fails a page that never loaded", () => assert.equal(grade({ kind: "loads_clean" }, turn("")).pass, false));

  it("persists", () =>
    both(
      { kind: "persists", shown: true },
      page({ persist: { ok: true, shown: true, reason: "kept after reload" } }),
      page({ persist: { ok: true, shown: false, reason: "kept after reload" } }),
    ));
});

describe("text helpers", () => {
  it("squashes spaces, dashes and Thai digits", () => assert.equal(squash("๑ – ๗ ธ.ค."), "1-7ธ.ค."));
  it("counts letters only for the Thai share", () => assert.equal(thaiShare("ก ข 123 !! 😀"), 1));
  it("reads Thai number words, including the spoken thousands", () => {
    assert.deepEqual(["หกสิบห้า", "ยี่สิบเอ็ด", "สามร้อยเก้าสิบ", "หนึ่งพันห้าร้อย", "พันห้า", "พันสอง"].map(thaiNumber), [65, 21, 390, 1500, 1500, 1200]);
    assert.equal(thaiNumber("สองสาม"), null);
  });

  it("reads a clock time in 24-hour form and in each Thai daypart", () => {
    const read = (s: string) => statedTimes(s).map((t) => `${t.hours.join("/")}:${t.minute}`);
    assert.deepEqual(read("เตือนตอน 17:30 นะ"), ["17:30"]);
    assert.deepEqual(read("ห้าโมงครึ่งเย็น"), ["17:30"]);
    assert.deepEqual(read("บ่ายสองโมง"), ["14:0"]);
    assert.deepEqual(read("สองทุ่มครึ่ง"), ["20:30"]);
    assert.deepEqual(read("ทุ่มนึง"), ["19:0"]);
    assert.deepEqual(read("ตี 5"), ["5:0"]);
    assert.deepEqual(read("8 โมงเช้า"), ["8:0"]);
    assert.deepEqual(read("เที่ยงคืน"), ["0:0"]);
  });

  it("doesn't read a duration or a dotted date as a clock time", () => {
    assert.deepEqual(statedTimes("อีก 20 นาที อีก 2 ชั่วโมง"), []);
    assert.deepEqual(statedTimes("วันที่ 15.12.2569"), []);
  });

  it("reads a stated cadence", () => {
    assert.deepEqual(statedRepeats("เตือนทุกวันจันทร์"), ["weekly"]);
    assert.deepEqual(statedRepeats("เตือนทุกวันนะ"), ["daily"]);
    assert.deepEqual(statedRepeats("พรุ่งนี้บ่ายสอง"), []);
  });
});
