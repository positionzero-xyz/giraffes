import type { JoinResult } from "./billing/store";
import type { BoxSay } from "./box/machine";
import type { Language, WaitlistReason } from "./domain";

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
  readonly reminderAttemptFailed: string;
  readonly tooManyActions: string;
  readonly checkinReserved: string;
  readonly cancelNotFound: string;
  readonly badZone: string;
  readonly lateFallback: (dueLocal: string) => string;
  readonly monthlyLimit: string;
  readonly lapsed: string;
  readonly failed: string;
  readonly tooLong: string;
  readonly reminder: (note: string) => string;

  readonly billingOff: string;
  readonly feedbackThanks: string;
  readonly feedbackUsage: string;
  readonly billingBusy: string;
  readonly freeBeta: string;
  readonly onTrial: (daysLeft: number) => string;
  readonly onStandard: string;
  readonly onIncluded: string;
  readonly onPlusMember: string;
  readonly onPlusOwner: (places: { readonly taken: number; readonly seats: number } | null) => string;
  readonly noPlan: string;
  readonly pickPlan: string;
  readonly standardChoice: (link: string) => string;
  readonly plusChoice: (link: string, seats: number, maxSeats: number) => string;
  readonly includedChoice: (link: string) => string;
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

  readonly planAccepted: (title: string) => string;
  readonly planChanged: string;
  readonly acceptButton: string;
  readonly consentButton: string;
  readonly privacy: (noticeUrl: string) => string;
  readonly welcome: string;
  readonly waitlist: Readonly<Record<WaitlistReason, string>>;
  readonly alreadyIn: string;
  readonly removed: string;
  readonly betaInvite: (code: string) => string;
  readonly inviteLimit: (max: number) => string;
  readonly inviteNotEnrolled: string;

  readonly noAccess: (offer: { readonly box: boolean; readonly key: boolean; readonly included: boolean }) => string;
  readonly boxNotReady: string;
  readonly boxSignedOut: string;
  readonly catchUp: string;
  readonly ownCapReached: (capUsd: string) => string;
  readonly includedCapReached: string;
  readonly keyRefused: (provider: string) => string;
  readonly keyNoCredit: (provider: string) => string;
  readonly keyNoModel: (provider: string, model: string) => string;
  readonly keyRateLimited: (provider: string, untilLocal: string) => string;
  readonly keyUnreadable: string;
  readonly keysOff: string;
  readonly keyLink: (link: string) => string;
  readonly keyStatus: (s: {
    readonly provider: string;
    readonly model: string;
    readonly hint: string;
    readonly spentUsd: string;
    readonly capUsd: string;
    readonly approximate: boolean;
    readonly backup: boolean | null;
    readonly link: string;
  }) => string;
  readonly keyResting: string;
  readonly keyConnected: (provider: string, model: string) => string;
  readonly backupAsk: (provider: string) => string;
  readonly backupButton: string;
  readonly backupOn: string;
  readonly backupOff: string;
  readonly backupStale: string;
  readonly noKey: string;
  readonly keyRemoved: string;
  readonly keyCapSet: (capUsd: string) => string;
  readonly keyCapRange: (minUsd: string, maxUsd: string) => string;
  readonly pastedKey: (link: string | null) => string;
  readonly keyPage: KeyPageText;
};

/** The key page's words, which the page picks by the language in its link. */
export type KeyPageText = {
  readonly title: string;
  readonly intro: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly key: string;
  readonly connect: string;
  readonly checking: string;
  readonly connected: string;
  readonly getKey: string;
  readonly errors: Readonly<Record<KeyPageError, string>>;
};

