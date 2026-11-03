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
  /** `secret` is only known when the endpoint was created by this run. */
  readonly webhook: { readonly id: string; readonly secret: string | null };
  readonly log: readonly string[];
};

type Price = { id: string; product: string; unit_amount: number | null; currency: string; recurring: { interval: string } | null };
type Endpoint = { id: string; url: string; secret?: string };

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

  const url = `${o.publicUrl.replace(/\/+$/, "")}/webhook/stripe`;
  const events = Object.fromEntries(STRIPE_EVENT_TYPES.map((t, i) => [`enabled_events[${i}]`, t]));
  const endpoints = await call<{ data: Endpoint[] }>("GET", "/webhook_endpoints", { limit: 100 });
  const existing = endpoints.body.data.find((e) => e.url === url);
  if (existing) {
    await call("POST", `/webhook_endpoints/${existing.id}`, events);
    log.push(`webhook ${url}: exists, events set`);
    return { prices, webhook: { id: existing.id, secret: null }, log };
  }
  const made = await call<Endpoint>("POST", "/webhook_endpoints", { url, description: "Giraffes Worker", ...events });
  log.push(`webhook ${url}: created`);
  return { prices, webhook: { id: made.body.id, secret: made.body.secret ?? null }, log };
}
