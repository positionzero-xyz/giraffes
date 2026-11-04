import {
  parseInviteCode,
  type Admission,
  type Cohort,
  type EpochMs,
  type Half,
  type InviteCode,
  type Language,
  type Seat,
  type TimeOfDay,
  type TimeZone,
  type WaitlistReason,
} from "../domain";
import { NOTICES } from "../notices";
import { checkinWakeup, type NewWakeup } from "../policy/schedule";
import { localDate } from "../policy/time";
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
  const a = view.admission;
  const t = NOTICES[view.language];
  const today = localDate(view.now, view.tz);
  const say = (next: Admission, change: AdmissionChange | null, text: string | null, consent = false, ensureCheckin: NewWakeup | null = null): AdmissionStep => ({
    kind: "commit",
    commit: { next, change, ensureCheckin },
    text,
    consent,
  });
  const waitlist = (reason: WaitlistReason) => say({ state: "waitlisted", reason, toldOn: today }, "waitlisted", t.waitlist[reason]);

  const first = view.batch.items[0].event;
  if (first.kind === "wakeup" || first.kind === "checkin" || a.state === "admitted") return say(a, null, null);
  if (a.state === "removed") return say(a, null, t.removed);
  const consented = view.batch.items.some((i) => i.event.kind === "choice" && i.event.choice.kind === "consent");
  if (a.state === "consenting" && consented) {
    if (answer?.kind !== "claimed") return { kind: "claim", code: a.code };
    const seat = answer.seat;
    if (seat.kind !== "granted") return waitlist(seat.kind);
    return say({ state: "admitted", seat: seat.seat, at: view.now }, "consented", t.welcome, false, checkinWakeup(view.now, view.tz, view.checkinLocal));
  }

  const code = codeIn(view.batch);
  if (code !== null) {
    if (answer?.kind !== "checked") return { kind: "check", code };
    return answer.check.kind === "ok" ? say({ state: "consenting", code, at: view.now }, "consenting", t.privacy, true) : waitlist(answer.check.kind);
  }
  if (a.state === "consenting") return say(a, null, t.privacy, true);
  if (a.state === "waitlisted" && a.toldOn === today) return say(a, null, null);
  const reason = a.state === "waitlisted" ? a.reason : "no_code";
  return say({ state: "waitlisted", reason, toldOn: today }, a.state === "stranger" ? "waitlisted" : null, t.waitlist[reason]);
}

/** The last code in the batch: a follow's start payload, `/join CODE`, or a message that is only a code. */
function codeIn(batch: Batch): InviteCode | null {
  let code: InviteCode | null = null;
  for (const { event: e } of batch.items) {
    if (e.kind === "lifecycle" && e.code) code = e.code;
    if (e.kind === "message") code = parseInviteCode(/^\/join\s+(\S+)$/i.exec(e.text.trim())?.[1] ?? e.text) ?? code;
  }
  return code;
}