export const KEY_PAGE_ERRORS = [
  "bad_form",
  "unknown_provider",
  "bad_url",
  "no_model",
  "key_shape",
  "expired",
  "used",
  "busy",
  "superseded",
  "bad_key",
  "no_credit",
  "bad_model",
  "rate_limited",
  "unreachable",
  "no_json",
  "over_cap",
] as const;
export type KeyPageError = (typeof KEY_PAGE_ERRORS)[number];

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
  reminderAttemptFailed: "(One attempt to set that reminder failed.)",
  tooManyActions: "(That was more than I can do in one message, so I skipped some of it.)",
  checkinReserved: "(The daily check-in can't be set or cancelled like a reminder.)",
  cancelNotFound: "(I couldn't find that reminder, so nothing was cancelled.)",
  badZone: "(I couldn't find that time zone, so I kept the one you had.)",
  lateFallback: (dueLocal) => `Sorry, this is late. It was due at ${dueLocal}.`,
  monthlyLimit: "I've reached my usage limit for this month, so I can't help until it resets on the 1st.",
  lapsed: "You have no active plan, so I can't answer messages for now. Send /plan to pick one.",
  failed: "Sorry, I couldn't process that. Could you say it again?",
  tooLong: "That's too long for me to read in one go. Could you split it into a few shorter messages?",
  reminder: (note) => `Reminder: ${note}`,

  billingOff: "Plans aren't available yet.",
  feedbackThanks: "Thanks for the feedback!",
  feedbackUsage: "Use /feedback followed by your message.",
  billingBusy: "I couldn't do that just now. Please try again in a minute.",
  freeBeta: "You're on the free beta, so there's nothing to pay.",
  onTrial: (n) => `You're on the free trial, with ${days(n)} left.`,
  onStandard: "You're on the Standard plan.",
  onIncluded: "You're on the plan with AI included.",
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
  includedChoice: (link) => `AI included, if you don't bring your own: ${link}`,
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
      `Your Claude plan is signed out. Once you sign in, I'll answer requests from the last 24 hours. The link works for 30 minutes.\n${link}`,
    signed_out_backup: (link) =>
      `Your Claude plan is signed out, so your backup key answers for now. Sign in again here. The link works for 30 minutes.\n${link}`,
    connected: () => "Your Claude plan is connected. Your messages now use your Claude plan.",
    already_connected: () => "Your Claude plan is already connected.",
    setup_failed: () => "I couldn't set up your Claude connection. Send /claude to start over.",
    reclaimed: () => "Nobody signed in to your Claude connection for 2 days, so I removed it. Send /claude to set it up again.",
    resetting: () => "I'm removing your old Claude connection. Send /claude again in a few minutes.",
    not_in_plan: () => "Your plan doesn't include connecting your own Claude plan. Send /plan to see the plans.",
    retiring: (_, until) =>
      `Your plan doesn't include connecting your own Claude plan, so I'll remove your Claude connection on ${until} unless your plan resumes. Send /plan to see the plans.`,
    retired: () => "Your plan doesn't include connecting your own Claude plan, so I removed your Claude connection. Send /plan to see the plans.",
    removing: () => "I'm removing your Claude connection now.",
    removed: () => "Your Claude connection is removed. If you added an API key, it answers from now on. Send /claude to connect your plan again.",
  },

  planAccepted: (title) => `(Plan accepted: ${title}.)`,
  planChanged: "(That plan has changed since, so I didn't accept it. Tap Accept on the newest one.)",
  acceptButton: "Accept plan",
  consentButton: "I'm 20+ and agree",
  privacy: (notice) => `Before we start, here is how your messages are handled.
• I keep our chat and the notes, reminders and tasks I make for you, so I can help over time. Send /memory to see your notes, reminders and tasks.
• To answer you, I send your messages and what I've saved to an AI: the one you connect, such as Anthropic or your Claude plan, or on some plans one Giraffe provides. LINE or Telegram also carries every message.
• Our own logs keep your chat app ID, times, counts and costs, never your words.
• Some of these services are outside Thailand.
• If you share health or other private details, I keep them the same way, only to help you.
• You need to be 20 or over.
Who runs Giraffe, how long things are kept, and how to ask for a copy or to delete them: ${notice}
Tap the button to agree.`,
  welcome: "You're in. Tell me what you'd like a hand with, and I'll check in with you each morning.",
  waitlist: {
    no_code: "Hi! I'm in a small invite-only beta for now. If you have an invite code, send it here.",
    bad_code: "That code doesn't work. Check it and send it again.",
    used: "That code has already been used. Ask the person who gave it to you for a new one.",
    full: "The beta is full right now, so I've put you on the waiting list.",
  },
  alreadyIn: "You're already in the beta.",
  removed: "You're no longer in the beta, so I can't answer messages.",
  betaInvite: (code) => `Send this to a friend. They add me and send it to me. It works once.
/join ${code}`,
  inviteLimit: (max) => `You've already made all ${max} of your invites.`,
  inviteNotEnrolled: "Only people in the beta can invite someone.",

  noAccess: (o) =>
    o.box || o.key || o.included
      ? [
          "I need an AI to answer you, and you bring your own. Pick one:",
          ...(o.box ? ["• Have Claude Pro or Max? Send /claude to connect it."] : []),
          ...(o.key ? ["• Have an API key? Send /key. OpenCode Go ($10 a month, opencode.ai/go) works well. A Mistral key works too, either a Studio API key or the key from your Vibe plan, and students and teachers pay less (mistral.ai/pricing)."] : []),
          ...(o.included ? ["• Or get AI included with a plan: send /plan."] : []),
          ...(o.box || o.key ? ["Once you connect your own AI, I'll answer requests from the last 24 hours."] : []),
          "Your reminders still go out either way.",
        ].join("\n")
      : "I can't connect an AI for you yet. Your reminders still go out.",
  boxNotReady: "Your Claude plan isn't ready to answer yet. Send /claude to check the connection.",
  boxSignedOut: "Your Claude plan isn't signed in. Once you sign in, I'll answer requests from the last 24 hours. Send /claude for a sign-in link.",
  catchUp: "Here's my answer to what you sent earlier.",
  ownCapReached: (cap) => `You've used the $${cap} monthly limit you set for your key. Send /key cap <dollars> to change it. It resets on the 1st.`,
  includedCapReached: "Your plan's AI allowance for this month is used up. It resets on the 1st.",
  keyRefused: (p) => `Your ${p} key was refused. Send /key to enter it again.`,
  keyNoCredit: (p) => `Your ${p} account is out of credit. I can try the key again in an hour, or you can send /key to use another key.`,
  keyNoModel: (p, m) => `${p} no longer serves ${m}. Send /key to pick another model.`,
  keyRateLimited: (p, until) => (until ? `You've hit your ${p} usage limit. I'll use it again after ${until}.` : `You've hit your ${p} usage limit. I'll try it again later.`),
  keyUnreadable: "I lost access to your saved key on our side, sorry. Send /key to enter it again.",
  keysOff: "Connecting your own API key isn't available yet.",
  keyLink: (link) => `Add your API key on this page. Never send a key in the chat. The link works once, for 15 minutes:\n${link}`,
  keyStatus: (s) =>
    [
      `Your key: ${s.provider}, ${s.model}, ending ${s.hint}.`,
      `This month: ${s.approximate ? "about " : ""}$${s.spentUsd} of your $${s.capUsd} limit.`,
      ...(s.backup === null ? [] : [s.backup ? "It backs up your Claude plan." : "It isn't used while your Claude plan is connected. Send /key backup on to change that."]),
      `To replace it: ${s.link}`,
      "Send /key cap <dollars> to change the limit, or /key remove to remove it.",
    ].join("\n"),
  keyResting: "Your key isn't working right now. I'll try it again later.",
  keyConnected: (p, m) => `Connected: ${p} (${m}). Your messages now use your own key.`,
  backupAsk: (p) => `You've connected your Claude plan and your ${p} key. Use your key as a backup when your Claude plan isn't available? It only spends your key's money when your plan can't answer.`,
  backupButton: "Use my key as backup",
  backupOn: "OK. Your key backs up your Claude plan. Send /key backup off to stop.",
  backupOff: "OK. Your key isn't used while your Claude plan is connected.",
  backupStale: "That question was about a key you've since replaced or removed, so nothing changed. Send /key backup on to let your current key back up your Claude plan.",
  noKey: "You haven't added an API key.",
  keyRemoved: "Your key is removed. I've forgotten it.",
  keyCapSet: (cap) => `Your key's monthly limit is now $${cap}.`,
  keyCapRange: (min, max) => `The limit must be between $${min} and $${max}, such as /key cap 10.`,
  pastedKey: (link) =>
    [
      "That looked like an API key, so I removed it from our chat history. Chat apps can read messages, so revoke that key at your provider and make a new one.",
      ...(link ? [`Add the new key on this page instead, never in the chat:\n${link}`] : []),
    ].join("\n"),
  keyPage: {
    title: "Connect your AI",
    intro: "Your key is encrypted and kept only for your assistant. Send /key remove in the chat to delete it at any time.",
    provider: "Provider",
    model: "Model",
    baseUrl: "Base URL (https)",
    key: "API key",
    connect: "Connect",
    checking: "Checking your key with one tiny request…",
    connected: "Connected. You can go back to the chat.",
    getKey: "Get a key",
    errors: {
      bad_form: "Something in the form is missing. Check it and try again.",
      unknown_provider: "Pick a provider from the list.",
      bad_url: "The base URL must be an https address.",
      no_model: "Type the model to use.",
      key_shape: "That doesn't look like a key for this provider. Check you copied all of it.",
      expired: "This link has expired. Send /key in the chat for a new one.",
      used: "This link was already used. Send /key in the chat for a new one.",
      busy: "Still checking the key from your last try. Wait a moment.",
      superseded: "Your key changed in the meantime, so this one wasn't saved. Send /key for a new link.",
      bad_key: "The provider refused that key. Send /key in the chat for a new link and try again.",
      no_credit: "The provider says that account has no credit. Top it up, then send /key for a new link.",
      bad_model: "The provider doesn't serve that model. Send /key for a new link and pick another.",
      rate_limited: "The provider is limiting that key right now. Send /key for a new link and try later.",
      unreachable: "I couldn't reach the provider. Send /key for a new link and try again.",
      no_json: "That model couldn't answer in the format I need. Send /key for a new link and pick another model.",
      over_cap: "Your key's monthly limit is used up, so I couldn't check it. Send /key cap <dollars> to raise it.",
    },
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
  reminderAttemptFailed: "(ครั้งหนึ่งที่ลองตั้งเตือนนั้นไม่สำเร็จค่ะ)",
  tooManyActions: "(ทำทั้งหมดในข้อความเดียวไม่ได้ เลยข้ามบางส่วนไปค่ะ)",
  checkinReserved: "(การทักทายประจำวันตั้งหรือยกเลิกแบบเตือนทั่วไปไม่ได้ค่ะ)",
  cancelNotFound: "(ไม่เจอเตือนนั้น เลยไม่ได้ยกเลิกอะไรค่ะ)",
  badZone: "(ไม่รู้จักเขตเวลานั้น เลยยังใช้เขตเวลาเดิมอยู่ค่ะ)",
  lateFallback: (dueLocal) => `ขอโทษที่ช้านะคะ เรื่องนี้ควรถึงตอน ${dueLocal}`,
  monthlyLimit: "เดือนนี้ใช้งานครบโควตาแล้วค่ะ จะช่วยได้อีกครั้งเมื่อขึ้นเดือนใหม่วันที่ 1",
  lapsed: "ตอนนี้ยังไม่มีแพ็กเกจที่ใช้งานอยู่ เลยยังตอบข้อความไม่ได้ค่ะ ส่ง /plan เพื่อเลือกแพ็กเกจนะคะ",
  failed: "ขอโทษค่ะ ตอนนี้ยังตอบข้อความนั้นไม่ได้ ช่วยส่งมาใหม่อีกครั้งได้ไหมคะ",
  tooLong: "ข้อความนี้ยาวเกินกว่าจะอ่านในครั้งเดียวค่ะ ช่วยแบ่งเป็นข้อความสั้นๆ หลายข้อความได้ไหมคะ",
  reminder: (note) => `เตือนความจำ: ${note}`,

  billingOff: "ตอนนี้ยังไม่มีแพ็กเกจให้เลือกค่ะ",
  feedbackThanks: "ขอบคุณที่แจ้งค่ะ",
  feedbackUsage: "พิมพ์ /feedback แล้วตามด้วยข้อความค่ะ",
  billingBusy: "ตอนนี้ทำรายการนั้นไม่ได้ ลองใหม่อีกครั้งในอีกสักครู่นะคะ",
  freeBeta: "ตอนนี้ใช้รุ่นทดลองฟรีอยู่ ไม่ต้องจ่ายอะไรค่ะ",
  onTrial: (n) => `ตอนนี้อยู่ในช่วงทดลองใช้ฟรี เหลืออีก ${n} วันค่ะ`,
  onStandard: "ตอนนี้ใช้แพ็กเกจ Standard อยู่ค่ะ",
  onIncluded: "ตอนนี้ใช้แพ็กเกจที่รวม AI ไว้แล้วค่ะ",
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
  includedChoice: (link) => `รวม AI ไว้ให้ ไม่ต้องใช้ AI ของคุณเอง: ${link}`,
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
      `แพ็กเกจ Claude ออกจากระบบอยู่ค่ะ เมื่อเข้าสู่ระบบแล้ว จะตอบคำขอที่คุณส่งมาในช่วง 24 ชั่วโมงที่ผ่านมานะคะ ลิงก์ใช้ได้ 30 นาที\n${link}`,
    signed_out_backup: (link) =>
      `แพ็กเกจ Claude ออกจากระบบอยู่ ตอนนี้เลยใช้คีย์สำรองของคุณตอบไปก่อนค่ะ เข้าสู่ระบบอีกครั้งได้ที่ลิงก์นี้ ใช้ได้ 30 นาที\n${link}`,
    connected: () => "เชื่อมแพ็กเกจ Claude แล้วค่ะ จากนี้ข้อความจะใช้แพ็กเกจ Claude ของคุณ",
    already_connected: () => "แพ็กเกจ Claude เชื่อมอยู่แล้วค่ะ",
    setup_failed: () => "ตั้งค่าการเชื่อม Claude ไม่สำเร็จค่ะ ส่ง /claude เพื่อเริ่มใหม่",
    reclaimed: () => "ไม่มีใครเข้าสู่ระบบการเชื่อม Claude มา 2 วันแล้ว เลยลบออกไปค่ะ ส่ง /claude เพื่อตั้งค่าใหม่",
    resetting: () => "กำลังลบการเชื่อม Claude เดิมอยู่ค่ะ ส่ง /claude อีกครั้งในอีกไม่กี่นาทีนะคะ",
    not_in_plan: () => "แพ็กเกจของคุณไม่รวมการเชื่อมแพ็กเกจ Claude ของตัวเองค่ะ ส่ง /plan เพื่อดูแพ็กเกจ",
    retiring: (_, until) =>
      `แพ็กเกจของคุณไม่รวมการเชื่อมแพ็กเกจ Claude ของตัวเอง เลยจะลบการเชื่อม Claude ในวันที่ ${until} ถ้าแพ็กเกจไม่กลับมาใช้งานค่ะ ส่ง /plan เพื่อดูแพ็กเกจ`,
    retired: () => "แพ็กเกจของคุณไม่รวมการเชื่อมแพ็กเกจ Claude ของตัวเอง เลยลบการเชื่อม Claude ออกแล้วค่ะ ส่ง /plan เพื่อดูแพ็กเกจ",
    removing: () => "กำลังลบการเชื่อม Claude ของคุณค่ะ",
    removed: () => "ลบการเชื่อม Claude แล้วค่ะ ถ้าใส่ API key ไว้ จากนี้จะใช้ key นั้นตอบ ส่ง /claude ถ้าอยากเชื่อมแพ็กเกจอีกครั้ง",
  },

  planAccepted: (title) => `(รับแผนแล้วค่ะ: ${title})`,
  planChanged: "(แผนนั้นเปลี่ยนไปแล้ว เลยยังไม่ได้รับไว้ค่ะ กดยอมรับที่แผนล่าสุดได้เลยนะคะ)",
  acceptButton: "ยอมรับแผนนี้",
  consentButton: "อายุ 20+ และยอมรับ",
  privacy: (notice) => `ก่อนเริ่ม ขอแจ้งให้ทราบว่าข้อความของคุณจะถูกจัดการอย่างไรนะคะ
• เราเก็บแชต รวมถึงโน้ต การเตือน และงานที่บันทึกไว้ให้คุณ เพื่อช่วยคุณได้ต่อเนื่อง ส่ง /memory เพื่อดูโน้ต การเตือน และงานของคุณ
• เพื่อตอบคุณ ข้อความและสิ่งที่บันทึกไว้จะถูกส่งไปยัง AI ที่คุณเชื่อมไว้ เช่น Anthropic หรือแพ็กเกจ Claude ของคุณ หรือ AI ที่ Giraffe จัดให้ในบางแพ็กเกจ และ LINE หรือ Telegram ก็รับส่งทุกข้อความด้วย
• บันทึกของเราเก็บ ID แอปแชต เวลา จำนวนครั้ง และค่าใช้จ่าย ไม่เก็บข้อความของคุณ
• บางบริการเหล่านี้อยู่นอกประเทศไทย
• ถ้าคุณเล่าเรื่องสุขภาพหรือเรื่องส่วนตัวที่อ่อนไหว เราจะเก็บไว้แบบเดียวกัน เพื่อช่วยคุณเท่านั้น
• ต้องมีอายุ 20 ปีขึ้นไป
ใครดูแล Giraffe เก็บข้อมูลนานเท่าไร และวิธีขอสำเนาหรือขอให้ลบ อ่านได้ที่: ${notice}
กดปุ่มด้านล่างเพื่อยอมรับค่ะ`,
  welcome: "เรียบร้อยค่ะ อยากให้ช่วยเรื่องไหนบอกได้เลย แล้วทุกเช้าจะทักมาถามนะคะ",
  waitlist: {
    no_code: "สวัสดีค่ะ ตอนนี้เปิดให้ใช้เฉพาะคนที่ได้รับเชิญก่อน ถ้ามีรหัสเชิญ ส่งมาที่นี่ได้เลยค่ะ",
    bad_code: "รหัสนี้ใช้ไม่ได้ค่ะ ลองตรวจดูแล้วส่งมาใหม่อีกครั้งนะคะ",
    used: "รหัสนี้ถูกใช้ไปแล้วค่ะ ขอรหัสใหม่จากคนที่ให้มาได้เลยนะคะ",
    full: "ตอนนี้ที่เต็มแล้วค่ะ เลยใส่ชื่อไว้ในรายชื่อรอให้แล้วนะคะ",
  },
  alreadyIn: "ตอนนี้ใช้งานอยู่แล้วค่ะ",
  removed: "ตอนนี้ไม่ได้อยู่ในรุ่นทดลองแล้ว เลยตอบข้อความไม่ได้ค่ะ",
  betaInvite: (code) => `ส่งข้อความนี้ให้เพื่อนได้เลยค่ะ ให้เพื่อนเพิ่มเราเป็นเพื่อนแล้วส่งข้อความนี้มา ใช้ได้ครั้งเดียว
/join ${code}`,
  inviteLimit: (max) => `ใช้สิทธิ์เชิญครบ ${max} คนแล้วค่ะ`,
  inviteNotEnrolled: "เฉพาะคนที่อยู่ในรุ่นทดลองเท่านั้นที่เชิญคนอื่นได้ค่ะ",

  noAccess: (o) =>
    o.box || o.key || o.included
      ? [
          "ต้องมี AI ถึงจะตอบคุณได้ค่ะ และคุณใช้ AI ของคุณเองได้ เลือกได้เลยนะคะ",
          ...(o.box ? ["• มี Claude Pro หรือ Max ไหมคะ ส่ง /claude เพื่อเชื่อมต่อ"] : []),
          ...(o.key ? ["• มี API key ไหมคะ ส่ง /key ได้เลย OpenCode Go (เดือนละ $10 ที่ opencode.ai/go) ใช้ได้ดีค่ะ key ของ Mistral ก็ใช้ได้ค่ะ จะเป็น API key จาก Studio หรือ key จากแพ็กเกจ Vibe ก็ได้ และนักเรียนนักศึกษากับครูได้ราคาพิเศษค่ะ (mistral.ai/pricing)"] : []),
          ...(o.included ? ["• หรือเลือกแพ็กเกจที่รวม AI ไว้ให้ ส่ง /plan"] : []),
          ...(o.box || o.key ? ["เมื่อเชื่อมต่อ AI ของคุณแล้ว จะตอบคำขอที่คุณส่งมาในช่วง 24 ชั่วโมงที่ผ่านมานะคะ"] : []),
          "การแจ้งเตือนที่คุณขอไว้ยังส่งถึงคุณตามปกติค่ะ",
        ].join("\n")
      : "ตอนนี้ยังเชื่อม AI ให้ไม่ได้ค่ะ แต่การแจ้งเตือนที่คุณขอไว้ยังส่งถึงคุณตามปกตินะคะ",
  boxNotReady: "ตอนนี้แพ็กเกจ Claude ของคุณยังไม่พร้อมตอบค่ะ ส่ง /claude เพื่อตรวจสอบการเชื่อมต่อได้เลยนะคะ",
  boxSignedOut: "ตอนนี้ Claude ของคุณยังไม่ได้ลงชื่อเข้าใช้ค่ะ เมื่อลงชื่อเข้าใช้แล้ว จะตอบคำขอที่คุณส่งมาในช่วง 24 ชั่วโมงที่ผ่านมานะคะ ส่ง /claude เพื่อรับลิงก์ลงชื่อเข้าใช้ค่ะ",
  catchUp: "ขอตอบข้อความที่คุณส่งมาก่อนหน้านี้นะคะ",
  ownCapReached: (cap) => `ใช้ key ของคุณครบวงเงิน $${cap} ต่อเดือนที่ตั้งไว้แล้วค่ะ ส่ง /key cap <จำนวนดอลลาร์> เพื่อเปลี่ยน วงเงินจะเริ่มใหม่วันที่ 1 ค่ะ`,
  includedCapReached: "โควตา AI ในแพ็กเกจของคุณเดือนนี้หมดแล้วค่ะ จะเริ่มใหม่วันที่ 1",
  keyRefused: (p) => `${p} ไม่รับ key ของคุณค่ะ ส่ง /key เพื่อใส่ใหม่นะคะ`,
  keyNoCredit: (p) => `บัญชี ${p} ของคุณเครดิตหมดแล้วค่ะ จะลองใช้ key นี้ได้อีกครั้งในอีกหนึ่งชั่วโมง หรือส่ง /key เพื่อใช้ key อื่นก็ได้ค่ะ`,
  keyNoModel: (p, m) => `${p} ไม่มีโมเดล ${m} ให้ใช้แล้วค่ะ ส่ง /key เพื่อเลือกโมเดลอื่นนะคะ`,
  keyRateLimited: (p, until) => (until ? `ใช้ ${p} ครบโควตาช่วงนี้แล้วค่ะ จะกลับมาใช้อีกครั้งหลัง ${until} นะคะ` : `ใช้ ${p} ครบโควตาช่วงนี้แล้วค่ะ จะลองใหม่ภายหลังนะคะ`),
  keyUnreadable: "ขอโทษค่ะ ฝั่งเราเปิด key ที่บันทึกไว้ไม่ได้แล้ว ส่ง /key เพื่อใส่ใหม่นะคะ",
  keysOff: "ตอนนี้ยังเชื่อม API key ของคุณเองไม่ได้ค่ะ",
  keyLink: (link) => `ใส่ API key ของคุณที่หน้านี้นะคะ อย่าส่ง key ในแชตเด็ดขาด ลิงก์ใช้ได้ครั้งเดียว ภายใน 15 นาทีค่ะ\n${link}`,
  keyStatus: (s) =>
    [
      `key ของคุณ: ${s.provider}, ${s.model}, ลงท้ายด้วย ${s.hint}`,
      `เดือนนี้ใช้ไป ${s.approximate ? "ประมาณ " : ""}$${s.spentUsd} จากวงเงิน $${s.capUsd}`,
      ...(s.backup === null ? [] : [s.backup ? "key นี้เป็นตัวสำรองของ Claude ค่ะ" : "ระหว่างที่เชื่อม Claude อยู่ จะไม่ใช้ key นี้ค่ะ ส่ง /key backup on ถ้าอยากให้ใช้เป็นตัวสำรอง"]),
      `เปลี่ยน key ได้ที่: ${s.link}`,
      "ส่ง /key cap <จำนวนดอลลาร์> เพื่อเปลี่ยนวงเงิน หรือ /key remove เพื่อลบ key ค่ะ",
    ].join("\n"),
  keyResting: "ตอนนี้ key ของคุณยังใช้ไม่ได้ค่ะ จะลองใหม่ภายหลังนะคะ",
  keyConnected: (p, m) => `เชื่อมต่อแล้วค่ะ: ${p} (${m}) ต่อจากนี้ข้อความของคุณจะใช้ key ของคุณเองนะคะ`,
  backupAsk: (p) => `คุณเชื่อมทั้ง Claude และ key ของ ${p} ไว้แล้ว ให้ใช้ key เป็นตัวสำรองตอนที่ Claude ใช้ไม่ได้ไหมคะ จะเสียเงินจาก key ก็ต่อเมื่อ Claude ตอบไม่ได้เท่านั้นค่ะ`,
  backupButton: "ใช้ key เป็นตัวสำรอง",
  backupOn: "ได้ค่ะ key ของคุณจะเป็นตัวสำรองของ Claude ส่ง /key backup off ถ้าอยากหยุด",
  backupOff: "ได้ค่ะ ระหว่างที่เชื่อม Claude อยู่ จะไม่ใช้ key ของคุณนะคะ",
  backupStale: "คำถามนั้นเป็นของ key ที่เปลี่ยนหรือลบไปแล้ว เลยยังไม่ได้เปลี่ยนอะไรค่ะ ส่ง /key backup on ถ้าอยากให้ key ปัจจุบันเป็นตัวสำรองของ Claude",
  noKey: "ยังไม่ได้ใส่ API key ไว้ค่ะ",
  keyRemoved: "ลบ key ของคุณแล้วค่ะ ไม่ได้เก็บไว้อีก",
  keyCapSet: (cap) => `ตั้งวงเงินต่อเดือนของ key เป็น $${cap} แล้วค่ะ`,
  keyCapRange: (min, max) => `วงเงินต้องอยู่ระหว่าง $${min} ถึง $${max} ค่ะ เช่น /key cap 10`,
  pastedKey: (link) =>
    [
      "ข้อความนั้นดูเหมือน API key เลยลบออกจากประวัติแชตแล้วค่ะ แอปแชตอ่านข้อความได้ เพราะฉะนั้นช่วยยกเลิก key นั้นที่ผู้ให้บริการ แล้วสร้าง key ใหม่นะคะ",
      ...(link ? [`แล้วใส่ key ใหม่ที่หน้านี้แทน อย่าส่งในแชตนะคะ\n${link}`] : []),
    ].join("\n"),
  keyPage: {
    title: "เชื่อมต่อ AI ของคุณ",
    intro: "key ของคุณจะถูกเข้ารหัสและเก็บไว้ใช้กับผู้ช่วยของคุณเท่านั้น ส่ง /key remove ในแชตเพื่อลบได้ทุกเมื่อค่ะ",
    provider: "ผู้ให้บริการ",
    model: "โมเดล",
    baseUrl: "Base URL (https)",
    key: "API key",
    connect: "เชื่อมต่อ",
    checking: "กำลังตรวจ key ด้วยคำขอเล็กๆ หนึ่งครั้งค่ะ…",
    connected: "เชื่อมต่อแล้วค่ะ กลับไปที่แชตได้เลย",
    getKey: "สมัครรับ key",
    errors: {
      bad_form: "ข้อมูลในฟอร์มยังไม่ครบค่ะ ตรวจแล้วลองใหม่อีกครั้งนะคะ",
      unknown_provider: "เลือกผู้ให้บริการจากรายการนะคะ",
      bad_url: "Base URL ต้องเป็นที่อยู่ https ค่ะ",
      no_model: "พิมพ์ชื่อโมเดลที่จะใช้ด้วยนะคะ",
      key_shape: "ดูไม่เหมือน key ของผู้ให้บริการนี้ค่ะ ลองตรวจว่าคัดลอกมาครบไหมนะคะ",
      expired: "ลิงก์นี้หมดอายุแล้วค่ะ ส่ง /key ในแชตเพื่อรับลิงก์ใหม่นะคะ",
      used: "ลิงก์นี้ใช้ไปแล้วค่ะ ส่ง /key ในแชตเพื่อรับลิงก์ใหม่นะคะ",
      busy: "ยังตรวจ key จากครั้งก่อนอยู่ค่ะ รอสักครู่นะคะ",
      superseded: "key ของคุณเปลี่ยนไประหว่างนี้ เลยไม่ได้บันทึก key นี้ค่ะ ส่ง /key เพื่อรับลิงก์ใหม่นะคะ",
      bad_key: "ผู้ให้บริการไม่รับ key นี้ค่ะ ส่ง /key ในแชตเพื่อรับลิงก์ใหม่แล้วลองอีกครั้งนะคะ",
      no_credit: "ผู้ให้บริการแจ้งว่าบัญชีนี้ไม่มีเครดิตค่ะ เติมเครดิตแล้วส่ง /key เพื่อรับลิงก์ใหม่นะคะ",
      bad_model: "ผู้ให้บริการไม่มีโมเดลนั้นค่ะ ส่ง /key เพื่อรับลิงก์ใหม่แล้วเลือกโมเดลอื่นนะคะ",
      rate_limited: "ตอนนี้ผู้ให้บริการจำกัดการใช้ key นี้อยู่ค่ะ ส่ง /key เพื่อรับลิงก์ใหม่แล้วลองภายหลังนะคะ",
      unreachable: "ติดต่อผู้ให้บริการไม่ได้ค่ะ ส่ง /key เพื่อรับลิงก์ใหม่แล้วลองอีกครั้งนะคะ",
      no_json: "โมเดลนี้ตอบในรูปแบบที่ต้องการไม่ได้ค่ะ ส่ง /key เพื่อรับลิงก์ใหม่แล้วเลือกโมเดลอื่นนะคะ",
      over_cap: "key ของคุณใช้ครบวงเงินเดือนนี้แล้ว เลยยังตรวจไม่ได้ค่ะ ส่ง /key cap <จำนวนดอลลาร์> เพื่อเพิ่มวงเงินนะคะ",
    },
  },
};

export const NOTICES: { readonly [L in Language]: Notices } = { en, th };
