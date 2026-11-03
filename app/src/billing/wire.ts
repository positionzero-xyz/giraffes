/** What the Worker and `scripts/stripe-setup.ts` share about Stripe's wire format. No imports, so Node can load it directly. */

export const STRIPE_API = "https://api.stripe.com/v1";

/** The events the webhook route acts on, and the ones the setup script subscribes the endpoint to. */
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
