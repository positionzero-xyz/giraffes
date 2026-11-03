import { NOTICE } from "../agent/turn";
import type { EpochMs } from "../domain";
import { daysLeft, type PaidPlan, type Plan, type PlanRules } from "./plan";
import type { JoinResult, Places } from "./store";

export const INVITE_FOR_MS = 7 * 24 * 60 * 60_000;
const LINK_NOTE = "<payment link>";

const LABEL: Readonly<Record<PaidPlan, string>> = { standard: "Standard", plus: "Plus", ai: "AI" };

const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

export const BILLING_OFF = "Plans aren't available yet.";
export const BILLING_BUSY = "I couldn't do that just now. Please try again in a minute.";

export function planStatus(plan: Plan, now: EpochMs, places: Places | null): string {
  switch (plan.kind) {
    case "trial":
      return plan.endsAt === null ? "You're on the free beta, so there's nothing to pay." : `You're on the free trial, with ${days(daysLeft(plan.endsAt, now))} left.`;
    case "standard":
      return "You're on the Standard plan.";
    case "ai":
      return "You're on the AI plan.";
    case "plus":
      if (plan.role === "member") return "You're on a Plus plan someone shared with you. Send /leave to leave it.";
      return places
        ? `You're on the Plus plan, with ${places.taken} of ${places.seats} places taken. Send /invite to add someone.`
        : "You're on the Plus plan. Send /invite to add someone.";
    case "lapsed":
      return "You have no active plan, so I can't answer messages for now.";
  }
}

export type Links = Readonly<Record<PaidPlan, string>>;

export function planChoices(rules: PlanRules, links: Links | null): { readonly text: string; readonly note: string } {
  const lines = (link: (p: PaidPlan) => string) =>
    [
      "Pick a plan:",
      `Standard, your own Claude box: ${link("standard")}`,
      `Plus, a box each for up to ${rules.plusSeats} people${rules.plusMaxSeats > rules.plusSeats ? ` (add places up to ${rules.plusMaxSeats} at checkout)` : ""}: ${link("plus")}`,
      `AI, answers from our AI with no box: ${link("ai")}`,
    ].join("\n");
  return { text: lines((p) => links?.[p] ?? LINK_NOTE), note: lines(() => LINK_NOTE) };
}

export const NO_LINKS = "I couldn't make the payment links just now. Send /plan again in a minute.";

export function inviteText(code: string): string {
  return `Ask the person you want to add to send me this within 7 days. It works once.\n/join ${code}`;
}

export const INVITE_NOT_OWNER = "Only the owner of a Plus plan can invite people. Send /plan to see the plans.";
export const inviteFull = (seats: number) => `All ${seats} places on your Plus plan are taken.`;

export const JOIN: Readonly<Record<JoinResult, string>> = {
  joined: "You've joined a Plus plan. Send /claude to connect your own Claude plan.",
  bad_code: "That code doesn't work. Ask for a new one, which the Plus owner gets with /invite.",
  own: "That's your own Plus plan.",
  seated: "You're already on a Plus plan. Send /leave first.",
  ended: "That Plus plan isn't active.",
  full: "That Plus plan has no free places.",
};

export const NOT_SEATED = "You're not on someone else's Plus plan.";
export const LEFT = "You've left the Plus plan.";

export function planChanged(before: Plan, after: Plan, now: EpochMs): string | null {
  if (before.kind === after.kind && (before.kind !== "plus" || after.kind !== "plus" || before.role === after.role)) return null;
  switch (after.kind) {
    case "standard":
    case "ai":
      return `Thanks. Your ${LABEL[after.kind]} plan is active.`;
    case "plus":
      return after.role === "owner" ? "Thanks. Your Plus plan is active. Send /invite to add someone." : "The Plus plan you joined is active.";
    case "trial":
      return after.endsAt === null ? null : `Your plan has ended. You're on the free trial, with ${days(daysLeft(after.endsAt, now))} left.`;
    case "lapsed":
      return NOTICE.lapsed;
  }
}
