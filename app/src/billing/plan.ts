import type { AgentKey, Brand, EpochMs } from "../domain";

/** `included` runs on our own quota and is sold only while INCLUDED=on; a subscription still on the old `ai` product reads as it. */
export const PAID_PLANS = ["standard", "plus", "included"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
type PlanKind = "trial" | PaidPlan | "lapsed";

export type SubscriptionId = Brand<string, "SubscriptionId">;
export type CustomerId = Brand<string, "CustomerId">;

export const SUBSCRIPTION_STATUSES = ["incomplete", "incomplete_expired", "trialing", "active", "past_due", "unpaid", "paused", "canceled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stripe retries a failed renewal while the subscription is past_due; the plan stays this long from when we first saw it. */
export const PAST_DUE_GRACE_MS = 14 * DAY_MS;
export const TERMINAL: readonly SubscriptionStatus[] = ["canceled", "incomplete_expired"];

export function isPaying(status: SubscriptionStatus, pastDueSince: EpochMs | null, now: EpochMs): boolean {
  switch (status) {
    case "active":
    case "trialing":
      return true;
    case "past_due":
      return pastDueSince !== null && now - pastDueSince < PAST_DUE_GRACE_MS;
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
    case "paused":
    case "canceled":
      return false;
  }
}

export type PlanRules = {
  readonly trialDays: number;
  readonly plusSeats: number;
  readonly plusMaxSeats: number;
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

/** `trialEndsAt` is null until the person is admitted with billing on, or sends their first message with billing on after admission. */
export type PlanRow = Standing & { readonly trialEndsAt: EpochMs | null };

export type Plan =
  | { readonly kind: "trial"; readonly endsAt: EpochMs | null }
  | { readonly kind: "standard" | "included" }
  | { readonly kind: "plus"; readonly role: "owner" | "member" }
  | { readonly kind: "lapsed" };

export const trialEnd = (start: EpochMs, rules: PlanRules): EpochMs => (start + rules.trialDays * DAY_MS) as EpochMs;

export function planOf(row: PlanRow | null, now: EpochMs, billing: boolean, rules: PlanRules): Plan {
  const own = row?.own?.plan ?? null;
  if (own === "plus") return { kind: "plus", role: "owner" };
  if (own === "standard") return { kind: "standard" };
  if (row?.seat) return { kind: "plus", role: "member" };
  if (own === "included") return { kind: "included" };
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
    case "included":
    case "lapsed":
      return false;
  }
}

export const daysLeft = (endsAt: EpochMs, now: EpochMs): number => Math.max(1, Math.ceil((endsAt - now) / DAY_MS));
