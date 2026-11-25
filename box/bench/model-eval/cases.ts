import type { Case, Check, Phrase, Rubric, Shape, Wall } from "./types.ts";
import { addMinutes, dateOf, dayAt, nextWeekReadings, nextWeekday, thaiDate } from "./when.ts";

const p = (label: string, ...any: string[]): Phrase => ({ label, any });

const CHAT: readonly Check[] = [{ kind: "thai", min: 0.8 }, { kind: "no_jargon" }, { kind: "fits_reply" }, { kind: "worker_accepts" }];
const REMINDER: readonly Check[] = [{ kind: "thai", min: 0.6 }, { kind: "no_jargon" }, { kind: "fits_reply" }, { kind: "worker_accepts" }];
const DRAFT = (min: number, max: number): Check[] => [{ kind: "thai", min: 0.85 }, { kind: "length", min, max }];
const BUILD = (items: readonly Phrase[]): Check[] => [
  { kind: "file", path: "index.html" },
  { kind: "html_complete", path: "index.html" },
  { kind: "page_has", items },
  { kind: "loads_clean" },
];

const fixed = (message: string, checks: readonly Check[]) => () => ({ message, checks });

const EVENING = { fromHour: 16, toHour: 20 } as const;
/** "This evening" asked once the evening is over means tomorrow's. */
const eveningDate = (now: Wall, toHour: number) => dateOf(Number(now.slice(11, 13)) < toHour ? now : dayAt(now, 1, "00:00"));

