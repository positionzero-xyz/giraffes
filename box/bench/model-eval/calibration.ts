import { CASES } from "./cases.ts";
import { dayAt, parseWall, thaiDate } from "./when.ts";
import type { Wakeup } from "./types.ts";

export type Answers = Readonly<Record<string, boolean>>;
export type Plant = {
  readonly id: string;
  readonly caseId: string;
  readonly reply: string;
  readonly expected: Answers;
  readonly now?: string;
  readonly message?: string;
  readonly wakeups?: readonly Wakeup[];
  readonly notes?: readonly string[];
  readonly cancelled?: readonly string[];
  readonly html?: string;
  readonly rank?: "good" | "flat" | "bad";
};

const NOW = "2026-11-26T10:00";
const may = (caseId: string, pass: boolean): Answers => Object.fromEntries(
  CASES.find((c) => c.id === caseId)?.judge.criteria.map(({ key }) => [key, pass]) ?? [],
);

const pair = (caseId: string, good: string, bad: string): Plant[] => [
  { id: caseId + "-clear", caseId, reply: good, expected: may(caseId, true) },
  { id: caseId + "-misleading", caseId, reply: bad, expected: may(caseId, false) },
];

type ReminderSample = { readonly reply: string; readonly note?: string; readonly at?: string; readonly repeat?: Wakeup["repeat"]; readonly expected: Answers };

function reminders(caseId: string, samples: readonly ReminderSample[]): Plant[] {
  return samples.map(({ reply, note, at, repeat, expected }, index) => ({
    id: caseId + "-" + (index + 1), caseId, reply, expected, now: NOW,
    wakeups: note && at ? [{ note, at, asked: true, repeat: repeat ?? null }] : [],
  }));
}

const coffee = "draft-facebook-coffee";
const cafe = (offer: string, dates: string, scope: string) => `☕ บ้านดอยคอฟฟี่ชวนเพื่อนมาจิบลาเต้ด้วยกัน! ${offer} ☀️ ${dates} ${scope} แวะมาหาเราที่นิมมานนะคะ`;
const offer = "ซื้อลาเต้เย็นหนึ่งแก้ว รับลาเต้เย็นอีกแก้วฟรี ราคาปกติแก้วละหกสิบห้าบาทค่ะ";
const dates = "เริ่มวันที่ 1 ธันวาคมนี้ ถึงวันที่ 7 ธันวาคมนี้";
const scope = "รับโปรได้ที่หน้าร้านสาขานิมมานเท่านั้น";
const coffeePlant = (id: string, reply: string, expected: Answers, rank?: Plant["rank"]): Plant => ({ id, caseId: coffee, reply, expected, rank });

const salon = "draft-line-salon";
const salonOffer = "ธันวาคมนี้ ทำสีผมลด 20% จาก 1,500 เหลือ 1,200 บาท";
const salonTerms = "จองล่วงหน้าทาง LINE เท่านั้นนะคะ ร้านปิดทุกวันพุธ";
const salonPlant = (id: string, offer: string, terms: string, expected: Answers): Plant => ({
  id, caseId: salon, reply: `ซาลอนมะลิชวนมาเปลี่ยนลุคค่ะ ✨ ${offer} ทักเรามาเลือกคิวได้เลย ${terms}`, expected,
});

const repeatGood = { note: "ส่งรายงานให้หัวหน้า", at: "2026-11-30T08:00", repeat: "weekly" } as const;
const stoveGood = { note: "ปิดเตาแก๊ส", at: "2026-11-26T10:20" };
const tomorrowGood = { note: "โทรหาคลินิกทำฟัน", at: "2026-11-27T14:00" };
const fridayGood = { note: "จ่ายค่าเช่าห้อง", at: "2026-11-27T10:00" };
const due = dayAt(parseWall(NOW)!, 20, "09:00");
const waterGood = { note: "รดน้ำต้นไม้", at: "2026-11-26T17:15" };

