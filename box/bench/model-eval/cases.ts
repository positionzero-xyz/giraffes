import type { Case, Check, Phrase, Reading, Repeat, Rubric, Shape, Wall } from "./types.ts";
import { addMinutes, dateOf, dayAt, nextWeekReadings, thaiDate, weeklyReadings } from "./when.ts";

const p = (label: string, ...any: string[]): Phrase => ({ label, any });
const judge = (questions: Record<string, string>): Rubric => ({
  criteria: Object.entries(questions).map(([key, ask]) => ({ key, ask })),
});

const natural = "Does it read as natural Thai suited to this conversation, without exposing assistant internals?";
const answer = (helpful: string) => judge({ helpful, natural });
const reminder = (note: string, confirmation: string) => judge({ note, confirmation });
const PRODUCT: readonly Check[] = [{ kind: "replies" }, { kind: "fits_reply" }, { kind: "stops_clean" }];
const CHAT: readonly Check[] = [...PRODUCT, { kind: "thai", min: 0.8 }];
const REMINDER: readonly Check[] = [...PRODUCT, { kind: "thai", min: 0.6 }];
const DRAFT = (min: number, max: number): readonly Check[] => [{ kind: "thai", min: 0.85 }, { kind: "length", min, max }];
const BUILD: readonly Check[] = [{ kind: "file", path: "index.html" }, { kind: "loads_clean" }];

const fixed = (message: string, checks: readonly Check[]) => () => ({ message, checks });

function scheduled(message: string, due: (now: Wall) => readonly Reading[], repeat: Repeat | null = null): Case["make"] {
  return (now) => ({ message, checks: [...REMINDER, { kind: "due_at", readings: due(now), repeat }] });
}

const evening = { fromHour: 16, toHour: 20 } as const;
export const CANCEL_KEY = "pick-up-parcel";

export const ORDER_MENU = [
  { label: "basil chicken", any: ["กะเพราไก่", "กระเพราไก่"], price: 70 },
  { label: "cocoa", any: ["โกโก้เย็น", "โกโก้"], price: 45 },
] as const;

