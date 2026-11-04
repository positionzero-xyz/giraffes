import { DEFAULT_AMOUNTS, PRICE_NAMES, stripeSetup, type PriceName } from "../src/billing/setup.ts";

const args = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (!args.includes("--yes")) fail("This creates products, prices, a customer portal configuration and a webhook endpoint in the Stripe account. Re-run with --yes.");

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

const included = args.includes("--included");
const result = await stripeSetup({ secretKey, publicUrl, amounts, included, fetch });
for (const line of result.log) console.log(line);
console.log("\nSet these on the Worker (vars or `npx wrangler secret put <NAME>`):");
console.log("BILLING=on");
console.log(`PUBLIC_URL=${publicUrl.replace(/\/+$/, "")}`);
console.log("STRIPE_SECRET_KEY=<the key you ran this with>");
for (const name of PRICE_NAMES) if (result.prices[name]) console.log(`STRIPE_PRICE_${name.toUpperCase()}=${result.prices[name]}`);
console.log(`STRIPE_PORTAL_CONFIGURATION=${result.portal}`);
console.log(
  result.webhook.secret
    ? `STRIPE_WEBHOOK_SECRET=${result.webhook.secret}`
    : `STRIPE_WEBHOOK_SECRET=<unchanged; Stripe shows an endpoint's secret only when it is created. Find it for ${result.webhook.id} in the dashboard>`,
);
