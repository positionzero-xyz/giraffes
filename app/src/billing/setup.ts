import { formBody, PRICE_NAMES, priceKey, STRIPE_API, STRIPE_EVENT_TYPES, type Form, type PriceName } from "./wire.ts";

export { PRICE_NAMES, type PriceName };

export const DEFAULT_AMOUNTS: Readonly<Record<PriceName, number>> = { standard: 29900, plus: 69900, seat: 19900, ai: 17900 };

const PRODUCT_NAMES: Readonly<Record<PriceName, string>> = {
  standard: "Giraffes Standard",
  plus: "Giraffes Plus",
  seat: "Giraffes Plus extra place",
  ai: "Giraffes AI",
};

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

type SetupResult = {
  readonly prices: Readonly<Record<PriceName, string>>;
  readonly portal: string;
  /** `secret` is only known when the endpoint was created by this run. */
  readonly webhook: { readonly id: string; readonly secret: string | null };
  readonly log: readonly string[];
};

type Price = { id: string; product: string; unit_amount: number | null; currency: string; recurring: { interval: string } | null };
type Endpoint = { id: string; url: string; secret?: string };
type PortalConfiguration = { id: string; active: boolean; metadata: Record<string, string> | null };

/** No seat price: the portal can't switch a subscription with two products, such as Plus with extra places. */
const PORTAL_PLANS = ["standard", "plus", "ai"] as const satisfies readonly PriceName[];

function portalForm(prices: Readonly<Record<PriceName, string>>, returnUrl: string): Form {
  const form: Form = {
    "metadata[giraffes]": "portal",
    default_return_url: returnUrl,
    "features[payment_method_update][enabled]": "true",
    "features[invoice_history][enabled]": "true",
    "features[subscription_cancel][enabled]": "true",
    "features[subscription_cancel][mode]": "at_period_end",
    "features[subscription_update][enabled]": "true",
    "features[subscription_update][default_allowed_updates][0]": "price",
    "features[subscription_update][proration_behavior]": "create_prorations",
  };
  PORTAL_PLANS.forEach((name, i) => {
    form[`features[subscription_update][products][${i}][product]`] = priceKey(name);
    form[`features[subscription_update][products][${i}][prices][0]`] = prices[name];
  });
  return form;
}

export async function stripeSetup(o: {
  readonly secretKey: string;
  readonly publicUrl: string;
  readonly amounts: Readonly<Record<PriceName, number>>;
  readonly fetch: Fetch;
}): Promise<SetupResult> {
  const log: string[] = [];

  async function call<T>(method: "GET" | "POST", path: string, form: Form = {}): Promise<{ status: number; body: T }> {
    const query = method === "GET" && Object.keys(form).length > 0 ? `?${formBody(form)}` : "";
    const res = await o.fetch(`${STRIPE_API}${path}${query}`, {
      method,
      headers: { authorization: `Bearer ${o.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
      body: method === "POST" ? formBody(form) : undefined,
    });
    const body = (await res.json().catch(() => null)) as T & { error?: { message?: string } };
    if (!res.ok && res.status !== 404) throw new Error(`${method} ${path}: ${res.status} ${body?.error?.message ?? ""}`);
    return { status: res.status, body };
  }

  const prices = {} as Record<PriceName, string>;
  for (const name of PRICE_NAMES) {
    const product = priceKey(name);
    if ((await call("GET", `/products/${product}`)).status === 404) {
      await call("POST", "/products", { id: product, name: PRODUCT_NAMES[name] });
      log.push(`product ${product}: created`);
    } else {
      log.push(`product ${product}: exists`);
    }
    const found = await call<{ data: Price[] }>("GET", "/prices", { "lookup_keys[0]": priceKey(name), active: "true" });
    const current = found.body.data[0];
    const amount = o.amounts[name];
    if (current && current.product === product && current.unit_amount === amount && current.currency === "thb" && current.recurring?.interval === "month") {
      prices[name] = current.id;
      log.push(`price ${priceKey(name)}: exists (${amount} satang a month)`);
      continue;
    }
    const made = await call<Price>("POST", "/prices", {
      product,
      currency: "thb",
      unit_amount: amount,
      "recurring[interval]": "month",
      lookup_key: priceKey(name),
      transfer_lookup_key: "true",
    });
    prices[name] = made.body.id;
    log.push(`price ${priceKey(name)}: created (${amount} satang a month)${current ? `, replacing ${current.id}` : ""}`);
  }

  const base = o.publicUrl.replace(/\/+$/, "");
  const portalSettings = portalForm(prices, `${base}/billing/done`);
  const configurations = await call<{ data: PortalConfiguration[] }>("GET", "/billing_portal/configurations", { active: "true", limit: 100 });
  const ours = configurations.body.data.find((c) => c.metadata?.giraffes === "portal");
  let portal: string;
  if (ours) {
    await call("POST", `/billing_portal/configurations/${ours.id}`, portalSettings);
    portal = ours.id;
    log.push(`portal configuration ${portal}: exists, features set`);
  } else {
    portal = (await call<PortalConfiguration>("POST", "/billing_portal/configurations", portalSettings)).body.id;
    log.push(`portal configuration ${portal}: created`);
  }

  const url = `${base}/webhook/stripe`;
  const events = Object.fromEntries(STRIPE_EVENT_TYPES.map((t, i) => [`enabled_events[${i}]`, t]));
  const endpoints = await call<{ data: Endpoint[] }>("GET", "/webhook_endpoints", { limit: 100 });
  const existing = endpoints.body.data.find((e) => e.url === url);
  if (existing) {
    await call("POST", `/webhook_endpoints/${existing.id}`, events);
    log.push(`webhook ${url}: exists, events set`);
    return { prices, portal, webhook: { id: existing.id, secret: null }, log };
  }
  const made = await call<Endpoint>("POST", "/webhook_endpoints", { url, description: "Giraffes Worker", ...events });
  log.push(`webhook ${url}: created`);
  return { prices, portal, webhook: { id: made.body.id, secret: made.body.secret ?? null }, log };
}
