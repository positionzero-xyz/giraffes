import type { Admission, Cohort, EpochMs, Half, InviteCode, Language, Seat, TimeOfDay, TimeZone, WaitlistReason } from "../domain";
import type { NewWakeup } from "../policy/schedule";
import type { Batch } from "./turn";

export const ADMISSION = { caps: { recruit: 40, joiner: 60 }, invitesPerPerson: 5 } as const;

/** `beta` admits by invite code and consent; `open` admits everyone at first contact. */
export const ADMISSION_MODES = ["beta", "open"] as const;
export type AdmissionMode = (typeof ADMISSION_MODES)[number];

/** Presenting a code only reads D1, so nobody holds a seat they never consented to. */
export type InviteCheck = { readonly kind: "ok"; readonly cohort: Cohort; readonly half: Half | null } | { readonly kind: "bad_code" | "used" | "full" };
export type SeatAnswer = { readonly kind: "granted"; readonly seat: Seat } | { readonly kind: "bad_code" | "used" | "full" };

export const ADMISSION_CHANGES = ["waitlisted", "consenting", "consented", "removed"] as const;
export type AdmissionChange = (typeof ADMISSION_CHANGES)[number];

export type AdmissionCommit = {
  readonly next: Admission;
  /** Logged; null when nothing a gate reads changed, such as a daily reminder to send a code. */
  readonly change: AdmissionChange | null;
  readonly ensureCheckin: NewWakeup | null;
};

export type AdmissionView = {
  readonly now: EpochMs;
  readonly tz: TimeZone;
  readonly language: Language;
  readonly checkinLocal: TimeOfDay;
  readonly admission: Admission;
  readonly batch: Batch;
};

export type AdmissionAnswer = { readonly kind: "checked"; readonly check: InviteCheck } | { readonly kind: "claimed"; readonly seat: SeatAnswer };

export type AdmissionStep =
  | { readonly kind: "check"; readonly code: InviteCode }
  | { readonly kind: "claim"; readonly code: InviteCode }
  | { readonly kind: "commit"; readonly commit: AdmissionCommit; readonly text: string | null; readonly consent: boolean };

/**
 * Called once with `answer = null`. When it returns check or claim, the agent asks D1 and calls it again with the answer.
 * A code is checked when it is presented and the seat is claimed when the person consents. Anyone not admitted
 * is told to send a code at most once per local day.
 */
export function planAdmission(view: AdmissionView, answer: AdmissionAnswer | null): AdmissionStep {
  void view;
  void answer;
  throw new Error("not implemented");
}
