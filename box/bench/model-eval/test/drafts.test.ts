import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASES } from "../cases.ts";
import { grade } from "../checks.ts";
import type { Wall } from "../types.ts";

const NOW = "2026-11-26T10:00" as Wall;

function failing(caseId: string, text: string): string[] {
  const checks = CASES.find((c) => c.id === caseId)?.make(NOW).checks ?? assert.fail(`no case ${caseId}`);
  return checks.map((c) => grade(c, { text, wakeups: [], rejected: [], files: {}, page: null })).filter((r) => !r.pass).map((r) => `${r.check}: ${r.detail}`);
}

const good = (caseId: string, text: string) => assert.deepEqual(failing(caseId, text), [], text);
const bad = (caseId: string, text: string) => assert.notDeepEqual(failing(caseId, text), [], text);

describe("the coffee post", () => {
  const right =
    "บ้านดอยคอฟฟี่ สาขานิมมาน ซื้อลาเต้เย็น 1 แก้ว แถมอีก 1 แก้วฟรี ปกติแก้วละ 65 บาท วันที่ 1-7 ธันวาคมนี้ เฉพาะที่หน้าร้านเท่านั้น แวะมาจิบกาแฟหอมๆ ชวนเพื่อนมาแบ่งกันนะคะ อากาศเย็นแบบนี้ต้องมีลาเต้สักแก้ว";

  it("passes with the facts in digits, or spelt in Thai words", () => {
    good("draft-facebook-coffee", right);
    good(
      "draft-facebook-coffee",
      "☕ บ้านดอยคอฟฟี่ สาขานิมมาน จัดโปร ซื้อลาเต้เย็นหนึ่งแก้ว แถมฟรีอีกหนึ่งแก้ว จากปกติแก้วละหกสิบห้าบาท ตั้งแต่วันที่หนึ่งถึงเจ็ดธันวาคมนี้ เฉพาะที่หน้าร้านเท่านั้นนะคะ ชวนเพื่อนมาแบ่งกันดื่มได้เลย หอมกาแฟดอย นมนุ่ม เย็นชื่นใจ",
    );
  });

  it("fails another drink", () => bad("draft-facebook-coffee", right.replaceAll("ลาเต้", "ชาเขียว")));
  it("fails a price with an extra digit", () => bad("draft-facebook-coffee", right.replace("65 บาท", "655 บาท")));
  it("fails a date range that starts on another day", () => bad("draft-facebook-coffee", right.replace("1-7", "21-7")));
  it("fails a date range that ends on another day", () => bad("draft-facebook-coffee", right.replace("1-7", "1-17")));
  it("fails every branch and delivery", () => bad("draft-facebook-coffee", right.replace("เฉพาะที่หน้าร้านเท่านั้น", "ทุกสาขา ทั้งหน้าร้านและเดลิเวอรี่")));
});

describe("the salon broadcast", () => {
  const right = "💇‍♀️ ซาลอนมะลิ ส่งโปรเดือนธันวาคม ทำสีผมลด 20% จากปกติ 1,500 บาท เหลือเพียง 1,200 บาท จองคิวล่วงหน้าทาง LINE นี้เท่านั้นนะคะ ร้านปิดทุกวันพุธ แล้วพบกันค่ะ";

  it("passes with the old price first or the new price first", () => {
    good("draft-line-salon", right);
    good("draft-line-salon", "ซาลอนมะลิ เดือนธันวาคมนี้ ทำสีผมเหลือแค่ 1,200 บาท (ปกติ 1,500 บาท) ลด 20% เลยค่ะ จองคิวล่วงหน้าทางไลน์เท่านั้น ร้านหยุดทุกวันพุธนะคะ แล้วมาสวยด้วยกันน้า");
  });

  it("fails the two prices swapped", () => bad("draft-line-salon", right.replace("จากปกติ 1,500 บาท เหลือเพียง 1,200 บาท", "จากปกติ 1,200 บาท เหลือเพียง 1,500 บาท")));
  it("fails booking by phone too", () => bad("draft-line-salon", right.replace("ทาง LINE นี้เท่านั้น", "ทาง LINE หรือโทรจองก็ได้")));
  it("fails another discount", () => bad("draft-line-salon", right.replace("20%", "25%")));
});

describe("the Shopee description", () => {
  const right =
    "กระเป๋าผ้าฝ้ายทอมือจากน่าน งานแฮนด์เมดจากช่างทอในชุมชน ขนาด 30x35 ซม. ใส่ของได้เยอะ มีให้เลือก 3 สี คือ คราม น้ำตาล และครีม ราคาเพียง 390 บาท ซักเครื่องได้ ไม่ต้องกลัวเลอะ เหมาะกับไปทำงาน ไปเรียน หรือไปเที่ยว สั่งเลยวันนี้";

  it("passes with the price in digits or in Thai words", () => {
    good("draft-shopee-bag", right);
    good("draft-shopee-bag", right.replace("390 บาท", "สามร้อยเก้าสิบบาท"));
  });

  it("fails a price with an extra digit", () => bad("draft-shopee-bag", right.replace("390 บาท", "3,900 บาท")));
  it("fails a hand-wash-only claim", () => bad("draft-shopee-bag", right.replace("ซักเครื่องได้", "ซักมือเท่านั้น ห้ามซักเครื่อง")));
});

describe("the review reply", () => {
  const right =
    "เรียนคุณลูกค้า ครัวคุณยายต้องขออภัยเป็นอย่างสูงที่ทำให้รออาหารนานและพนักงานดูแลไม่ทั่วถึง เราจะนำไปปรับปรุงการบริการทันที และขอมอบส่วนลด 15% สำหรับการมาใช้บริการครั้งหน้า หวังว่าจะได้ต้อนรับอีกครั้งนะคะ";

  it("passes with the discount in digits or in Thai words", () => {
    good("draft-review-reply", right);
    good("draft-review-reply", right.replace("15%", "สิบห้าเปอร์เซ็นต์"));
  });

  it("fails a discount that isn't for the next visit", () => bad("draft-review-reply", right.replace("สำหรับการมาใช้บริการครั้งหน้า หวังว่าจะได้ต้อนรับอีกครั้งนะคะ", "ให้กับบิลนี้เลยค่ะ")));
  it("fails another discount", () => bad("draft-review-reply", right.replace("15%", "50%")));
});