const html = (body: string) => `<!doctype html><html lang="th"><meta charset="utf-8"><body>${body}</body></html>`;
const pages: Readonly<Record<string, string>> = {
  "build-noodle-menu": html("<h1>ก๋วยเตี๋ยวเรือเจ๊หมวย</h1><dl><dt>ก๋วยเตี๋ยวเรือหมู</dt><dd>50 บาท</dd><dt>ก๋วยเตี๋ยวเรือเนื้อ</dt><dd>60 บาท</dd><dt>เกาเหลา</dt><dd>55 บาท</dd><dt>ชาเย็น</dt><dd>25 บาท</dd></dl>"),
  "build-booking-form": html('<h1>จองคิวร้านนวด</h1><form><label>ชื่อ <input required></label><label>เบอร์โทร <input type="tel" required></label><label>วันที่ <input type="date" required></label><label>เวลา <input type="time" required></label><button>จองคิว</button><output aria-live="polite"></output></form><script>document.querySelector("form").onsubmit=(e)=>{e.preventDefault();localStorage.setItem("booking",JSON.stringify([...e.target.querySelectorAll("input")].map(x=>x.value)));e.target.querySelector("output").textContent="จองคิวเรียบร้อยแล้ว";};</script>'),
  "build-expense-tracker": html('<h1>จดรายจ่าย</h1><label>รายการ <input id="item"></label><label>จำนวนเงิน (บาท) <input id="amount" type="number"></label><button id="save">บันทึกรายจ่าย</button><ul id="entries"></ul><p>ยอดรวม <output id="total">0</output> บาท</p><script>const rows=JSON.parse(localStorage.getItem("expenses")||"[]");function draw(){entries.replaceChildren(...rows.map(([name,cost])=>Object.assign(document.createElement("li"),{textContent:name+" "+cost+" บาท"})));total.value=rows.reduce((sum,row)=>sum+row[1],0);}save.onclick=()=>{rows.push([item.value,Number(amount.value)]);localStorage.setItem("expenses",JSON.stringify(rows));draw();};draw();</script>'),
  "build-menu-order": html('<nav><button id="showMenu">เมนู</button> <button id="showCart">รายการที่เลือก</button></nav><section id="menu"><h1>เมนู</h1><p>กะเพราไก่ 70 บาท <button data-price="70">เพิ่มกะเพราไก่</button></p><p>โกโก้เย็น 45 บาท <button data-price="45">เพิ่มโกโก้เย็น</button></p></section><section id="cart" hidden><h1>รายการที่เลือก</h1><ul></ul><p>ยอดรวม <output>0</output> บาท</p></section><script>showMenu.onclick=()=>{menu.hidden=false;cart.hidden=true;};showCart.onclick=()=>{menu.hidden=true;cart.hidden=false;};let total=0;for(const b of document.querySelectorAll("[data-price]"))b.onclick=()=>{const li=document.createElement("li");li.textContent=b.parentElement.firstChild.textContent;cart.querySelector("ul").append(li);total+=Number(b.dataset.price);cart.querySelector("output").value=total;};</script>'),
};

