import type { JoinResult } from "./billing/store";
import type { BoxSay } from "./box/machine";
import type { Language } from "./domain";

/** Every text code writes to a person. Each language must fill every entry, so a missing translation fails the build. */
export type Notices = {
  readonly dateLocale: string;
  readonly reminderLimit: string;
  readonly reminderPast: string;
  readonly reminderTooFar: string;
  readonly reminderBadTime: string;
  readonly reminderDuplicate: string;
  readonly reminderKept: (dueLocal: string) => string;
  readonly reminderNotSet: string;
  readonly tooManyActions: string;
  readonly checkinReserved: string;
  readonly cancelNotFound: string;
  readonly badZone: string;
  readonly lateFallback: (dueLocal: string) => string;
  readonly monthlyLimit: string;
  readonly lapsed: string;
  readonly failed: string;
  readonly reminder: (note: string) => string;

  readonly billingOff: string;
  readonly billingBusy: string;
  readonly freeBeta: string;
  readonly onTrial: (daysLeft: number) => string;
  readonly onStandard: string;
  readonly onAi: string;
  readonly onPlusMember: string;
  readonly onPlusOwner: (places: { readonly taken: number; readonly seats: number } | null) => string;
  readonly noPlan: string;
  readonly pickPlan: string;
  readonly standardChoice: (link: string) => string;
  readonly plusChoice: (link: string, seats: number, maxSeats: number) => string;
  readonly aiChoice: (link: string) => string;
  readonly noLinks: string;
  readonly manage: (link: string) => string;
  readonly noPortal: string;
  readonly duplicate: string;
  readonly invite: (code: string) => string;
  readonly inviteNotOwner: string;
  readonly inviteFull: (seats: number) => string;
  readonly join: Readonly<Record<JoinResult, string>>;
  readonly notSeated: string;
  readonly left: string;
  readonly planActive: (label: string) => string;
  readonly plusOwnerActive: string;
  readonly plusMemberActive: string;
  readonly planEnded: (daysLeft: number) => string;

  readonly box: Readonly<Record<BoxSay, (link: string, until: string) => string>>;
};

/** The entries that take no argument, which a rejection reason can name. */
export type FixedNotice = { readonly [K in keyof Notices]: Notices[K] extends string ? K : never }[keyof Notices];

const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

