/**
 * Sets up the Stripe account for BILLING=on: products, THB monthly prices (lookup keys giraffes_standard,
 * giraffes_plus, giraffes_seat, giraffes_ai) and the webhook endpoint, then prints the values to set on the
 * Worker. A second run creates nothing. A changed amount creates a new price and moves the lookup key to it.
 *
 *   STRIPE_SECRET_KEY=sk_test_... PUBLIC_URL=https://<worker> node scripts/stripe-setup.ts --yes
 *
 * Amounts are satang a month: --standard 29900 --plus 69900 --seat 19900 --ai 17900 (the defaults).
 * A live key also needs --live.
 */
import { DEFAULT_AMOUNTS, PRICE_NAMES, stripeSetup, type PriceName } from "../src/billing/setup.ts";

const args = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (!args.includes("--yes")) fail("This creates products, prices and a webhook endpoint in the Stripe account. Re-run with --yes.");

const secretKey = process.env.STRIPE_SECRET_KEY ?? fail("STRIPE_SECRET_KEY is required");
const publicUrl = process.env.PUBLIC_URL ?? fail("PUBLIC_URL is required, the Worker's https URL");
if (!/^https:\/\//.test(publicUrl)) fail("PUBLIC_URL must start with https://");
if (/^(sk|rk)_live_/.test(secretKey) && !args.includes("--live")) fail("That is a live key. Re-run with --live to set up the live account.");
if (!/^(sk|rk)_(test|live)_/.test(secretKey)) fail("STRIPE_SECRET_KEY must be a Stripe secret or restricted key");

const amounts = { ...DEFAULT_AMOUNTS } as Record<PriceName, number>;
for (const name of PRICE_NAMES) {
  const at = args.indexOf(`--${name}`);
  if (at === -1) continue;
  const n = Number(args[at + 1]);
  if (!Number.isInteger(n) || n <= 0) fail(`--${name} takes a whole number of satang`);
  amounts[name] = n;
}

const result = await stripeSetup({ secretKey, publicUrl, amounts, fetch });
for (const line of result.log) console.log(line);
console.log("\nSet these on the Worker (vars or `npx wrangler secret put <NAME>`):");
console.log("BILLING=on");
console.log(`PUBLIC_URL=${publicUrl.replace(/\/+$/, "")}`);
console.log("STRIPE_SECRET_KEY=<the key you ran this with>");
for (const name of PRICE_NAMES) console.log(`STRIPE_PRICE_${name.toUpperCase()}=${result.prices[name]}`);
console.log(
  result.webhook.secret
    ? `STRIPE_WEBHOOK_SECRET=${result.webhook.secret}`
    : `STRIPE_WEBHOOK_SECRET=<unchanged; Stripe shows an endpoint's secret only when it is created. Find it for ${result.webhook.id} in the dashboard>`,
);