export const CASES: readonly Case[] = [
  {
    id: "chat-advice",
    shape: "chat",
    brief: "Neck and shoulder pain from sitting at a desk all day; wants simple stretches to do at the desk.",
    judged: true,
    make: fixed("นั่งทำงานหน้าคอมทั้งวันจนปวดคอกับไหล่มากเลย มีท่ายืดง่ายๆ ที่ทำที่โต๊ะได้ไหม", [
      ...CHAT,
      { kind: "mentions", what: "how long or how often", any: ["วินาที", "ครั้ง", "ค้างไว้", "นาที", "รอบ"] },
    ]),
  },
  {
    id: "chat-explain",
    shape: "chat",
    brief: "Wants compound interest explained simply, and how it differs from simple interest.",
    judged: true,
    make: fixed("ช่วยอธิบายแบบง่ายๆ หน่อยว่าดอกเบี้ยทบต้นคืออะไร ต่างจากดอกเบี้ยธรรมดายังไง", [
      ...CHAT,
      { kind: "mentions", what: "interest joins the principal", any: ["เงินต้น", "ดอกเบี้ยของดอกเบี้ย", "ทบเข้า", "รวมเข้า", "บวกเข้า"] },
    ]),
  },
  {
    id: "chat-stressed",
    shape: "chat",
    brief: "Had an awful day: told off by the boss in front of others, work unfinished, doesn't want to go in tomorrow.",
    judged: true,
    make: fixed("วันนี้แย่มากเลย โดนหัวหน้าต่อว่าต่อหน้าคนอื่น งานก็ไม่เสร็จ รู้สึกไม่อยากไปทำงานพรุ่งนี้แล้ว", [
      ...CHAT,
      { kind: "mentions", what: "acknowledges the feeling", any: ["เข้าใจ", "ไม่แปลก", "เหนื่อย", "แย่", "รู้สึก", "เสียใจ", "หนัก"] },
    ]),
  },
  {
    id: "chat-slang",
    shape: "chat",
    brief: "Casual slang: bored with free time and little money, wants ideas to cure boredom.",
    judged: true,
    make: fixed("ว่างจัดอะ เบื่อมากกก มีไรทำแก้เซ็งบ้างป่ะ งบน้อยด้วยนะ 555", [
      ...CHAT,
      { kind: "mentions", what: "suggests something", any: ["ซีรีส์", "หนัง", "เดิน", "สวน", "ทำอาหาร", "เกม", "เพลง", "คาเฟ่", "ออกกำลัง", "วาด", "อ่าน", "ปั่น", "ห้องสมุด"] },
    ]),
  },
  {
    id: "reminder-in-20",
    shape: "reminder",
    brief: "Remind me in 20 minutes to turn off the gas stove.",
    judged: false,
    make: (now) => ({
      message: "อีก 20 นาทีเตือนให้ไปปิดเตาแก๊สด้วยนะ",
      checks: [...REMINDER, { kind: "due_at", readings: [{ label: "in 20 minutes", at: addMinutes(now, 20) }], repeat: null, about: ["เตา", "แก๊ส", "gas", "stove"] }],
    }),
  },
  {
    id: "reminder-tomorrow-2pm",
    shape: "reminder",
    brief: "Tomorrow at 2 pm, remind me to call the dental clinic.",
    judged: false,
    make: (now) => ({
      message: "พรุ่งนี้บ่ายสองเตือนให้โทรหาคลินิกทำฟันหน่อย",
      checks: [...REMINDER, { kind: "due_at", readings: [{ label: "tomorrow 14:00", at: dayAt(now, 1, "14:00") }], repeat: null, about: ["คลินิก", "ฟัน", "clinic", "dentist", "dental"] }],
    }),
  },
  {
    id: "reminder-every-monday",
    shape: "reminder",
    brief: "Every Monday at 8 am, remind me to send my report to my boss.",
    judged: false,
    make: (now) => ({
      message: "ช่วยเตือนส่งรายงานให้หัวหน้าทุกวันจันทร์ 8 โมงเช้าหน่อย",
      checks: [...REMINDER, { kind: "due_at", readings: [{ label: "next Monday 08:00", at: nextWeekday(now, 0, "08:00") }], repeat: "weekly", about: ["รายงาน", "report"] }],
    }),
  },
  {
    id: "reminder-next-friday",
    shape: "reminder",
    brief: "Next Friday at 10 am, remind me to pay the room rent.",
    judged: false,
    make: (now) => ({
      message: "วันศุกร์หน้าเตือนให้จ่ายค่าเช่าห้องตอน 10 โมงเช้าด้วย",
      checks: [...REMINDER, { kind: "due_at", readings: nextWeekReadings(now, 4, "10:00"), repeat: null, about: ["ค่าเช่า", "ค่าห้อง", "rent"] }],
    }),
  },
  {
    id: "reminder-buddhist-date",
    shape: "reminder",
    brief: "On a date written in the Buddhist era, at 9 am, remind me to renew my car tax.",
    judged: false,
    make: (now) => {
      const due = dayAt(now, 20, "09:00");
      return {
        message: `วันที่ ${thaiDate(due)} ช่วยเตือนให้ไปต่อภาษีรถตอน 9 โมงเช้านะ`,
        checks: [...REMINDER, { kind: "due_at", readings: [{ label: "the Buddhist-era date", at: due }], repeat: null, about: ["ภาษี", "tax"] }],
      };
    },
  },
  {
    id: "reminder-vague-evening",
    shape: "reminder",
    brief: "This evening, remind me to water the plants (no time given).",
    judged: false,
    make: (now) => ({
      message: "ตอนเย็นเตือนให้รดน้ำต้นไม้ด้วยนะ",
      checks: [...REMINDER, { kind: "asks_or_assumes", date: eveningDate(now, EVENING.toHour), ...EVENING, about: ["รดน้ำ", "ต้นไม้", "water", "plant"] }],
    }),
  },
  {
    id: "draft-facebook-coffee",
    shape: "draft",
    brief: "A Facebook post for a coffee shop promotion: Baan Doi Coffee, buy one iced latte get one free, normally 65 baht a cup, 1 to 7 December, in store only, Nimman branch.",
    judged: true,
    make: fixed(
      "ช่วยเขียนโพสต์เฟซบุ๊กโปรโมชันให้ร้านกาแฟหน่อย ร้านชื่อ 'บ้านดอยคอฟฟี่' โปรคือซื้อลาเต้เย็น 1 แก้วแถม 1 แก้ว ปกติแก้วละ 65 บาท ใช้ได้วันที่ 1-7 ธันวาคม เฉพาะหน้าร้าน สาขานิมมาน",
      [
        ...DRAFT(150, 1200),
        {
          kind: "facts",
          facts: [
            p("shop name", "บ้านดอยคอฟฟี่"),
            p("buy one get one", "1แถม1", "1แก้วแถม1", "แถมอีก1", "ฟรีอีก1", "ฟรี1แก้ว"),
            p("price 65", "65"),
            p("1 to 7 December", "1-7ธ", "1ถึง7ธ", "1ธ.ค.-7ธ.ค", "1ธันวาคม-7ธันวาคม", "1-7ธันวา"),
            p("in store only", "หน้าร้าน"),
            p("Nimman branch", "นิมมาน"),
          ],
        },
      ],
    ),
  },
  {
    id: "draft-line-salon",
    shape: "draft",
    brief: "A LINE broadcast for Mali Salon: hair colouring 20% off in December, 1,500 down to 1,200 baht, booking only through LINE, closed every Wednesday.",
    judged: true,
    make: fixed(
      "เขียนข้อความบรอดแคสต์ LINE OA ให้ร้านทำผม 'ซาลอนมะลิ' หน่อย บอกลูกค้าว่าเดือนธันวาคมทำสีผมลด 20% จาก 1,500 เหลือ 1,200 บาท ต้องจองล่วงหน้าทาง LINE เท่านั้น ร้านปิดทุกวันพุธ",
      [
        ...DRAFT(100, 800),
        {
          kind: "facts",
          facts: [
            p("salon name", "ซาลอนมะลิ"),
            p("20% off", "20%", "ลด20"),
            p("was 1,500", "1,500", "1500"),
            p("now 1,200", "1,200", "1200"),
            p("book ahead", "จอง"),
            p("closed Wednesdays", "พุธ"),
          ],
        },
      ],
    ),
  },
  {
    id: "draft-shopee-bag",
    shape: "draft",
    brief: "A Shopee product description: hand-woven cotton bag from Nan, 30 x 35 cm, three colours (indigo, brown, cream), 390 baht, machine washable.",
    judged: true,
    make: fixed(
      "ช่วยเขียนคำอธิบายสินค้าลง Shopee ให้หน่อย สินค้าคือกระเป๋าผ้าฝ้ายทอมือจากน่าน ขนาด 30x35 ซม. มี 3 สี คือ คราม น้ำตาล ครีม ราคา 390 บาท ซักเครื่องได้",
      [
        ...DRAFT(150, 1500),
        {
          kind: "facts",
          facts: [
            p("cotton", "ฝ้าย"),
            p("hand-woven", "ทอมือ"),
            p("from Nan", "น่าน"),
            p("30 x 35 cm", "30x35", "30×35", "30*35"),
            p("indigo", "คราม"),
            p("brown", "น้ำตาล"),
            p("cream", "ครีม"),
            p("390 baht", "390"),
            p("machine washable", "ซักเครื่อง"),
          ],
        },
      ],
    ),
  },
  {
    id: "draft-review-reply",
    shape: "draft",
    brief: "A polite reply from Khrua Khun Yai restaurant to a 1-star review ('waited almost an hour, staff ignored us'): apologise and offer 15% off next visit.",
    judged: true,
    make: fixed(
      "มีลูกค้ารีวิว 1 ดาวว่า 'รอข้าวนานเกือบชั่วโมง พนักงานไม่สนใจ' ช่วยร่างคำตอบแบบสุภาพให้ร้านหน่อย ร้านชื่อ 'ครัวคุณยาย' อยากขอโทษและให้ส่วนลด 15% ครั้งหน้า",
      [...DRAFT(80, 800), { kind: "facts", facts: [p("apology", "ขอโทษ", "ขออภัย"), p("15% off", "15%", "ลด15"), p("restaurant name", "ครัวคุณยาย")] }],
    ),
  },
  {
    id: "build-noodle-menu",
    shape: "build",
    brief: "A one-page menu for Jae Muay boat noodles: pork boat noodles 50, beef boat noodles 60, soup without noodles 55, Thai iced tea 25 baht.",
    judged: true,
    make: fixed(
      "ช่วยทำหน้าเว็บเมนูร้านก๋วยเตี๋ยวเรือ 'เจ๊หมวย' หน้าเดียวให้หน่อย มี ก๋วยเตี๋ยวเรือหมู 50 บาท, ก๋วยเตี๋ยวเรือเนื้อ 60 บาท, เกาเหลา 55 บาท, ชาเย็น 25 บาท",
      BUILD([p("shop name", "เจ๊หมวย"), p("pork", "เรือหมู"), p("beef", "เรือเนื้อ"), p("soup", "เกาเหลา"), p("iced tea", "ชาเย็น"), p("50", "50"), p("60", "60"), p("55", "55"), p("25", "25")]),
    ),
  },
  {
    id: "build-booking-form",
    shape: "build",
    brief: "A booking form for a massage shop: name, phone, date and time; pressing book saves it on the device so it is still there after closing and reopening.",
    judged: true,
    make: fixed("ทำฟอร์มจองคิวร้านนวดให้หน่อย ให้กรอกชื่อ เบอร์โทร วันที่ และเวลา กดจองแล้วบันทึกเก็บไว้ในเครื่อง ปิดแล้วเปิดใหม่ข้อมูลต้องยังอยู่", [
      ...BUILD([p("name", "ชื่อ"), p("phone", "เบอร์", "โทร"), p("date", "วันที่"), p("time", "เวลา")]),
      { kind: "persists", shown: false },
    ]),
  },
  {
    id: "build-expense-tracker",
    shape: "build",
    brief: "A small expense tracker: enter an item and an amount, show the total, keep the data on the device so it is still there when reopened.",
    judged: true,
    make: fixed("ทำเว็บจดรายจ่ายเล็กๆ ให้หน่อย ใส่รายการกับจำนวนเงิน แล้วโชว์ยอดรวม ข้อมูลเก็บไว้ในเครื่อง เปิดใหม่ก็ยังอยู่", [
      ...BUILD([p("total", "รวม")]),
      { kind: "persists", shown: true },
    ]),
  },
];