const en: Notices = {
  dateLocale: "en-GB",
  reminderLimit: "(I can hold 20 reminders at most. Cancel one and ask again.)",
  reminderPast: "(That time has already passed, so I didn't set it.)",
  reminderTooFar: "(I can only set reminders up to a year ahead, so I didn't set it.)",
  reminderBadTime: "(I couldn't read that time, so I didn't set the reminder.)",
  reminderDuplicate: "(I already have that reminder set, so I didn't change it.)",
  reminderKept: (dueLocal) => `(Your reminder is still set for ${dueLocal}.)`,
  reminderNotSet: "(I couldn't set that reminder.)",
  tooManyActions: "(That was more than I can do in one message, so I skipped some of it.)",
  checkinReserved: "(The daily check-in can't be set or cancelled like a reminder.)",
  cancelNotFound: "(I couldn't find that reminder, so nothing was cancelled.)",
  badZone: "(I couldn't find that time zone, so I kept the one you had.)",
  lateFallback: (dueLocal) => `Sorry, this is late. It was due at ${dueLocal}.`,
  monthlyLimit: "I've reached my usage limit for this month, so I can't help until it resets on the 1st.",
  lapsed: "You have no active plan, so I can't answer messages for now. Send /plan to pick one.",
  failed: "Sorry, I couldn't process that. Could you say it again?",
  reminder: (note) => `Reminder: ${note}`,

  billingOff: "Plans aren't available yet.",
  billingBusy: "I couldn't do that just now. Please try again in a minute.",
  freeBeta: "You're on the free beta, so there's nothing to pay.",
  onTrial: (n) => `You're on the free trial, with ${days(n)} left.`,
  onStandard: "You're on the Standard plan.",
  onAi: "You're on the AI plan.",
  onPlusMember: "You're on a Plus plan someone shared with you. Send /leave to leave it.",
  onPlusOwner: (places) =>
    places
      ? `You're on the Plus plan, with ${places.taken} of ${places.seats} places taken. Send /invite to add someone.`
      : "You're on the Plus plan. Send /invite to add someone.",
  noPlan: "You have no active plan, so I can't answer messages for now.",
  pickPlan: "Pick a plan:",
  standardChoice: (link) => `Standard, your own Claude box: ${link}`,
  plusChoice: (link, seats, maxSeats) =>
    `Plus, a box each for up to ${seats} people${maxSeats > seats ? ` (add places up to ${maxSeats} at checkout)` : ""}: ${link}`,
  aiChoice: (link) => `AI, answers from our AI with no box: ${link}`,
  noLinks: "I couldn't make the payment links just now. Send /plan again in a minute.",
  manage: (link) => `To change or cancel your plan: ${link}`,
  noPortal: "I couldn't make the link to manage your plan just now. Send /plan again in a minute.",
  duplicate: "It looks like you're paying for more than one plan at once. We'll sort out the duplicate for you.",
  invite: (code) => `Ask the person you want to add to send me this within 7 days. It works once.\n/join ${code}`,
  inviteNotOwner: "Only the owner of a Plus plan can invite people. Send /plan to see the plans.",
  inviteFull: (seats) => `All ${seats} places on your Plus plan are taken.`,
  join: {
    joined: "You've joined a Plus plan. Send /claude to connect your own Claude plan.",
    bad_code: "That code doesn't work. Ask for a new one, which the Plus owner gets with /invite.",
    own: "That's your own Plus plan.",
    seated: "You're already on a Plus plan. Send /leave first.",
    ended: "That Plus plan isn't active.",
    full: "That Plus plan has no free places.",
  },
  notSeated: "You're not on someone else's Plus plan.",
  left: "You've left the Plus plan.",
  planActive: (label) => `Thanks. Your ${label} plan is active.`,
  plusOwnerActive: "Thanks. Your Plus plan is active. Send /invite to add someone.",
  plusMemberActive: "The Plus plan you joined is active.",
  planEnded: (n) => `Your plan has ended. You're on the free trial, with ${days(n)} left.`,

  box: {
    unavailable: () => "Connecting your own Claude plan isn't available yet.",
    full: () => "I can't connect another Claude plan right now. Please try again later.",
    busy: () => "I can't start setting up your Claude connection right now. Please try again in a few minutes.",
    setting_up: () => "Setting up your Claude connection. I'll send you a sign-in link in a few minutes.",
    still_setting_up: () => "Your Claude connection is still being set up. I'll send the sign-in link when it's ready.",
    link: (link) => `Sign in to Claude here to connect your plan. The link works for 30 minutes.\n${link}`,
    signed_out_link: (link) =>
      `Your Claude plan is signed out, so I'm answering without it for now. Sign in again here. The link works for 30 minutes.\n${link}`,
    connected: () => "Your Claude plan is connected. Your messages now use your Claude plan.",
    already_connected: () => "Your Claude plan is already connected.",
    setup_failed: () => "I couldn't set up your Claude connection. Send /claude to start over.",
    reclaimed: () => "Nobody signed in to your Claude connection for 2 days, so I removed it. Send /claude to set it up again.",
    resetting: () => "I'm removing your old Claude connection. Send /claude again in a few minutes.",
    not_in_plan: () => "Your plan doesn't include connecting your own Claude plan. Send /plan to see the plans.",
    retiring: (_, until) =>
      `Your plan doesn't include connecting your own Claude plan, so I'll remove your Claude connection on ${until} unless your plan resumes. Send /plan to see the plans.`,
    retired: () => "Your plan doesn't include connecting your own Claude plan, so I removed your Claude connection. Send /plan to see the plans.",
  },
};

