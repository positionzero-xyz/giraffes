import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { grade, thaiShare } from "../checks.ts";
import { totalIn } from "../browser.ts";
import type { Check, Observation, PageReport } from "../types.ts";

const turn = (text: string, more: Partial<Observation> = {}): Observation => ({ text, raw: text, answered: text !== "", wakeups: [], rejected: [], files: {}, page: null, ...more });
const page = (p: Partial<PageReport>): Observation => turn("", { page: { loaded: true, errors: [], text: "", persist: null, priceGroups: p.text?.split("\n"), ...p } });

function both(check: Check, good: Observation, bad: Observation) {
  const g = grade(check, good);
  const b = grade(check, bad);
  assert.equal(g.pass, true, `known-good should pass ${check.kind}: ${g.detail}`);
  assert.equal(b.pass, false, `known-bad should fail ${check.kind}: ${b.detail}`);
}

describe("every check passes its known-good and fails its known-bad", () => {
  it("thai", () => both({ kind: "thai", min: 0.8 }, turn("ลองยืดคอค้างไว้ 10 วินาทีนะ 🙂 ใช้ LINE ก็ได้"), turn("ok ลองดู stretching แบบ simple ก่อนนะ")));

  it("fits_reply", () => both({ kind: "fits_reply" }, turn("ก".repeat(600)), turn("ก".repeat(601))));

  it("replies", () => both({ kind: "replies" }, turn("ได้เลย"), turn("ตั้งเตือนไม่สำเร็จ", { answered: false })));

  it("requires a known clean stop", () => {
    const check = { kind: "stops_clean" } as const;
    both(check, turn("ค่ะ", { stop: "end" }), turn("ค่ะ", { stop: "refusal" }));
    assert.equal(grade(check, turn("ค่ะ")).available, false);
  });

  it("length", () => both({ kind: "length", min: 10, max: 20 }, turn("ก".repeat(15)), turn("ก".repeat(25))));

  it("file", () => both({ kind: "file", path: "index.html" }, turn("", { files: { "index.html": "<html></html>" } }), turn("", { files: { "menu.html": "<html></html>" } })));

  it("page_has", () =>
    both({ kind: "page_has", items: [{ label: "pork", any: ["เรือหมู"] }, { label: "50", any: ["50"] }] }, page({ text: "ก๋วยเตี๋ยวเรือหมู 50 บาท" }), page({ text: "ก๋วยเตี๋ยวเรือเนื้อ 60 บาท" })));

  it("priced, in a list or a table, against the same prices on the wrong dishes", () => {
    const menu = { kind: "priced", items: [{ label: "pork", any: ["เรือหมู"], price: 50 }, { label: "beef", any: ["เรือเนื้อ"], price: 60 }, { label: "soup", any: ["เกาเหลา"], price: 55 }] } as const;
    both(menu, page({ text: "ก๋วยเตี๋ยวเรือหมู 50 บาท\nก๋วยเตี๋ยวเรือเนื้อ 60 บาท\nเกาเหลา 55 บาท" }), page({ text: "ก๋วยเตี๋ยวเรือหมู 60 บาท\nก๋วยเตี๋ยวเรือเนื้อ 55 บาท\nเกาเหลา 50 บาท" }));
    both(menu, page({ priceGroups: ["ก๋วยเตี๋ยวเรือหมู\nเส้นเล็ก น้ำตก\t฿50", "ก๋วยเตี๋ยวเรือเนื้อ\t฿60", "เกาเหลา\t฿55"] }), page({ text: "ก๋วยเตี๋ยวเรือหมู\nก๋วยเตี๋ยวเรือเนื้อ\nเกาเหลา\n50 60 55" }));
  });

  it("binds the full decimal price and ignores a count next to a currency total", () => {
    both(
      { kind: "priced", items: [{ label: "pork", any: ["เรือหมู"], price: 50 }] },
      page({ text: "ก๋วยเตี๋ยวเรือหมู ฿50.00" }),
      page({ text: "ก๋วยเตี๋ยวเรือหมู 50.50 บาท" }),
    );
    const price = { kind: "priced", items: [{ label: "pork", any: ["เรือหมู"], price: 50 }] } as const;
    assert.equal(grade(price, page({ text: "ก๋วยเตี๋ยวเรือหมู -50 บาท" })).pass, false);
    assert.equal(totalIn("ยอดรวม 137 บาท\nรวม 1 รายการ"), 137);
    assert.equal(totalIn("ยอดรวม ฿๑๓๗.๕๐"), 137.5);
    assert.equal(totalIn(["ยอดรวมทั้งสิ้น (บาท)\n137.25", "รวม 4 รายการ"]), 137.25);
  });

  it("loads_clean", () => both({ kind: "loads_clean" }, page({}), page({ errors: ["ReferenceError: total is not defined"] })));

  it("loads_clean fails a page that never loaded", () => assert.equal(grade({ kind: "loads_clean" }, turn("")).pass, false));

  it("persists", () =>
    both(
      { kind: "persists", drive: "expense", shown: true },
      page({ persist: { ok: true, shown: true, reason: "kept after reload", missing: [], totalBefore: null, totalAfter: null } }),
      page({ persist: { ok: true, shown: false, reason: "kept after reload", missing: [], totalBefore: null, totalAfter: null } }),
    ));

  it("priced, on a menu that names each dish again beside an order counter", () => {
    const menu = { kind: "priced", items: [{ label: "pork", any: ["เรือหมู"], price: 50 }, { label: "soup", any: ["เกาเหลา"], price: 55 }] } as const;
    both(
      menu,
      page({ text: "ก๋วยเตี๋ยวเรือหมู 50 บาท\nเกาเหลา 55 บาท\nสั่งเลย\nก๋วยเตี๋ยวเรือหมู - 0 +\nเกาเหลา - 0 +\nรวม 0 บาท" }),
      page({ text: "ก๋วยเตี๋ยวเรือหมู 55 บาท\nเกาเหลา 50 บาท\nสั่งเลย\nก๋วยเตี๋ยวเรือหมู - 0 +\nเกาเหลา - 0 +\nรวม 0 บาท" }),
    );
  });
});

describe("text helpers", () => {
  it("counts letters only for the Thai share", () => assert.equal(thaiShare("ก ข 123 !! 😀"), 1));

  it("counts letters of every script against the Thai share, accented ones too", () => {
    assert.ok(thaiShare("ขอบคุณ Спасибо 감사합니다") < 0.5);
    assert.ok(thaiShare("ขอบคุณ crème brûlée café") < thaiShare("ขอบคุณ creme brulee cafe") + 0.001);
    assert.ok(thaiShare("ขอบคุณ crème brûlée café") < 0.5);
  });

  it("counts Thai vowel and tone marks as no letters, so a word's share doesn't depend on its marks", () =>
    assert.equal(thaiShare("ที่นี่ hi"), thaiShare("ทน hi")));

  it("leaves the brand and channel names a Thai post uses out of the share", () => {
    assert.equal(thaiShare("ทักมาทาง LINE OA หรือสั่งใน Shopee ได้เลย"), 1);
    assert.ok(thaiShare("ทักมาทาง LINE OA หรือสั่งใน Shopee ได้เลย hello friends") < 1);
  });
});