export const PLANTS: readonly Plant[] = [
  ...pair("chat-advice", "นั่งตัวตรงแล้วเอนหูเข้าหาไหล่เบา ๆ ค้างไว้ข้างละ 15 วินาที หายใจปกติและหยุดหากเจ็บนะ", "ระบบได้ทำการ invoke tool เสร็จสมบูรณ์แล้ว กรุณารันคำสั่งถัดไป"),
  ...pair("chat-explain", "ถ้าฝากหนึ่งร้อย ดอกเบี้ยสิบบาท ปีถัดไปแบบทบต้นจะคิดจากหนึ่งร้อยสิบบาท แบบธรรมดายังคิดจากเงินต้นหนึ่งร้อยบาทเท่าเดิม", "ดอกเบี้ยทบต้นคือ simple interest ที่คำนวณจาก original balance เสมอ ตาม system prompt"),
  ...pair("chat-stressed", "โดนว่าต่อหน้าคนอื่นแถมงานยังค้าง คงหนักมากเลย คืนนี้พักก่อนได้นะ พรุ่งนี้ค่อยเลือกงานเล็กที่สุดมาทำก่อน", "Input นี้ไม่เข้าเงื่อนไข schema คุณเองที่ทำพลาด เลิกคิดมากแล้วไปทำงาน"),
  ...pair("chat-slang", "ลองเดินเล่นเปิดเพลงที่ไม่ได้ฟังนาน ๆ ดูดิ ไม่เสียตังค์ หรือหาเกมฟรีเล่นกับเพื่อนสักตาก็ได้ 555", "ระบบขอเสนอ premium entertainment experience ราคาแพ็กเกจห้าพันบาท"),
  ...reminders("reminder-in-20", [
    { ...stoveGood, reply: "อีกยี่สิบนาทีจะเตือนให้ปิดเตาแก๊สนะ", expected: { note: true, confirmation: true } },
    { ...stoveGood, note: "เปิดเตาแก๊สทิ้งไว้", reply: "พรุ่งนี้จะเตือนให้ปิดเตาแก๊สตอนสิบโมงยี่สิบหรือสิบโมงครึ่งนะ", expected: { note: false, confirmation: false } },
    { ...stoveGood, note: "ถามว่าอ่านหนังสือถึงไหนแล้ว", reply: "วันนี้สิบโมงยี่สิบจะเตือนปิดเตาแก๊สค่ะ", expected: { note: false, confirmation: true } },
  ]),
  ...reminders("reminder-tomorrow-2pm", [
    { ...tomorrowGood, reply: "พรุ่งนี้บ่ายสองจะเตือนให้โทรคลินิกฟันนะ", expected: { note: true, confirmation: true } },
    { ...tomorrowGood, note: "ไปซื้อแปรงสีฟัน", reply: "ตั้งเตือนโทรคลินิกฟันวันเสาร์บ่ายสองค่ะ", expected: { note: false, confirmation: false } },
  ]),
  ...reminders("reminder-every-monday", [
    { ...repeatGood, reply: "ตั้งเตือนส่งรายงานทุกวันจันทร์แปดโมงเช้าแล้วนะ", expected: { note: true, confirmation: true } },
    { ...repeatGood, note: "อ่านรายงานเก่า", reply: "ตั้งเตือนส่งรายงานทุกวันศุกร์แปดโมงเช้าแล้ว", expected: { note: false, confirmation: false } },
  ]),
  ...reminders("reminder-next-friday", [
    { ...fridayGood, reply: "ศุกร์ที่ 27 นี้ สิบโมงเช้าจะเตือนให้จ่ายค่าเช่าห้องนะคะ", expected: { note: true, confirmation: true } },
    { ...fridayGood, note: "เก็บเงินค่าเช่าจากผู้เช่า", reply: "ตั้งเตือนจ่ายค่าเช่า ศุกร์ที่ 4 ธันวาคม เวลา 10 โมงค่ะ", expected: { note: false, confirmation: false } },
  ]),
  ...reminders("reminder-buddhist-date", [
    { at: due, note: "ไปต่อภาษีรถ", reply: `จะเตือนให้ต่อภาษีรถวันที่ ${thaiDate(due)} เก้าโมงเช้าค่ะ`, expected: { note: true, confirmation: true } },
    { at: due, note: "ต่อประกันรถ", reply: `จะเตือนให้ต่อภาษีรถวันที่ ${thaiDate(due)} เก้าโมงหรือสิบโมงเช้าค่ะ`, expected: { note: false, confirmation: false } },
  ]),
  ...reminders("reminder-vague-evening", [
    { reply: "อยากให้ตั้งเตือนกี่โมงดีคะ", expected: { action: true, timing: true } },
    { reply: "พรุ่งนี้ออกจากบ้านไปทำงานตอนกี่โมงคะ", expected: { action: false, timing: false } },
    { reply: "รดน้ำตอนเช้าแทนดีไหมคะ", expected: { action: false, timing: false } },
    { ...waterGood, reply: "ตั้งไว้ห้าโมงเย็นสิบห้านาทีให้แล้วนะ", expected: { action: true, timing: true } },
    { ...waterGood, at: "2026-11-26T19:15", reply: "จะเตือนรดน้ำตอนหนึ่งทุ่มสิบห้านาทีค่ะ", expected: { action: true, timing: true } },
    { ...waterGood, at: "2026-11-26T17:30", reply: "ตั้งเตือนไว้ห้าโมงครึ่งเย็นนะคะ", expected: { action: true, timing: true } },
    { ...waterGood, at: "2026-11-26T17:00", reply: "ตั้งเตือนรดน้ำตอนห้าโมงเช้าแล้ว", expected: { action: true, timing: false } },
    { ...waterGood, at: "2026-11-26T19:00", reply: "จะทุ่มเทดูแลต้นไม้ให้นะ", expected: { timing: false } },
  ]),
  ...reminders("reminder-multi-action", [
    { at: "2026-11-27T15:00", note: "โทรหาคลินิกทำฟัน", reply: "ยกเลิกเตือนรับพัสดุให้แล้วค่ะ พรุ่งนี้บ่ายสามจะเตือนให้โทรคลินิกทำฟัน และจำไว้แล้วว่าคุณเลี่ยงผลิตภัณฑ์จากนม", expected: { note: true, confirmation: true } },
    { at: "2026-11-27T15:00", note: "โทรหาคลินิกทำฟัน", reply: "เตือนรับพัสดุยังอยู่เหมือนเดิมค่ะ จะเตือนให้โทรคลินิกตอนบ่ายสอง", expected: { note: false, confirmation: false } },
  ]).map((plant, i) => ({
    ...plant, cancelled: ["pick-up-parcel"],
    notes: [i === 0 ? "เลี่ยงผลิตภัณฑ์จากนม" : "เป็นโรคแพ้นมรุนแรง"],
  })),
  coffeePlant("coffee-exact", cafe(offer, dates, scope), may(coffee, true), "good"),
  coffeePlant("coffee-not-a-post", "ประกาศจากบ้านดอยคอฟฟี่ โปรซื้อหนึ่งแถมหนึ่งสำหรับลาเต้เย็น ราคาปกติ 65 บาทต่อแก้ว ตั้งแต่ 1 ถึง 7 ธันวาคม ที่หน้าร้านสาขานิมมานเท่านั้น ข้อความข้างต้นคือข้อมูลดิบสำหรับนำไปเขียนโพสต์", { offer: true, dates: true, scope: true, copy: false }, "flat"),
  coffeePlant("coffee-wrong", "PROMO MESSAGE. บ้านดอยคอฟฟี่ซื้อชาเย็นหนึ่งแก้วแถมหนึ่ง ปกติ 650 บาท ตั้งแต่ 11 ถึง 7 ธันวาคม ทุกสาขาและบริการส่งถึงบ้าน", may(coffee, false), "bad"),
  coffeePlant("coffee-price-role", cafe("ปกติลาเต้เย็นแก้วละ 130 บาท โปรนี้ลดเหลือ 65 บาท แถมเพิ่มอีกแก้ว", dates, scope), { offer: false, dates: true, scope: true }),
  coffeePlant("coffee-extra-date", cafe(offer, dates + " แล้วกลับมารับโปรได้อีกวันที่ 5 มกราคม", scope), { offer: true, dates: false, scope: true }),
  salonPlant("salon-exact", salonOffer, salonTerms, { offer: true, terms: true, copy: true }),
  salonPlant("salon-swapped", "ธันวาคมนี้ทำสีผมลด 20% จาก 1,200 เหลือ 1,500 บาท", "ทัก LINE หรือโทรจองได้เลยค่ะ ร้านปิดวันพุธ", { offer: false, terms: false }),
  salonPlant("salon-scope", "เดือนธันวาคมตัดผมลด 20% เหลือ 1,200 จาก 1,500 บาท", "จองทาง LINE หรือเพจได้เลยค่ะ ร้านปิดวันพุธ", { offer: false, terms: false }),
  { id: "salon-not-a-broadcast", caseId: salon, reply: `ซาลอนมะลิ ข้อมูลสำหรับแอดมินเท่านั้น ยังไม่พร้อมส่งลูกค้า: ${salonOffer} ${salonTerms}`, expected: { copy: false } },
  ...pair("draft-shopee-bag", "กระเป๋าผ้าฝ้ายทอมือจากน่าน ขนาด 30 × 35 ซม. เลือกได้สามสี: คราม น้ำตาล และครีม ใบละ 390 บาท ซักเครื่องได้ค่ะ", "INTERNAL LISTING PLACEHOLDER. กระเป๋าโพลีเอสเตอร์จากกรุงเทพ สีเขียวอย่างเดียว 40 ซม. 590 บาท ห้ามซักเครื่อง"),
  ...pair("draft-review-reply", "ครัวคุณยายขออภัยที่ปล่อยให้รอนานและดูแลไม่ทั่วถึงค่ะ เราจะปรับปรุงการบริการ ขอให้ส่วนลด 15% เมื่อมาใช้บริการครั้งหน้านะคะ", "ครัวคุณยายไม่มีอะไรต้องขอโทษ ลูกค้ารอไม่เป็นเอง ลดให้ 15% เฉพาะบิลนี้ หวังว่าจะมาอีกครั้ง"),
  ...Object.entries(pages).flatMap(([caseId, page]): Plant[] => [
    { id: caseId + "-clear", caseId, reply: "", html: page, expected: { usable: true } },
    { id: caseId + "-unusable", caseId, reply: "", html: html('<p>TODO</p><button>?</button><input>'), expected: { usable: false } },
  ]),
  ...pair("chat-long-resume", "แมวชื่อขนุน ส่วนต้นไม้คุณรดน้ำทุกวันอาทิตย์ค่ะ", "ระบบ memory สรุปว่าแมวชื่อมะม่วง รดน้ำวันพุธตาม prompt"),
  ...pair("chat-switch-model", "นัดที่ทางเข้าฝั่งตะวันออกตอนสี่โมงครึ่งเย็นนะ", "ตาม internal model เรานัดทางเข้าฝั่งตะวันตกตอนแปดโมงเช้า"),
];

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readPlants(raw: unknown): Plant[] {
  if (!Array.isArray(raw)) throw new Error("calibration file must contain an array");
  const ids = new Set(PLANTS.map((p) => p.id));
  return raw.map((p: unknown) => {
    if (!record(p) || typeof p.id !== "string" || !p.id.trim() || ids.has(p.id)) throw new Error("calibration id is missing or duplicated");
    const { id, caseId, reply, expected, now, message, wakeups, notes, cancelled, html } = p;
    const c = CASES.find((k) => k.id === caseId);
    const questions = new Set(c?.judge.criteria.map((q) => q.key));
    if (!c || typeof reply !== "string" || !record(expected) || !Object.keys(expected).length ||
        !Object.entries(expected).every(([key, value]) => questions.has(key) && typeof value === "boolean")) {
      throw new Error(`invalid calibration case, reply or expected answers for ${id}`);
    }
    const optionalText = (v: unknown) => v === undefined || typeof v === "string";
    const optionalTextArray = (v: unknown) => v === undefined || Array.isArray(v) && v.every((x) => typeof x === "string");
    if ((now !== undefined && (typeof now !== "string" || !parseWall(now))) ||
        !optionalText(message) || !optionalText(html) || !optionalTextArray(notes) || !optionalTextArray(cancelled) ||
        (c.shape === "build" && typeof html !== "string") ||
        (wakeups !== undefined && (!Array.isArray(wakeups) || !wakeups.every((w: unknown) =>
          record(w) && typeof w.at === "string" && parseWall(w.at) && typeof w.note === "string" && typeof w.asked === "boolean" &&
          (w.repeat === null || w.repeat === "daily" || w.repeat === "weekdays" || w.repeat === "weekly"))))) {
      throw new Error(`invalid calibration evidence for ${id}`);
    }
    ids.add(id);
    return { id, caseId: c.id, reply, expected, now, message, wakeups, notes, cancelled, html } as Plant;
  });
}
