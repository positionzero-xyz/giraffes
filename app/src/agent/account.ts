import type { AgentKey, EpochMs, ForgetEpoch, Identity, InviteCode, Language, OutboxId, ReplyHandle } from "../domain";
import type { CheckoutId } from "../billing/stripe";
import type { SubscriptionId } from "../billing/plan";
import type { BoxName } from "../box/names";
import type { BoxHostKind, FlyDiskRetirement } from "../box/host";

export const ACCOUNT_CHALLENGE_MS = 15 * 60_000;
export const ACCOUNT_RETRY_MS = 60_000;
export const ACCOUNT_WIPE_GRACE_MS = 60 * 60_000;
export const ACCOUNT_WIPE_RETRY_MAX_MS = 10 * 60_000;
export const ACCOUNT_RECEIPT_MS = 24 * 60 * 60_000;
export const ERASE_DIAGNOSTIC_MS = 24 * 60 * 60_000;
export const ERASE_CHALLENGE = "account:erase-confirmation";
export const START_CHALLENGE = "account:start-confirmation";
export const ERASE_JOB = "account:erase";

export type AccountChallenge = { readonly digest: string; readonly expiresAt: EpochMs; readonly epoch: ForgetEpoch };
export type StartChallenge = AccountChallenge & { readonly invite?: InviteCode };

export type EraseBoxReference = {
  readonly name: BoxName;
  readonly host: BoxHostKind;
  readonly url: string | null;
  readonly incarnation: string | null;
  /** A failed setup never offered a sign-in link. Older records may have served the person. */
  readonly neverServed?: true;
};

export type EraseBoxTarget = EraseBoxReference & { readonly url: string };

export type EraseBox =
  | { readonly kind: "none" }
  | { readonly kind: "unverified"; readonly box: EraseBoxReference }
  | { readonly kind: "wiped" | "reclaimed"; readonly host: BoxHostKind }
  /**
   * Box state invariants:
   * - App absence needs app-level evidence: a 404 on the app plus a successful org app list that
   *   omits the name. A 404 on the volume list alone never proves the app is gone.
   * - Deletion authority is the saved resource identity: the same disk id, and for an attached
   *   disk the same machine id. A replacement volume or a new machine is never deleted or wiped.
   * - A wiped outcome requires an acknowledged wipe bound to the saved disk. Deleting a detached
   *   disk is not a wipe and must keep the "could not verify a disk wipe" receipt line.
   * - While either fact is uncertain, keep the job, alarm and capacity reservation and announce
   *   nothing.
   */
  | {
    readonly kind: "relocate";
    readonly box: EraseBoxTarget;
    readonly target: FlyDiskRetirement;
  } & (
    | { readonly resume: "wipe-fly"; readonly wipeFailures?: number; readonly wipeFailedAt?: EpochMs }
    | { readonly resume: "remove-volume" | "remove-app"; readonly wipeSkipped?: true }
  )
  | { readonly kind: "locate" | "wipe-static"; readonly box: EraseBoxTarget }
  | { readonly kind: "wipe-fly"; readonly box: EraseBoxTarget; readonly target: FlyDiskRetirement; readonly verify?: boolean; readonly wipeFailures?: number; readonly wipeFailedAt?: EpochMs }
  | { readonly kind: "remove-volume" | "remove-app"; readonly box: EraseBoxTarget; readonly target: FlyDiskRetirement; readonly wipeSkipped?: true };

export type EraseBilling =
  | { readonly kind: "pending"; readonly checkouts: readonly CheckoutId[]; readonly subscriptions: readonly SubscriptionId[]; readonly endedSubscription: boolean; readonly stripeRetained: boolean }
  | { readonly kind: "done"; readonly endedSubscription: boolean; readonly stripeRetained: boolean };

type EraseLedger =
  | { readonly kind: "sweep" | "detach"; readonly invitees: readonly AgentKey[]; readonly members: readonly AgentKey[] }
  | { readonly kind: "done" };

type EraseBoxReceipt = { readonly kind: "wiped" | "reclaimed"; readonly host: BoxHostKind };

type ErasureIdentity = {
  readonly id: OutboxId;
  readonly person: AgentKey;
  readonly to: Identity;
  readonly language: Language;
  readonly epoch: ForgetEpoch;
  readonly reply?: ReplyHandle;
  readonly startedAt?: EpochMs;
  readonly diagnosedAt?: EpochMs;
  readonly nextAt?: EpochMs;
};

