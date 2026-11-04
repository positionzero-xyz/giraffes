import { describe, expect, test } from "vitest";
import { planAdmission, type AdmissionView } from "../src/agent/admission";
import type { InboxItem } from "../src/agent/turn";
import type { Admission, AgentEvent, EpochMs, EventKey, InviteCode, LocalDate, TimeZone } from "../src/domain";
import { NOTICES } from "../src/notices";

const t = NOTICES.en;
const NOW = Date.parse("2099-11-04T10:00:00+07:00") as EpochMs;
const TODAY = "2099-11-04" as LocalDate;
const code = "K7P3QZ" as InviteCode;

const message = (text: string): AgentEvent => ({ kind: "message", text });
const follow = (withCode?: InviteCode): AgentEvent => (withCode ? { kind: "lifecycle", change: "follow", at: NOW, code: withCode } : { kind: "lifecycle", change: "follow", at: NOW });
const consent: AgentEvent = { kind: "choice", choice: { kind: "consent" }, at: NOW };

function view(admission: Admission, event: AgentEvent, now: EpochMs = NOW): AdmissionView {
  const item: InboxItem = { key: "tg:1" as EventKey, event, attempts: 1, receivedAt: now };
  return { now, tz: "Asia/Bangkok" as TimeZone, language: "en", checkinLocal: "09:00", admission, batch: { items: [item] } };
}

const stranger: Admission = { state: "stranger" };
const consenting: Admission = { state: "consenting", code, at: NOW };

describe("a code is checked when it is presented", () => {
  test("a follow with a code, /join CODE and a bare code each ask D1 to check it", () => {
    expect(planAdmission(view(stranger, follow(code)), null)).toEqual({ kind: "check", code });
    expect(planAdmission(view(stranger, message("/join k7p3qz")), null)).toEqual({ kind: "check", code });
    expect(planAdmission(view(stranger, message(" K7P3QZ ")), null)).toEqual({ kind: "check", code });
    expect(planAdmission(view({ state: "waitlisted", reason: "bad_code", toldOn: TODAY }, message("K7P3QZ")), null)).toEqual({ kind: "check", code });
  });

  test("a good code asks for consent with the privacy notice and holds no seat", () => {
    const step = planAdmission(view(stranger, follow(code)), { kind: "checked", check: { kind: "ok", cohort: "recruit", half: "intl_telegram" } });
    expect(step).toEqual({
      kind: "commit",
      commit: { next: { state: "consenting", code, at: NOW }, change: "consenting", ensureCheckin: null },
      text: t.privacy,
      consent: true,
    });
  });

  test("a bad, used or full code waitlists the person and says why", () => {
    for (const kind of ["bad_code", "used", "full"] as const) {
      const step = planAdmission(view(stranger, message(code)), { kind: "checked", check: { kind } });
      expect(step, kind).toEqual({
        kind: "commit",
        commit: { next: { state: "waitlisted", reason: kind, toldOn: TODAY }, change: "waitlisted", ensureCheckin: null },
        text: t.waitlist[kind],
        consent: false,
      });
    }
  });
});

describe("without a code", () => {
  test("a stranger is asked for a code, once per local day", () => {
    const first = planAdmission(view(stranger, follow()), null);
    expect(first).toEqual({
      kind: "commit",
      commit: { next: { state: "waitlisted", reason: "no_code", toldOn: TODAY }, change: "waitlisted", ensureCheckin: null },
      text: t.waitlist.no_code,
      consent: false,
    });
    const told: Admission = { state: "waitlisted", reason: "no_code", toldOn: TODAY };
    expect(planAdmission(view(told, message("hello?")), null)).toEqual({ kind: "commit", commit: { next: told, change: null, ensureCheckin: null }, text: null, consent: false });
    const tomorrow = (NOW + 24 * 60 * 60 * 1000) as EpochMs;
    expect(planAdmission(view(told, message("hello?"), tomorrow), null)).toEqual({
      kind: "commit",
      commit: { next: { ...told, toldOn: "2099-11-05" }, change: null, ensureCheckin: null },
      text: t.waitlist.no_code,
      consent: false,
    });
  });

  test("a consent tap from a stranger is not consent", () => {
    const step = planAdmission(view(stranger, consent), null);
    expect(step).toMatchObject({ kind: "commit", commit: { next: { state: "waitlisted", reason: "no_code" } }, text: t.waitlist.no_code });
  });
});

describe("the seat is claimed at consent", () => {
  test("consent asks D1 for the seat, and a granted seat admits the person and creates the check-in", () => {
    expect(planAdmission(view(consenting, consent), null)).toEqual({ kind: "claim", code });
    const seat = { cohort: "recruit" as const, half: "intl_telegram" as const, code, inviter: null };
    const step = planAdmission(view(consenting, consent), { kind: "claimed", seat: { kind: "granted", seat } });
    expect(step).toEqual({
      kind: "commit",
      commit: {
        next: { state: "admitted", seat, at: NOW },
        change: "consented",
        ensureCheckin: { key: "daily-checkin", kind: "checkin", origin: "system", note: "Daily check-in", dueAt: Date.parse("2099-11-05T09:00:00+07:00") },
      },
      text: t.welcome,
      consent: false,
    });
  });

  test("a beta that filled up before consent waitlists the person as full", () => {
    const step = planAdmission(view(consenting, consent), { kind: "claimed", seat: { kind: "full" } });
    expect(step).toMatchObject({ kind: "commit", commit: { next: { state: "waitlisted", reason: "full" }, change: "waitlisted" }, text: t.waitlist.full });
  });

  test("anything else while consenting shows the privacy notice again and changes nothing", () => {
    expect(planAdmission(view(consenting, message("what is this?")), null)).toEqual({
      kind: "commit",
      commit: { next: consenting, change: null, ensureCheckin: null },
      text: t.privacy,
      consent: true,
    });
  });
});

test("a removed person gets a fixed reply and stays removed", () => {
  const removed: Admission = { state: "removed", at: NOW };
  expect(planAdmission(view(removed, message(code)), null)).toEqual({
    kind: "commit",
    commit: { next: removed, change: null, ensureCheckin: null },
    text: t.removed,
    consent: false,
  });
});
