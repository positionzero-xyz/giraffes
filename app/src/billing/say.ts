import type { EpochMs, Language } from "../domain";
import { NOTICES } from "../notices";
import { daysLeft, type PaidPlan, type Plan, type PlanRules } from "./plan";
import type { Places } from "./store";

export const INVITE_FOR_MS = 7 * 24 * 60 * 60_000;
const LINK_NOTE = "<payment link>";
export const MANAGE_NOTE = "<billing link>";

const LABEL: Readonly<Record<PaidPlan, string>> = { standard: "Standard", plus: "Plus", ai: "AI" };

export function planStatus(plan: Plan, now: EpochMs, places: Places | null, lang: Language): string {
  const t = NOTICES[lang];
  switch (plan.kind) {
    case "trial":
      return plan.endsAt === null ? t.freeBeta : t.onTrial(daysLeft(plan.endsAt, now));
    case "standard":
      return t.onStandard;
    case "ai":
      return t.onAi;
    case "plus":
      return plan.role === "member" ? t.onPlusMember : t.onPlusOwner(places);
    case "lapsed":
      return t.noPlan;
  }
}

export type Links = Readonly<Record<PaidPlan, string>>;

export function planChoices(rules: PlanRules, links: Links | null, lang: Language): { readonly text: string; readonly note: string } {
  const t = NOTICES[lang];
  const lines = (link: (p: PaidPlan) => string) =>
    [t.pickPlan, t.standardChoice(link("standard")), t.plusChoice(link("plus"), rules.plusSeats, rules.plusMaxSeats), t.aiChoice(link("ai"))].join("\n");
  return { text: lines((p) => links?.[p] ?? LINK_NOTE), note: lines(() => LINK_NOTE) };
}

export function planChanged(before: Plan, after: Plan, now: EpochMs, lang: Language): string | null {
  if (before.kind === after.kind && (before.kind !== "plus" || after.kind !== "plus" || before.role === after.role)) return null;
  const t = NOTICES[lang];
  switch (after.kind) {
    case "standard":
    case "ai":
      return t.planActive(LABEL[after.kind]);
    case "plus":
      return after.role === "owner" ? t.plusOwnerActive : t.plusMemberActive;
    case "trial":
      return after.endsAt === null ? null : t.planEnded(daysLeft(after.endsAt, now));
    case "lapsed":
      return t.lapsed;
  }
}
