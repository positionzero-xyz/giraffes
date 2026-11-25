import type { Language } from "../domain";

/** One forget's deletion: every saved item, or the numbers the person picked from that forget's list. */
export type Deleted = "all" | readonly number[];

/** Whether every backup copy at our hosts has a known expiry within the receipt's window. */
export type Backups = "expire" | "pending";

export type Receipt = { readonly deleted: readonly Deleted[]; readonly backups: Backups };

export type ForgetText = {
  readonly listMore: string;
  readonly listDone: (code: string) => string;
  readonly receipt: (r: Receipt) => string;
  readonly lastReceipt: (r: Receipt) => string;
  readonly erasing: string;
  readonly reviewOpen: (code: string | null) => string;
  readonly held: string;
  readonly none: string;
  readonly help: string;
  readonly offer: string;
};

const listEn = (n: readonly number[]) => (n.length === 1 ? `${n[0]}` : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`);
const listTh = (n: readonly number[]) => (n.length === 1 ? `${n[0]}` : `${n.slice(0, -1).join(", ")} และ ${n[n.length - 1]}`);

function deletedEn(deleted: readonly Deleted[]): string {
  if (deleted.includes("all")) return "deleted all saved items";
  const lists = deleted.filter((d): d is readonly number[] => d !== "all" && d.length > 0);
  if (lists.length === 0) return "kept all your saved items";
  if (lists.length === 1) return `deleted saved ${lists[0].length === 1 ? "item" : "items"} ${listEn(lists[0])}`;
  return `deleted saved items ${lists.map((l, i) => `${listEn(l)} from list ${i + 1}`).join(", and ")}`;
}

function deletedTh(deleted: readonly Deleted[]): string {
  if (deleted.includes("all")) return "ลบรายการที่บันทึกไว้ทั้งหมดแล้ว";
  const lists = deleted.filter((d): d is readonly number[] => d !== "all" && d.length > 0);
  if (lists.length === 0) return "เก็บรายการที่บันทึกไว้ทั้งหมดไว้ตามเดิม";
  if (lists.length === 1) return `ลบรายการที่บันทึกไว้หมายเลข ${listTh(lists[0])} แล้ว`;
  return `ลบรายการที่บันทึกไว้หมายเลข ${lists.map((l, i) => `${listTh(l)} จากรายการที่ ${i + 1}`).join(" และ ")} แล้ว`;
}

export const FORGET_TEXT: Readonly<Record<Language, ForgetText>> = {
  en: {
    listMore: "Send /forget next for the next page.",
    listDone: (code) =>
      `That's the whole list. To delete saved items, send /forget ${code} and their numbers, such as /forget ${code} 2 5. To keep them all, send /forget ${code} done.`,
    receipt: (r) =>
      `I cleared our chat and ${deletedEn(r.deleted)}.${r.backups === "expire" ? " Backup copies at our hosts expire within 30 days." : " Removing the backup copies at our hosts is still pending."}`,
    lastReceipt: (r) => `Your last forget is done. ${FORGET_TEXT.en.receipt(r)}`,
    erasing:
      "I've cleared our chat and deleted what you chose. I'm still erasing your Claude box, and I'll tell you when that's done. Until then I'm holding your other messages.",
    reviewOpen: (code) =>
      code === null
        ? "Your forget is still open. I've cleared our chat, and I'm holding your other messages until you choose. Send /forget next to see your saved items."
        : `Your forget is still open. I've cleared our chat, and I'm holding your other messages until you choose. Send /forget ${code} and the numbers to delete, or /forget ${code} done to keep everything.`,
    held: "I'm still finishing your forget, so I'm holding your other messages until it's done. Send /forget status to see where it is.",
    none: "There's no forget in progress. Send /forget to clear our chat and choose saved items to delete, or /forget all to delete everything.",
    help: "I couldn't read that. Send /forget to clear our chat and choose saved items to delete, /forget all to delete everything, or /forget status.",
    offer: "If you'd like me to forget something, send /forget. I'll clear our chat and show you your saved items so you can choose which to delete. Nothing is deleted until you do.",
  },
  th: {
    listMore: "พิมพ์ /forget next เพื่อดูหน้าถัดไปค่ะ",
    listDone: (code) =>
      `จบรายการแล้วค่ะ ถ้าต้องการลบ พิมพ์ /forget ${code} ตามด้วยหมายเลข เช่น /forget ${code} 2 5 ถ้าต้องการเก็บไว้ทั้งหมด พิมพ์ /forget ${code} done`,
    receipt: (r) =>
      `ล้างแชทของเราแล้ว และ${deletedTh(r.deleted)}ค่ะ${r.backups === "expire" ? " สำเนาสำรองที่ผู้ให้บริการของเราจะหมดอายุภายใน 30 วัน" : " การลบสำเนาสำรองที่ผู้ให้บริการของเรายังไม่เสร็จค่ะ"}`,
    lastReceipt: (r) => `การลืมครั้งล่าสุดเสร็จแล้วค่ะ ${FORGET_TEXT.th.receipt(r)}`,
    erasing: "ล้างแชทของเราและลบรายการที่คุณเลือกแล้วค่ะ ตอนนี้กำลังลบข้อมูลใน Claude box ของคุณ เสร็จแล้วจะแจ้งให้ทราบ ระหว่างนี้จะพักข้อความอื่นของคุณไว้ก่อนค่ะ",
    reviewOpen: (code) =>
      code === null
        ? "การลืมยังไม่เสร็จค่ะ ล้างแชทของเราแล้ว และจะพักข้อความอื่นไว้จนกว่าคุณจะเลือก พิมพ์ /forget next เพื่อดูรายการที่บันทึกไว้"
        : `การลืมยังไม่เสร็จค่ะ ล้างแชทของเราแล้ว และจะพักข้อความอื่นไว้จนกว่าคุณจะเลือก พิมพ์ /forget ${code} ตามด้วยหมายเลขที่ต้องการลบ หรือ /forget ${code} done เพื่อเก็บไว้ทั้งหมด`,
    held: "กำลังทำการลืมให้เสร็จค่ะ จะพักข้อความอื่นของคุณไว้จนกว่าจะเสร็จ พิมพ์ /forget status เพื่อดูความคืบหน้า",
    none: "ตอนนี้ไม่มีการลืมที่ค้างอยู่ค่ะ พิมพ์ /forget เพื่อล้างแชทของเราและเลือกรายการที่จะลบ หรือ /forget all เพื่อลบทั้งหมด",
    help: "อ่านคำสั่งนั้นไม่ออกค่ะ พิมพ์ /forget เพื่อล้างแชทของเราและเลือกรายการที่จะลบ /forget all เพื่อลบทั้งหมด หรือ /forget status",
    offer: "ถ้าต้องการให้ลืมอะไร พิมพ์ /forget ค่ะ จะล้างแชทของเราและแสดงรายการที่บันทึกไว้ให้คุณเลือกว่าจะลบอะไร จะยังไม่มีอะไรถูกลบจนกว่าคุณจะเลือก",
  },
};
