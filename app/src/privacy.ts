import { DEDUPE_WINDOW_MS, OUTBOX_KEEP_MS } from "./agent/store";
import { BOX } from "./box/machine";
import type { PrivacyConfig } from "./config";

const DAY_MS = 24 * 60 * 60 * 1000;
const days = (ms: number) => Math.round(ms / DAY_MS);

export const RETENTION_DAYS = {
  sentCopies: days(OUTBOX_KEEP_MS),
  handledIncoming: days(DEDUPE_WINDOW_MS),
  unusedBox: days(BOX.reclaimAfterMs),
} as const;

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

type Section = { readonly heading: string; readonly body: readonly string[] };

function english(controller: string, contact: string): readonly Section[] {
  const r = RETENTION_DAYS;
  return [
    { heading: "Who runs Giraffe", body: [`Giraffe is run by ${controller}. For anything about your data, email ${contact}.`] },
    {
      heading: "What Giraffe keeps",
      body: [
        "Your messages to Giraffe and its replies.",
        "What Giraffe saves to help you: notes, reminders, tasks, plans it proposes, a summary of older chat, and your language, time zone and check-in time.",
        "Your LINE or Telegram user ID. If you connect an AI, your API key (stored encrypted) or the sign-in for your own Claude plan (kept on a private machine Giraffe runs for you on Fly.io).",
        "Usage records: your LINE or Telegram user ID, when you sent messages, how many, what each AI answer cost, how each turn ended, and your sign-up status. These never include your words.",
        "On a paid plan, your plan and subscription status. Stripe handles card details. Giraffe never sees your card number.",
      ],
    },
    {
      heading: "Why",
      body: [
        "To be your assistant: answer you, remember what you ask it to, remind you and check in. To run the service, bill for it and keep it safe.",
        "Giraffe trains no AI model on your data.",
        "Without your messages Giraffe can't help you, and without agreeing to this notice you can't use it.",
      ],
    },
    {
      heading: "Sensitive details",
      body: ["If you tell Giraffe about your health, religion or other sensitive matters, Giraffe keeps them like the rest of your chat, only to help you."],
    },
    {
      heading: "Who else handles your data",
      body: [
        "Cloudflare stores Giraffe's data and runs the service.",
        "The AI you connect receives your messages and what Giraffe has saved, each time it answers: your own AI provider account, or your Claude plan through a private machine on Fly.io. On a plan where Giraffe pays for the AI, it is an AI provider Giraffe chose. Each provider handles data under its own terms.",
        "Fly.io runs the private machine for people who connect a Claude plan. Claude Code's files from your chats stay on it until the machine is removed.",
        "LINE (LY Corporation) or Telegram carries every message, under its own terms.",
        "Stripe processes payments.",
        "Authorities, when the law requires it.",
      ],
    },
    {
      heading: "Outside Thailand",
      body: ["Cloudflare, most AI providers (many are in the USA), Fly.io (Singapore by default) and the chat apps may process your data outside Thailand, where protection may differ from Thailand's."],
    },
    {
      heading: "How long",
      body: [
        "Recent chat is kept word for word. When the chat grows long and an AI is available, older messages are folded into a summary and the originals are deleted.",
        `Copies of messages Giraffe sent you: removed at the first cleanup after ${r.sentCopies} days. Cleanup runs whenever Giraffe handles a message, reminder or check-in for you.`,
        `Incoming messages, after Giraffe has handled them: removed at the first cleanup after ${r.handledIncoming} days. Before you join, Giraffe clears the text of your messages as soon as it has answered.`,
        `The summary, notes, reminders, tasks, plans, settings and usage records: nothing deletes them automatically yet. To ask for them to be deleted, email ${contact}.`,
        `The private machine for a Claude plan, and its files: until you remove the connection, or until Giraffe removes it, when nobody signs in for about ${r.unusedBox} days or when your plan no longer includes it.`,
      ],
    },
    {
      heading: "Your rights",
      body: [
        "You can ask to see your data and get a copy, move it to another service, correct it, delete it, restrict or object to its use, and withdraw your consent at any time. Withdrawing doesn't undo what was done before, and after it Giraffe can't keep helping you.",
        `Send /memory in the chat to see your notes, reminders and tasks. For anything else, email ${contact}. We answer within 30 days.`,
        "You can also complain to the Office of the Personal Data Protection Committee (PDPC): https://www.pdpc.or.th",
      ],
    },
    { heading: "Age", body: ["You need to be 20 or over to use Giraffe."] },
  ];
}

