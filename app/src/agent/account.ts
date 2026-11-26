import type { AgentKey, EpochMs, ForgetEpoch, Identity, Language, OutboxId, ReplyHandle } from "../domain";
import type { CheckoutId } from "../billing/stripe";
import type { BoxName } from "../box/names";
import type { BoxHostKind, FlyDiskRetirement } from "../box/host";

export const ACCOUNT_CHALLENGE_MS = 15 * 60_000;
export const ACCOUNT_RETRY_MS = 60_000;
export const ACCOUNT_RECEIPT_MS = 24 * 60 * 60_000;
export const ERASE_CHALLENGE = "account:erase-confirmation";
export const START_CHALLENGE = "account:start-confirmation";
export const ERASE_JOB = "account:erase";

export type AccountChallenge = { readonly digest: string; readonly expiresAt: EpochMs; readonly epoch: ForgetEpoch };

type EraseBoxTarget = {
  readonly name: BoxName;
  readonly host: BoxHostKind;
  readonly url: string;
  readonly incarnation: string | null;
};

export type EraseBox =
  | { readonly kind: "none" }
  | { readonly kind: "find" }
  | { readonly kind: "unverified" }
  | { readonly kind: "done"; readonly host: BoxHostKind }
  | { readonly kind: "locate" | "wipe-static"; readonly box: EraseBoxTarget }
  | { readonly kind: "wipe-fly" | "remove-volume" | "remove-app"; readonly box: EraseBoxTarget; readonly target: FlyDiskRetirement };

type ErasureIdentity = {
  readonly id: OutboxId;
  readonly person: AgentKey;
  readonly to: Identity;
  readonly language: Language;
  readonly epoch: ForgetEpoch;
  readonly reply?: ReplyHandle;
};

export type Erasure = ErasureIdentity & (
  | { readonly kind: "cleaning"; readonly checkouts: readonly CheckoutId[]; readonly box: EraseBox; readonly paid?: boolean }
  | { readonly kind: "receipt"; readonly expiresAt: EpochMs; readonly attempted: boolean; readonly hadBox: boolean; readonly paid: boolean }
);

export async function digestChallenge(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function newAccountChallenge(epoch: ForgetEpoch, now: EpochMs) {
  const raw = crypto.randomUUID().replaceAll("-", "");
  const record: AccountChallenge = { digest: await digestChallenge(raw), expiresAt: (now + ACCOUNT_CHALLENGE_MS) as EpochMs, epoch };
  return { raw, record };
}

export const ACCOUNT_COPY = {
  en: {
    confirm: "Stop Giraffe and permanently delete your account data? Your reminders, tasks, and AI connections will end. If you own a paid Giraffe plan, it will be canceled and its shared seats will end. Payment records and provider backups can remain.",
    confirmButton: "Stop and delete",
    pending: "Account deletion is in progress. Giraffe has stopped processing your messages.",
    restart: "To start using Giraffe, agree to start a new account. Giraffe uses your messages to provide the service. Your chat and AI providers handle data under their own policies. You can send /erase to stop and delete your account.",
    restartButton: "Start fresh",
    receipt: "Giraffe stopped and deleted your live Giraffe data. Cloudflare restore copies can remain for up to 30 days. Your chat and AI providers may keep copies under their own policies.",
    box: "Fly may retain older disk snapshots for up to 60 days.",
    billing: "Any Giraffe subscriptions you owned have ended. Stripe may keep required payment records and historical checkout references.",
  },
  th: {
    confirm: "หยุดใช้ Giraffe และลบข้อมูลบัญชีของคุณอย่างถาวรไหม การเตือน งาน และการเชื่อมต่อ AI จะหยุด หากคุณเป็นเจ้าของแพ็กเกจแบบชำระเงิน แพ็กเกจและสิทธิ์ที่แชร์จะสิ้นสุด ประวัติการชำระเงินและข้อมูลสำรองของผู้ให้บริการอาจยังคงอยู่",
    confirmButton: "หยุดและลบข้อมูล",
    pending: "กำลังลบข้อมูลบัญชี Giraffe หยุดประมวลผลข้อความของคุณแล้ว",
    restart: "หากต้องการใช้ Giraffe ให้ยืนยันเพื่อเริ่มบัญชีใหม่ Giraffe ใช้ข้อความของคุณเพื่อให้บริการ ผู้ให้บริการแชตและ AI จัดการข้อมูลตามนโยบายของตน คุณส่ง /erase เพื่อหยุดใช้และลบบัญชีได้",
    restartButton: "เริ่มใหม่",
    receipt: "Giraffe หยุดทำงานและลบข้อมูลบัญชีที่ใช้งานอยู่แล้ว ข้อมูลสำหรับกู้คืนของ Cloudflare อาจคงอยู่ได้ถึง 30 วัน ผู้ให้บริการแชตและ AI อาจเก็บข้อมูลตามนโยบายของตน",
    box: "Fly อาจเก็บสำเนาดิสก์เดิมได้ถึง 60 วัน",
    billing: "หากคุณเป็นเจ้าของแพ็กเกจ Giraffe แพ็กเกจนั้นสิ้นสุดแล้ว Stripe อาจเก็บข้อมูลการชำระเงินที่จำเป็นและข้อมูลอ้างอิงการชำระเงินเดิม",
  },
} satisfies Record<Language, Readonly<Record<string, string>>>;
