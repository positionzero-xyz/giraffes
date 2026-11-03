export const STRIPE_API = "https://api.stripe.com/v1";

export const PRICE_NAMES = ["standard", "plus", "seat", "ai"] as const;
export type PriceName = (typeof PRICE_NAMES)[number];

/** `stripe-setup.ts` gives each price's product this id and the price this lookup key. */
export const priceKey = (p: PriceName) => `giraffes_${p}`;

export const STRIPE_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

export type Form = Record<string, string | number>;

export function formBody(form: Form): string {
  return Object.entries(form)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}
