import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { grade, hourPhrases, squash, thaiShare } from "../checks.ts";
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

  it("due_at on the exact wall time", () =>
    both(
      { kind: "due_at", readings: [{ label: "in 20 minutes", at: w("2026-11-29T10:20") }] },
      turn("", { wakeups: [{ at: "2026-11-29T10:20", repeat: null, asked: true }] }),
      turn("", { wakeups: [{ at: "2026-11-29T10:00", repeat: null, asked: true }] }),
    ));

  it("due_at with a repeat", () =>
    both(
      { kind: "due_at", readings: [{ label: "monday", at: w("2026-11-30T08:00") }], repeat: "weekly" },
      turn("", { wakeups: [{ at: "2026-11-30T08:00", repeat: "weekly", asked: true }] }),
      turn("", { wakeups: [{ at: "2026-11-30T08:00", repeat: null, asked: true }] }),
    ));

  it("due_at names the reading it matched", () => {
    const r = grade(
      { kind: "due_at", readings: [{ label: "coming", at: w("2026-11-27T10:00") }, { label: "next week", at: w("2026-12-04T10:00") }] },
      turn("", { wakeups: [{ at: "2026-12-04T10:00", repeat: null, asked: true }] }),
    );
    assert.equal(r.pass, true);
    assert.match(r.detail, /^next week/);
  });

  it("asks_or_assumes when it asks back", () =>
    both({ kind: "asks_or_assumes", fromHour: 16, toHour: 20 }, turn("ได้เลย อยากให้เตือนกี่โมงดี"), turn("ได้เลยจ้า")));

  it("asks_or_assumes when it picks a time and says it", () =>
    both(
      { kind: "asks_or_assumes", fromHour: 16, toHour: 20 },
      turn("ตั้งไว้หกโมงเย็นนะ", { wakeups: [{ at: "2026-11-29T18:00", repeat: null, asked: true }] }),
      turn("ตั้งไว้ให้แล้วนะ", { wakeups: [{ at: "2026-11-29T18:00", repeat: null, asked: true }] }),
    ));

  it("asks_or_assumes refuses a time outside the evening", () =>
    both(
      { kind: "asks_or_assumes", fromHour: 16, toHour: 20 },
      turn("เตือนตอน 17:30 นะ", { wakeups: [{ at: "2026-11-29T17:30", repeat: null, asked: true }] }),
      turn("เตือนตอน 21:00 นะ", { wakeups: [{ at: "2026-11-29T21:00", repeat: null, asked: true }] }),
    ));

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
  it("names evening hours the Thai ways", () => {
    assert.ok(hourPhrases(17, 0).includes("ห้าโมงเย็น"));
    assert.ok(hourPhrases(19, 0).includes("ทุ่มนึง"));
    assert.ok(hourPhrases(18, 30).includes("18.30"));
  });
});