export const CASES: readonly Case[] = [
  {
    id: "chat-advice", shape: "chat",
    brief: "Desk worker with a sore neck and shoulders wants simple stretches they can do at their desk.",
    judge: answer("Does it give at least one gentle desk stretch with clear instructions and a sensible hold time or repetition count?"),
    make: fixed("นั่งทำงานหน้าคอมทั้งวันจนปวดคอกับไหล่มากเลย มีท่ายืดง่ายๆ ที่ทำที่โต๊ะได้ไหม", CHAT),
  },
  {
    id: "chat-explain", shape: "chat",
    brief: "Explain compound interest in simple terms and contrast it with simple interest.",
    judge: answer("Does it explain that compound interest earns interest on prior interest, while simple interest uses only the original principal?"),
    make: fixed("ช่วยอธิบายแบบง่ายๆ หน่อยว่าดอกเบี้ยทบต้นคืออะไร ต่างจากดอกเบี้ยธรรมดายังไง", CHAT),
  },
  {
    id: "chat-stressed", shape: "chat",
    brief: "They were publicly criticised by their boss, left work unfinished, and dread going back tomorrow.",
    judge: answer("Does it acknowledge what happened and respond supportively without blaming the person or dismissing how they feel?"),
    make: fixed("วันนี้แย่มากเลย โดนหัวหน้าต่อว่าต่อหน้าคนอื่น งานก็ไม่เสร็จ รู้สึกไม่อยากไปทำงานพรุ่งนี้แล้ว", CHAT),
  },
  {
    id: "chat-slang", shape: "chat",
    brief: "They are bored and want something to do on a tight budget. They text very casually.",
    judge: answer("Does it offer at least one concrete, free or inexpensive idea the person could act on now?"),
    make: fixed("ว่างจัดอะ เบื่อมากกก มีไรทำแก้เซ็งบ้างป่ะ งบน้อยด้วยนะ 555", CHAT),
  },
  {
    id: "reminder-in-20", shape: "reminder",
    brief: "Remind the person in 20 minutes to switch off the gas stove.",
    judge: reminder(
      "Does the saved reminder tell the assistant to switch the stove off or remind the person to do so?",
      "Does the reply confirm one reminder for switching off the stove in 20 minutes, with any date, weekday or clock time agreeing with the scheduled time?",
    ),
    make: scheduled("อีก 20 นาทีเตือนให้ไปปิดเตาแก๊สด้วยนะ", (now) => [{ label: "in 20 minutes", at: addMinutes(now, 20) }]),
  },
  {
    id: "reminder-tomorrow-2pm", shape: "reminder",
    brief: "Remind the person tomorrow at 14:00 to phone their dental clinic.",
    judge: reminder(
      "Does the saved reminder request a phone call to the dental clinic?",
      "Does the reply confirm the clinic reminder for tomorrow at 14:00 and avoid giving a conflicting date, weekday or second time?",
    ),
    make: scheduled("พรุ่งนี้บ่ายสองเตือนให้โทรหาคลินิกทำฟันหน่อย", (now) => [{ label: "tomorrow 14:00", at: dayAt(now, 1, "14:00") }]),
  },
  {
    id: "reminder-every-monday", shape: "reminder",
    brief: "Set a weekly reminder to send a report to the person's boss every Monday at 08:00.",
    judge: reminder(
      "Does the saved note say to send the report to the boss?",
      "Does the reply confirm every Monday at 08:00, with any stated start date matching the saved first occurrence and no other time or cadence?",
    ),
    make: scheduled("ช่วยเตือนส่งรายงานให้หัวหน้าทุกวันจันทร์ 8 โมงเช้าหน่อย", (now) => weeklyReadings(now, 0, "08:00"), "weekly"),
  },
  {
    id: "reminder-next-friday", shape: "reminder",
    brief: "Remind the person next Friday at 10:00 to pay the rent.",
    judge: reminder(
      "Does the saved note say to pay the room rent?",
      "Does the reply confirm a single Friday at 10:00 for paying rent, with its date or relative wording consistent with the actual scheduled Friday?",
    ),
    make: scheduled("วันศุกร์หน้าเตือนให้จ่ายค่าเช่าห้องตอน 10 โมงเช้าด้วย", (now) => nextWeekReadings(now, 4, "10:00")),
  },
  {
    id: "reminder-buddhist-date", shape: "reminder",
    brief: "The person gives a Buddhist-calendar date at 09:00 for a car tax renewal reminder.",
    judge: reminder(
      "Does the saved note tell the person to renew their vehicle tax?",
      "Does the reply confirm the requested car-tax reminder at 09:00, on the same calendar day as the scheduled reminder, with no conflicting weekday or time?",
    ),
    make: (now) => {
      const due = dayAt(now, 20, "09:00");
      return {
        message: `วันที่ ${thaiDate(due)} ช่วยเตือนให้ไปต่อภาษีรถตอน 9 โมงเช้านะ`,
        checks: [...REMINDER, { kind: "due_at", readings: [{ label: "the Buddhist-era date", at: due }], repeat: null }],
      };
    },
  },
  {
    id: "reminder-vague-evening", shape: "reminder",
    brief: "The person asks for an evening reminder to water their plants without giving a time.",
    judge: judge({
      action: "If there is no saved reminder, does the reply ask when to send this reminder? It can rely on the current context or propose an evening time for the person to confirm. If there is a saved reminder, does its note say to water the plants?",
      timing: "If a reminder was saved, does the reply state its actual evening time as the chosen time with no conflicting date or other time? If none was saved, is the reply an open time clarification or an evening-time proposal without claiming anything was set?",
    }),
    make: (now) => ({
      message: "ตอนเย็นเตือนให้รดน้ำต้นไม้ด้วยนะ",
      checks: [...REMINDER, { kind: "asks_or_assumes", date: dateOf(Number(now.slice(11, 13)) < evening.toHour ? now : dayAt(now, 1, "00:00")), ...evening }],
    }),
  },
  {
    id: "reminder-multi-action", shape: "reminder", setup: "parcel",
    brief: "There is a parcel-pickup reminder tomorrow at 13:00. Set a dentist-call reminder tomorrow at 15:00, cancel the parcel reminder, and remember that the person avoids dairy.",
    judge: judge({
      note: "Does the saved reminder say to call the dental clinic, and does the saved memory say the person avoids dairy without adding a medical diagnosis?",
      confirmation: "Does the reply confirm the parcel reminder was cancelled, the dental call was scheduled tomorrow at 15:00, and the dairy preference was saved, with no contradictory claim?",
    }),
    make: (now) => ({
      message: "พรุ่งนี้บ่ายสามเตือนให้โทรหาคลินิกทำฟันหน่อย ยกเลิกเตือนรับพัสดุอันเดิมด้วย แล้วช่วยจำไว้ว่าฉันเลี่ยงผลิตภัณฑ์จากนมนะ",
      checks: [...REMINDER, {
        kind: "due_at", readings: [{ label: "tomorrow 15:00", at: dayAt(now, 1, "15:00") }],
        repeat: null, cancel: CANCEL_KEY, notes: 1,
      }],
    }),
  },
  {
    id: "draft-facebook-coffee", shape: "draft",
    brief: "Facebook post for Baan Doi Coffee. Buy one iced latte and get another free. The usual price is 65 baht per cup. In store at Nimman only, 1–7 December.",
    judge: judge({
      offer: "Does it name the shop and offer a free iced latte with the purchase of one iced latte, making 65 baht the normal price per cup and giving no alternative prices that contradict that?",
      dates: "Does the offer run from 1 through 7 December with no additional or contradictory dates?",
      scope: "Does it restrict the offer to in-person purchases at the Nimman branch, with no other branch, delivery option or contradictory promise?",
      copy: "Does the post sound natural in Thai and give Facebook readers a clear reason to visit?",
    }),
    make: fixed("ช่วยเขียนโพสต์เฟซบุ๊กโปรโมชันให้ร้านกาแฟหน่อย ร้านชื่อ 'บ้านดอยคอฟฟี่' โปรคือซื้อลาเต้เย็น 1 แก้วแถม 1 แก้ว ปกติแก้วละ 65 บาท ใช้ได้วันที่ 1-7 ธันวาคม เฉพาะหน้าร้าน สาขานิมมาน", DRAFT(150, 1200)),
  },
  {
    id: "draft-line-salon", shape: "draft",
    brief: "Mali Salon LINE broadcast. In December, colour services are 20% off, from 1,500 to 1,200 baht. Book ahead via LINE only. Closed Wednesdays.",
    judge: judge({
      offer: "Does it put the discount on hair colouring in December, with 20% off and 1,500 baht as the original price and 1,200 baht as the offer price?",
      terms: "Does it name the salon, require advance booking through LINE alone, and say the salon is closed every Wednesday without contradicting those terms?",
      copy: "Is it a natural Thai LINE broadcast with a clear invitation to book?",
    }),
    make: fixed("เขียนข้อความบรอดแคสต์ LINE OA ให้ร้านทำผม 'ซาลอนมะลิ' หน่อย บอกลูกค้าว่าเดือนธันวาคมทำสีผมลด 20% จาก 1,500 เหลือ 1,200 บาท ต้องจองล่วงหน้าทาง LINE เท่านั้น ร้านปิดทุกวันพุธ", DRAFT(100, 800)),
  },
  {
    id: "draft-shopee-bag", shape: "draft",
    brief: "Shopee listing for a hand-woven cotton bag from Nan. Size 30 by 35 centimetres. Indigo, brown and cream. 390 baht. Machine-washable.",
    judge: judge({
      product: "Does it identify a hand-woven cotton bag from Nan, with dimensions 30 by 35 centimetres and exactly indigo, brown and cream as the available colours?",
      terms: "Does it give 390 baht as the price and say the bag is machine-washable, with no contradictory price, care instruction or unsupported product claim?",
      copy: "Would the natural Thai and organisation work as a useful Shopee listing for someone deciding whether to buy?",
    }),
    make: fixed("ช่วยเขียนคำอธิบายสินค้าลง Shopee ให้หน่อย สินค้าคือกระเป๋าผ้าฝ้ายทอมือจากน่าน ขนาด 30x35 ซม. มี 3 สี คือ คราม น้ำตาล ครีม ราคา 390 บาท ซักเครื่องได้", DRAFT(150, 1500)),
  },
  {
    id: "draft-review-reply", shape: "draft",
    brief: "Khrua Khun Yai restaurant replies to a one-star review about an almost hour-long wait and inattentive staff. Apologise and offer 15% off the next visit.",
    judge: judge({
      apology: "Does it speak for the named restaurant, apologise for the long wait and for inattentive service, and stay polite without blaming the reviewer?",
      offer: "Does it attach the 15% discount to the customer's next visit, with no other or conflicting condition?",
    }),
    make: fixed("มีลูกค้ารีวิว 1 ดาวว่า 'รอข้าวนานเกือบชั่วโมง พนักงานไม่สนใจ' ช่วยร่างคำตอบแบบสุภาพให้ร้านหน่อย ร้านชื่อ 'ครัวคุณยาย' อยากขอโทษและให้ส่วนลด 15% ครั้งหน้า", DRAFT(80, 800)),
  },
  {
    id: "build-noodle-menu", shape: "build",
    brief: "A one-page Thai menu for Jae Muay boat noodles, with four dishes and their baht prices.",
    judge: judge({ usable: "Would a Thai-speaking customer be able to scan the page as a shop menu and easily tell what each price belongs to?" }),
    make: fixed("ช่วยทำหน้าเว็บเมนูร้านก๋วยเตี๋ยวเรือ 'เจ๊หมวย' หน้าเดียวให้หน่อย มี ก๋วยเตี๋ยวเรือหมู 50 บาท, ก๋วยเตี๋ยวเรือเนื้อ 60 บาท, เกาเหลา 55 บาท, ชาเย็น 25 บาท", [
      ...BUILD, { kind: "page_has", items: [p("shop name", "เจ๊หมวย")] },
      { kind: "priced", items: [
        { ...p("pork", "เรือหมู"), price: 50 },
        { ...p("beef", "เรือเนื้อ"), price: 60 },
        { ...p("soup", "เกาเหลา"), price: 55 },
        { ...p("iced tea", "ชาเย็น"), price: 25 },
      ] },
    ]),
  },
  {
    id: "build-booking-form", shape: "build",
    brief: "A Thai massage booking form that saves the customer's name, phone, date and time on the device.",
    judge: judge({ usable: "Can a Thai-speaking customer understand the labelled booking form and tell when their booking has been saved?" }),
    make: fixed("ทำฟอร์มจองคิวร้านนวดให้หน่อย ให้กรอกชื่อ เบอร์โทร วันที่ และเวลา กดจองแล้วบันทึกเก็บไว้ในเครื่อง ปิดแล้วเปิดใหม่ข้อมูลต้องยังอยู่", [
      ...BUILD, { kind: "persists", drive: "booking", shown: false },
    ]),
  },
  {
    id: "build-expense-tracker", shape: "build",
    brief: "A Thai expense tracker to enter an item and an amount, view the total, and reopen the data.",
    judge: judge({ usable: "Are the item field, amount field, save action, list and total clear enough for a Thai speaker to use every day?" }),
    make: fixed("ทำเว็บจดรายจ่ายเล็กๆ ให้หน่อย ใส่รายการกับจำนวนเงิน แล้วโชว์ยอดรวม ข้อมูลเก็บไว้ในเครื่อง เปิดใหม่ก็ยังอยู่", [
      ...BUILD, { kind: "persists", drive: "expense", shown: true }, { kind: "total_adds" },
    ]),
  },
  {
    id: "build-menu-order", shape: "build",
    brief: "A small Thai café page with a menu view and a linked order view. Add basil chicken and iced cocoa to an order and show a running total.",
    judge: judge({ usable: "Can a customer understand how to move between the Thai menu and their order, add a dish, and see the items and amount due without guessing?" }),
    make: fixed("ทำเว็บร้านอาหารเล็กๆ มีหน้าเมนูกับหน้ารายการที่เลือก สลับไปมาได้ เมนูมีกะเพราไก่ 70 บาท กับโกโก้เย็น 45 บาท กดเพิ่มแต่ละเมนูได้ แล้วดูรายการที่เลือกกับยอดที่เปลี่ยนตามของที่เพิ่มได้เลย", [
      ...BUILD, { kind: "priced", items: ORDER_MENU }, { kind: "order_flow" },
    ]),
  },
  {
    id: "chat-long-resume", shape: "chat", setup: "long",
    brief: "Recall that their cat is named ขนุน and their plant-watering day is Sunday. Both facts were given in earlier messages.",
    judge: answer("Does it correctly recall the cat's name ขนุน and Sunday as plant-watering day, without guessing a different name or day?"),
    make: fixed("ที่เคยบอกไว้ แมวฉันชื่ออะไร แล้วฉันรดน้ำต้นไม้วันไหนนะ", CHAT),
  },
  {
    id: "chat-switch-model", shape: "chat", setup: "switch",
    brief: "Recall the person's chosen meeting point, the east entrance, and time, 16:30, from the previous message.",
    judge: answer("Does it recall the east entrance at 16:30 without giving a conflicting entrance or time?"),
    make: fixed("สรุปให้ทีว่าเมื่อกี้นัดเจอกันตรงไหน กี่โมงนะ", CHAT),
  },
];

export const BUILD_SYSTEM = `You are Giraffe, a personal assistant that a person texts. They asked you to make a small web page.
Write it as one self-contained file named index.html in the current folder, with its CSS and JavaScript inside it.
Don't ask questions; make sensible choices. When you are done, reply with one short message to the person in their language.`;

export function selectCases(shapes: readonly Shape[], ids: readonly string[] | number | null, long = false): Case[] {
  const available = CASES.filter((c) => long || (c.setup !== "long" && c.setup !== "switch"));
  const inShapes = available.filter((c) => shapes.includes(c.shape));
  if (ids === null) return inShapes;
  if (typeof ids === "number") return shapes.flatMap((s) => inShapes.filter((c) => c.shape === s).slice(0, ids));
  const unknown = ids.filter((id) => !available.some((c) => c.id === id));
  if (unknown.length) throw new Error(`case unavailable: ${unknown.join(", ")} (session cases need --long)`);
  return inShapes.filter((c) => ids.includes(c.id));
}