const th: Notices = {
  dateLocale: "th-TH",
  reminderLimit: "(ตั้งเตือนไว้ได้สูงสุด 20 รายการค่ะ ยกเลิกรายการไหนก่อนแล้วค่อยขอใหม่นะคะ)",
  reminderPast: "(เวลานั้นผ่านไปแล้ว เลยไม่ได้ตั้งเตือนให้ค่ะ)",
  reminderTooFar: "(ตั้งเตือนล่วงหน้าได้ไม่เกินหนึ่งปี เลยไม่ได้ตั้งให้ค่ะ)",
  reminderBadTime: "(อ่านเวลานั้นไม่ออก เลยยังไม่ได้ตั้งเตือนให้ค่ะ)",
  reminderDuplicate: "(มีเตือนนี้ตั้งไว้อยู่แล้ว เลยไม่ได้เปลี่ยนอะไรค่ะ)",
  reminderKept: (dueLocal) => `(เตือนเดิมยังตั้งไว้ที่ ${dueLocal} เหมือนเดิมค่ะ)`,
  reminderNotSet: "(ตั้งเตือนนั้นไม่ได้ค่ะ)",
  tooManyActions: "(ทำทั้งหมดในข้อความเดียวไม่ได้ เลยข้ามบางส่วนไปค่ะ)",
  checkinReserved: "(การทักทายประจำวันตั้งหรือยกเลิกแบบเตือนทั่วไปไม่ได้ค่ะ)",
  cancelNotFound: "(ไม่เจอเตือนนั้น เลยไม่ได้ยกเลิกอะไรค่ะ)",
  badZone: "(ไม่รู้จักเขตเวลานั้น เลยยังใช้เขตเวลาเดิมอยู่ค่ะ)",
  lateFallback: (dueLocal) => `ขอโทษที่ช้านะคะ เรื่องนี้ควรถึงตอน ${dueLocal}`,
  monthlyLimit: "เดือนนี้ใช้งานครบโควตาแล้วค่ะ จะช่วยได้อีกครั้งเมื่อขึ้นเดือนใหม่วันที่ 1",
  lapsed: "ตอนนี้ยังไม่มีแพ็กเกจที่ใช้งานอยู่ เลยยังตอบข้อความไม่ได้ค่ะ ส่ง /plan เพื่อเลือกแพ็กเกจนะคะ",
  failed: "ขอโทษค่ะ ตอนนี้ยังตอบข้อความนั้นไม่ได้ ช่วยส่งมาใหม่อีกครั้งได้ไหมคะ",
  reminder: (note) => `เตือนความจำ: ${note}`,

  billingOff: "ตอนนี้ยังไม่มีแพ็กเกจให้เลือกค่ะ",
  billingBusy: "ตอนนี้ทำรายการนั้นไม่ได้ ลองใหม่อีกครั้งในอีกสักครู่นะคะ",
  freeBeta: "ตอนนี้ใช้รุ่นทดลองฟรีอยู่ ไม่ต้องจ่ายอะไรค่ะ",
  onTrial: (n) => `ตอนนี้อยู่ในช่วงทดลองใช้ฟรี เหลืออีก ${n} วันค่ะ`,
  onStandard: "ตอนนี้ใช้แพ็กเกจ Standard อยู่ค่ะ",
  onAi: "ตอนนี้ใช้แพ็กเกจ AI อยู่ค่ะ",
  onPlusMember: "ตอนนี้ใช้แพ็กเกจ Plus ที่มีคนแชร์ให้อยู่ค่ะ ถ้าต้องการออกให้ส่ง /leave",
  onPlusOwner: (places) =>
    places
      ? `ตอนนี้ใช้แพ็กเกจ Plus อยู่ค่ะ ใช้ที่ไปแล้ว ${places.taken} จาก ${places.seats} ที่ ส่ง /invite เพื่อเพิ่มคน`
      : "ตอนนี้ใช้แพ็กเกจ Plus อยู่ค่ะ ส่ง /invite เพื่อเพิ่มคน",
  noPlan: "ตอนนี้ยังไม่มีแพ็กเกจที่ใช้งานอยู่ เลยยังตอบข้อความไม่ได้ค่ะ",
  pickPlan: "เลือกแพ็กเกจได้เลยค่ะ:",
  standardChoice: (link) => `Standard มีกล่อง Claude ของตัวเอง: ${link}`,
  plusChoice: (link, seats, maxSeats) =>
    `Plus มีกล่องให้คนละกล่อง สูงสุด ${seats} คน${maxSeats > seats ? ` (เพิ่มได้ถึง ${maxSeats} คนตอนชำระเงิน)` : ""}: ${link}`,
  aiChoice: (link) => `AI ตอบด้วย AI ของเรา ไม่มีกล่อง: ${link}`,
  noLinks: "ตอนนี้สร้างลิงก์ชำระเงินไม่ได้ค่ะ ส่ง /plan อีกครั้งในอีกสักครู่นะคะ",
  manage: (link) => `เปลี่ยนหรือยกเลิกแพ็กเกจได้ที่: ${link}`,
  noPortal: "ตอนนี้สร้างลิงก์จัดการแพ็กเกจไม่ได้ค่ะ ส่ง /plan อีกครั้งในอีกสักครู่นะคะ",
  duplicate: "ดูเหมือนตอนนี้จ่ายอยู่มากกว่าหนึ่งแพ็กเกจ เดี๋ยวทางเราจะจัดการรายการที่ซ้ำให้ค่ะ",
  invite: (code) => `ให้คนที่อยากเพิ่มส่งข้อความนี้มาภายใน 7 วัน ใช้ได้ครั้งเดียวค่ะ\n/join ${code}`,
  inviteNotOwner: "เฉพาะเจ้าของแพ็กเกจ Plus เท่านั้นที่เชิญคนได้ค่ะ ส่ง /plan เพื่อดูแพ็กเกจ",
  inviteFull: (seats) => `ที่ในแพ็กเกจ Plus เต็มครบ ${seats} ที่แล้วค่ะ`,
  join: {
    joined: "เข้าร่วมแพ็กเกจ Plus แล้วค่ะ ส่ง /claude เพื่อเชื่อมแพ็กเกจ Claude ของตัวเอง",
    bad_code: "รหัสนี้ใช้ไม่ได้ค่ะ ขอรหัสใหม่จากเจ้าของแพ็กเกจ Plus ได้ ซึ่งเจ้าของขอรหัสได้ด้วย /invite",
    own: "นี่คือแพ็กเกจ Plus ของคุณเองค่ะ",
    seated: "ตอนนี้อยู่ในแพ็กเกจ Plus อยู่แล้วค่ะ ส่ง /leave ก่อนนะคะ",
    ended: "แพ็กเกจ Plus นั้นไม่ได้ใช้งานอยู่ค่ะ",
    full: "แพ็กเกจ Plus นั้นไม่มีที่ว่างแล้วค่ะ",
  },
  notSeated: "ตอนนี้ไม่ได้อยู่ในแพ็กเกจ Plus ของคนอื่นค่ะ",
  left: "ออกจากแพ็กเกจ Plus แล้วค่ะ",
  planActive: (label) => `ขอบคุณค่ะ แพ็กเกจ ${label} ใช้งานได้แล้ว`,
  plusOwnerActive: "ขอบคุณค่ะ แพ็กเกจ Plus ใช้งานได้แล้ว ส่ง /invite เพื่อเพิ่มคน",
  plusMemberActive: "แพ็กเกจ Plus ที่เข้าร่วมไว้ใช้งานได้แล้วค่ะ",
  planEnded: (n) => `แพ็กเกจหมดแล้วค่ะ ตอนนี้กลับมาอยู่ในช่วงทดลองใช้ฟรี เหลืออีก ${n} วัน`,

  box: {
    unavailable: () => "ตอนนี้ยังเชื่อมแพ็กเกจ Claude ของตัวเองไม่ได้ค่ะ",
    full: () => "ตอนนี้เชื่อมแพ็กเกจ Claude เพิ่มไม่ได้แล้วค่ะ ลองใหม่ภายหลังนะคะ",
    busy: () => "ตอนนี้ยังเริ่มตั้งค่าการเชื่อม Claude ไม่ได้ค่ะ ลองใหม่ในอีกไม่กี่นาทีนะคะ",
    setting_up: () => "กำลังตั้งค่าการเชื่อม Claude อยู่ค่ะ อีกไม่กี่นาทีจะส่งลิงก์เข้าสู่ระบบให้",
    still_setting_up: () => "ยังตั้งค่าการเชื่อม Claude อยู่ค่ะ พร้อมเมื่อไหร่จะส่งลิงก์เข้าสู่ระบบให้",
    link: (link) => `เข้าสู่ระบบ Claude ที่ลิงก์นี้เพื่อเชื่อมแพ็กเกจได้เลยค่ะ ลิงก์ใช้ได้ 30 นาที\n${link}`,
    signed_out_link: (link) =>
      `แพ็กเกจ Claude ออกจากระบบอยู่ ตอนนี้เลยตอบโดยไม่ใช้แพ็กเกจนั้นไปก่อนค่ะ เข้าสู่ระบบอีกครั้งได้ที่ลิงก์นี้ ใช้ได้ 30 นาที\n${link}`,
    connected: () => "เชื่อมแพ็กเกจ Claude แล้วค่ะ จากนี้ข้อความจะใช้แพ็กเกจ Claude ของคุณ",
    already_connected: () => "แพ็กเกจ Claude เชื่อมอยู่แล้วค่ะ",
    setup_failed: () => "ตั้งค่าการเชื่อม Claude ไม่สำเร็จค่ะ ส่ง /claude เพื่อเริ่มใหม่",
    reclaimed: () => "ไม่มีใครเข้าสู่ระบบการเชื่อม Claude มา 2 วันแล้ว เลยลบออกไปค่ะ ส่ง /claude เพื่อตั้งค่าใหม่",
    resetting: () => "กำลังลบการเชื่อม Claude เดิมอยู่ค่ะ ส่ง /claude อีกครั้งในอีกไม่กี่นาทีนะคะ",
    not_in_plan: () => "แพ็กเกจของคุณไม่รวมการเชื่อมแพ็กเกจ Claude ของตัวเองค่ะ ส่ง /plan เพื่อดูแพ็กเกจ",
    retiring: (_, until) =>
      `แพ็กเกจของคุณไม่รวมการเชื่อมแพ็กเกจ Claude ของตัวเอง เลยจะลบการเชื่อม Claude ในวันที่ ${until} ถ้าแพ็กเกจไม่กลับมาใช้งานค่ะ ส่ง /plan เพื่อดูแพ็กเกจ`,
    retired: () => "แพ็กเกจของคุณไม่รวมการเชื่อมแพ็กเกจ Claude ของตัวเอง เลยลบการเชื่อม Claude ออกแล้วค่ะ ส่ง /plan เพื่อดูแพ็กเกจ",
  },
};

export const NOTICES: { readonly [L in Language]: Notices } = { en, th };