export type Erasure = ErasureIdentity & (
  | { readonly kind: "starting" }
  | { readonly kind: "preparing"; readonly checkouts: readonly CheckoutId[]; readonly box: EraseBoxTarget | null }
  | {
    readonly kind: "cleaning";
    readonly ledger: EraseLedger;
    readonly billing: EraseBilling;
    readonly box: EraseBox;
    readonly boxLedgerKey: string | null;
    /** Without `waitingFor` it was saved by a build that kept counting tries past the wipe deadline. */
    readonly boxRetry?: { readonly waitingFor?: "box-wipe" | "disk-delete"; readonly attempts: number; readonly nextAt: EpochMs };
  }
  | { readonly kind: "receipt"; readonly expiresAt: EpochMs; readonly attempted: boolean; readonly box: EraseBoxReceipt | null; readonly endedSubscription: boolean; readonly stripeRetained: boolean }
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
    start: "To use Giraffe, tap Start to agree. Giraffe uses your messages to provide the service. Your chat and AI providers handle data under their own policies. You can send /erase to stop and delete your account.",
    startButton: "Start",
    receipt: "Giraffe stopped and deleted your live Giraffe data. Cloudflare restore copies can remain for up to 30 days. Your chat and AI providers may keep copies under their own policies.",
    reclaimedBox: "Your box was removed earlier. Giraffe could not verify a disk wipe.",
    flyCopies: "Fly may retain older disk copies for up to 60 days after removal.",
    subscriptionEnded: "Any Giraffe subscriptions you owned have ended.",
    stripeRecords: "If you requested a payment link, Stripe may keep checkout records and historical chat account references, even if you didn’t pay. Stripe may also keep required payment records.",
    stripeRetained: "Stripe refused removal of some editable chat account references, so those references remain in Stripe records.",
    return: "To start fresh, send /start and tap Start.",
  },
  th: {
    confirm: "หยุดใช้ Giraffe และลบข้อมูลบัญชีของคุณอย่างถาวรไหม การเตือน งาน และการเชื่อมต่อ AI จะหยุด หากคุณเป็นเจ้าของแพ็กเกจแบบชำระเงิน แพ็กเกจและสิทธิ์ที่แชร์จะสิ้นสุด ประวัติการชำระเงินและข้อมูลสำรองของผู้ให้บริการอาจยังคงอยู่",
    confirmButton: "หยุดและลบข้อมูล",
    pending: "กำลังลบข้อมูลบัญชี Giraffe หยุดประมวลผลข้อความของคุณแล้ว",
    start: "หากต้องการใช้ Giraffe ให้แตะเริ่มเพื่อยืนยัน Giraffe ใช้ข้อความของคุณเพื่อให้บริการ ผู้ให้บริการแชตและ AI จัดการข้อมูลตามนโยบายของตน คุณส่ง /erase เพื่อหยุดใช้และลบบัญชีได้",
    startButton: "เริ่ม",
    receipt: "Giraffe หยุดทำงานและลบข้อมูลบัญชีที่ใช้งานอยู่แล้ว ข้อมูลสำหรับกู้คืนของ Cloudflare อาจคงอยู่ได้ถึง 30 วัน ผู้ให้บริการแชตและ AI อาจเก็บข้อมูลตามนโยบายของตน",
    reclaimedBox: "กล่องของคุณถูกนำออกไปก่อนหน้านี้ Giraffe ไม่สามารถยืนยันได้ว่าข้อมูลบนดิสก์ถูกลบแล้ว",
    flyCopies: "Fly อาจเก็บสำเนาดิสก์เดิมไว้ถึง 60 วันหลังจากนำกล่องออก",
    subscriptionEnded: "แพ็กเกจ Giraffe แบบชำระเงินที่คุณเป็นเจ้าของสิ้นสุดแล้ว",
    stripeRecords: "หากคุณเคยขอลิงก์ชำระเงิน Stripe อาจเก็บบันทึกการเปิดหน้าชำระเงินและข้อมูลอ้างอิงบัญชีแชตเดิม แม้ว่าคุณจะไม่ได้ชำระเงิน และอาจเก็บบันทึกการชำระเงินที่จำเป็น",
    stripeRetained: "Stripe ปฏิเสธการลบข้อมูลอ้างอิงบัญชีแชตบางส่วนที่แก้ไขได้ ข้อมูลเหล่านั้นจึงยังคงอยู่ในบันทึกของ Stripe",
    return: "หากต้องการเริ่มใหม่ ให้ส่ง /start แล้วแตะเริ่ม",
  },
} satisfies Record<Language, Readonly<Record<string, string>>>;