export const RUBRICS: Readonly<Record<Shape, Rubric | null>> = {
  chat: {
    criteria: [
      { key: "helpful", ask: "Does it actually help with what the person asked, the way a capable friend would?" },
      { key: "natural_thai", ask: "Does it read like a Thai person texting: natural wording, right register for the person, no translated-English feel?" },
    ],
  },
  reminder: null,
  draft: {
    criteria: [
      { key: "natural_thai", ask: "Does it read like natural Thai a local business would post, with no stray English or stiff phrasing?" },
      { key: "persuasive", ask: "Would it make a customer want to act (visit, book, buy, come back)?" },
      { key: "fits_channel", ask: "Does its length, tone and format fit the channel named in the brief?" },
    ],
  },
  build: {
    criteria: [{ key: "owner_would_use", ask: "Would the shop owner in the brief put this page in front of customers or use it day to day as it is?" }],
  },
};

export const BUILD_SYSTEM = `You are Giraffe, a personal assistant that a person texts. They asked you to make a small web page.
Write it as one self-contained file named index.html in the current folder, with its CSS and JavaScript inside it.
Don't ask questions; make sensible choices. When you are done, reply with one short message to the person in their language.`;

export function selectCases(shapes: readonly Shape[], ids: readonly string[] | number | null): Case[] {
  const inShapes = CASES.filter((c) => shapes.includes(c.shape));
  if (ids === null) return inShapes;
  if (typeof ids === "number") return shapes.flatMap((s) => inShapes.filter((c) => c.shape === s).slice(0, ids));
  const unknown = ids.filter((id) => !CASES.some((c) => c.id === id));
  if (unknown.length) throw new Error(`unknown case ${unknown.join(", ")}`);
  return inShapes.filter((c) => ids.includes(c.id));
}
