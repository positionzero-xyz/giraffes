import type { AgentKey, Brand, EpochMs, MicroUsd } from "../domain";
import { SPEND } from "../policy/spend";

export const PAID_PLANS = ["standard", "plus", "ai"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
type PlanKind = "trial" | PaidPlan | "lapsed";

export type SubscriptionId = Brand<string, "SubscriptionId">;
export type CustomerId = Brand<string, "CustomerId">;

export const SUBSCRIPTION_STATUSES = ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "unpaid", "paused", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Stripe keeps retrying a past_due invoice, so the person keeps the plan until it gives up. */
export const PAYING: readonly SubscriptionStatus[] = ["active", "trialing", "past_due"];
export const TERMINAL: readonly SubscriptionStatus[] = ["canceled", "incomplete_expired"];

export type PlanRules = {
  readonly trialDays: number;
  readonly plusSeats: number;
  readonly plusMaxSeats: number;
  readonly aiCapMicro: MicroUsd;
};

export type Subscription = {
  readonly id: SubscriptionId;
  readonly owner: AgentKey;
  readonly customer: CustomerId | null;
  readonly plan: PaidPlan;
  readonly status: SubscriptionStatus;
  readonly seats: number;
};

export type Standing = {
  readonly own: { readonly id: SubscriptionId; readonly plan: PaidPlan } | null;
  readonly seat: { readonly id: SubscriptionId; readonly owner: AgentKey } | null;
};

export const NO_STANDING: Standing = { own: null, seat: null };

/** `trialEndsAt` is null until the person's first message with billing on. */
export type PlanRow = Standing & { readonly trialEndsAt: EpochMs | null };

export type Plan =
  | { readonly kind: "trial"; readonly endsAt: EpochMs | null }
  | { readonly kind: "standard" | "ai" }
  | { readonly kind: "plus"; readonly role: "owner" | "member" }
  | { readonly kind: "lapsed" };

const DAY_MS = 24 * 60 * 60 * 1000;

export const trialEnd = (start: EpochMs, rules: PlanRules): EpochMs => (start + rules.trialDays * DAY_MS) as EpochMs;

export function planOf(row: PlanRow | null, now: EpochMs, billing: boolean, rules: PlanRules): Plan {
  const own = row?.own?.plan ?? null;
  if (own === "plus") return { kind: "plus", role: "owner" };
  if (own === "standard") return { kind: "standard" };
  if (row?.seat) return { kind: "plus", role: "member" };
  if (own === "ai") return { kind: "ai" };
  if (!billing) return { kind: "trial", endsAt: null };
  const endsAt = row?.trialEndsAt ?? trialEnd(now, rules);
  return endsAt > now ? { kind: "trial", endsAt } : { kind: "lapsed" };
}

export function planAllowsBox(plan: PlanKind): boolean {
  switch (plan) {
    case "trial":
    case "standard":
    case "plus":
      return true;
    case "ai":
    case "lapsed":
      return false;
  }
}

export function apiCapOf(plan: PlanKind, rules: PlanRules): MicroUsd {
  return plan === "ai" ? rules.aiCapMicro : SPEND.userCapMicro;
}

export const daysLeft = (endsAt: EpochMs, now: EpochMs): number => Math.max(1, Math.ceil((endsAt - now) / DAY_MS));