function thai(controller: string, contact: string): readonly Section[] {
  const r = RETENTION_DAYS;
  return [
    { heading: "ใครดูแล Giraffe", body: [`Giraffe ดำเนินการโดย ${controller} หากมีเรื่องเกี่ยวกับข้อมูลของคุณ อีเมลมาที่ ${contact}`] },
    {
      heading: "Giraffe เก็บอะไรบ้าง",
      body: [
        "ข้อความที่คุณส่งถึง Giraffe และข้อความตอบกลับ",
        "สิ่งที่ Giraffe บันทึกไว้เพื่อช่วยคุณ: โน้ต การเตือน งาน แผนที่เสนอ สรุปแชตเก่า รวมถึงภาษา เขตเวลา และเวลาทักทายของคุณ",
        "user ID ของ LINE หรือ Telegram และถ้าคุณเชื่อม AI ไว้ คีย์ API ของคุณ (เก็บแบบเข้ารหัส) หรือการเข้าสู่ระบบแพ็กเกจ Claude ของคุณ (เก็บไว้บนเครื่องส่วนตัวที่ Giraffe เปิดให้คุณบน Fly.io)",
        "บันทึกการใช้งาน: user ID ของ LINE หรือ Telegram เวลาที่ส่งข้อความ จำนวนครั้ง ค่าใช้จ่ายของแต่ละคำตอบจาก AI ผลของแต่ละรอบ และสถานะการสมัคร โดยไม่มีข้อความของคุณ",
        "สำหรับแพ็กเกจที่ชำระเงิน: แพ็กเกจและสถานะการสมัคร Stripe เป็นผู้จัดการข้อมูลบัตร Giraffe ไม่เห็นเลขบัตรของคุณ",
      ],
    },
    {
      heading: "ใช้เพื่ออะไร",
      body: [
        "เพื่อเป็นผู้ช่วยของคุณ: ตอบคุณ จำสิ่งที่คุณขอ เตือน และทักทาย รวมถึงเพื่อให้บริการ เรียกเก็บเงิน และรักษาความปลอดภัย",
        "Giraffe ไม่ใช้ข้อมูลของคุณฝึกโมเดล AI",
        "ถ้าไม่มีข้อความของคุณ Giraffe ก็ช่วยคุณไม่ได้ และถ้าไม่ยอมรับประกาศนี้ จะใช้ Giraffe ไม่ได้",
      ],
    },
    {
      heading: "ข้อมูลอ่อนไหว",
      body: ["ถ้าคุณเล่าเรื่องสุขภาพ ศาสนา หรือเรื่องอ่อนไหวอื่น Giraffe จะเก็บไว้แบบเดียวกับแชตอื่น เพื่อช่วยคุณเท่านั้น"],
    },
    {
      heading: "ใครอีกบ้างที่จัดการข้อมูลของคุณ",
      body: [
        "Cloudflare เก็บข้อมูลและให้บริการระบบของ Giraffe",
        "AI ที่คุณเชื่อมไว้ได้รับข้อความและสิ่งที่ Giraffe บันทึกไว้ทุกครั้งที่ตอบ: บัญชีผู้ให้บริการ AI ของคุณเอง หรือแพ็กเกจ Claude ผ่านเครื่องส่วนตัวบน Fly.io ในแพ็กเกจที่ Giraffe เป็นผู้จ่ายค่า AI จะเป็นผู้ให้บริการ AI ที่ Giraffe เลือก แต่ละรายจัดการข้อมูลตามเงื่อนไขของตัวเอง",
        "Fly.io ให้บริการเครื่องส่วนตัวสำหรับผู้ที่เชื่อมแพ็กเกจ Claude ไฟล์ของ Claude Code จากแชตของคุณจะอยู่ในเครื่องนั้นจนกว่าจะลบเครื่อง",
        "LINE (LY Corporation) หรือ Telegram รับส่งทุกข้อความตามเงื่อนไขของตัวเอง",
        "Stripe ประมวลผลการชำระเงิน",
        "หน่วยงานรัฐ เมื่อกฎหมายกำหนด",
      ],
    },
    {
      heading: "การส่งข้อมูลไปต่างประเทศ",
      body: ["Cloudflare ผู้ให้บริการ AI ส่วนใหญ่ (หลายรายอยู่ในสหรัฐอเมริกา) Fly.io (ค่าเริ่มต้นคือสิงคโปร์) และแอปแชต อาจประมวลผลข้อมูลของคุณนอกประเทศไทย ซึ่งอาจมีมาตรฐานการคุ้มครองต่างจากไทย"],
    },
    {
      heading: "เก็บนานเท่าไร",
      body: [
        "แชตล่าสุดเก็บแบบคำต่อคำ เมื่อแชตยาวขึ้นและมี AI พร้อมใช้งาน ข้อความที่เก่ากว่านั้นจะถูกสรุปรวมไว้ แล้วลบต้นฉบับ",
        `สำเนาข้อความที่ Giraffe ส่งถึงคุณ: ลบในการล้างข้อมูลครั้งแรกหลัง ${r.sentCopies} วัน การล้างข้อมูลทำทุกครั้งที่ Giraffe จัดการข้อความ การเตือน หรือการทักทายให้คุณ`,
        `ข้อความขาเข้า หลังจาก Giraffe จัดการแล้ว: ลบในการล้างข้อมูลครั้งแรกหลัง ${r.handledIncoming} วัน ก่อนคุณเข้าร่วม Giraffe จะล้างข้อความของคุณทันทีหลังตอบ`,
        `สรุป โน้ต การเตือน งาน แผน การตั้งค่า และบันทึกการใช้งาน: ยังไม่มีการลบอัตโนมัติ หากต้องการให้ลบ อีเมลมาที่ ${contact}`,
        `เครื่องส่วนตัวสำหรับแพ็กเกจ Claude และไฟล์ในเครื่อง: จนกว่าคุณจะลบการเชื่อม หรือจนกว่า Giraffe จะลบเอง เมื่อไม่มีการเข้าสู่ระบบประมาณ ${r.unusedBox} วัน หรือเมื่อแพ็กเกจของคุณไม่รวมบริการนี้แล้ว`,
      ],
    },
    {
      heading: "สิทธิของคุณ",
      body: [
        "คุณขอดูและขอสำเนาข้อมูล ขอโอนข้อมูลไปบริการอื่น ขอแก้ไข ขอลบ ขอระงับหรือคัดค้านการใช้ และถอนความยินยอมได้ทุกเมื่อ การถอนความยินยอมไม่กระทบสิ่งที่ทำไปแล้ว และหลังจากถอน Giraffe จะช่วยคุณต่อไม่ได้",
        `ส่ง /memory ในแชตเพื่อดูโน้ต การเตือน และงานของคุณ เรื่องอื่นอีเมลมาที่ ${contact} เราจะตอบภายใน 30 วัน`,
        "คุณร้องเรียนต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล (สคส.) ได้ที่ https://www.pdpc.or.th",
      ],
    },
    { heading: "อายุ", body: ["ต้องมีอายุ 20 ปีขึ้นไปจึงใช้ Giraffe ได้"] },
  ];
}

const render = (lang: string, title: string, sections: readonly Section[]) =>
  `<section lang="${lang}"><h1>${title}</h1>${sections
    .map((s) => `<h2>${s.heading}</h2>${s.body.map((p) => `<p>${p}</p>`).join("")}`)
    .join("")}</section>`;

export function privacyPage(p: Pick<PrivacyConfig, "controller" | "contact">): string {
  const controller = escape(p.controller);
  const contact = escape(p.contact);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Giraffe privacy notice</title><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5">
<p><a href="#th">ภาษาไทย</a></p>
${render("en", "Giraffe privacy notice", english(controller, contact))}
<hr id="th">
${render("th", "ประกาศความเป็นส่วนตัวของ Giraffe", thai(controller, contact))}
</body></html>`;
}
