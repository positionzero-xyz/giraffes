/**
 * Provisions one throwaway box on Fly through the Worker's own fly host, waits for /health, asks the box
 * for a sign-in URL, then deletes the app. It creates billable resources, so it runs only with --yes.
 *
 *   FLY_API_TOKEN=... FLY_ORG=... BOX_IMAGE=... BOX_SECRET=... node scripts/fly-verify.ts --yes
 *
 * Optional: BOX_REGION (default sin), BOX_VOLUME_GB (default 1), BOX_APP_PREFIX (default gbox-).
 */
import { flyHost, type FlyConfig } from "../src/box/fly.ts";
import { boxToken, signinTicket, type BoxName } from "../src/box/names.ts";
import type { EpochMs } from "../src/domain.ts";

const HEALTH_WAIT_MS = 5 * 60_000;
const HEALTH_EVERY_MS = 5_000;
const TICKET_MS = 30 * 60_000;

if (!process.argv.includes("--yes")) {
  console.error("This creates a Fly app, a volume and a machine, all billed until the script deletes them. Re-run with --yes.");
  process.exit(2);
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return v;
}

const cfg: FlyConfig = {
  apiToken: need("FLY_API_TOKEN"),
  org: need("FLY_ORG"),
  image: need("BOX_IMAGE"),
  secret: need("BOX_SECRET"),
  region: process.env.BOX_REGION ?? "sin",
  volumeGb: Number(process.env.BOX_VOLUME_GB ?? 1),
  appPrefix: process.env.BOX_APP_PREFIX ?? "gbox-",
};

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const name = `${cfg.appPrefix}verify-${started.toString(36)}` as BoxName;
const host = flyHost(cfg, fetch, (step, outcome) => console.log(`[${elapsed()}] ${step}: ${outcome}`));
const token = await boxToken(cfg.secret, name);
const url = host.urlOf(name);
const auth = { authorization: `Bearer ${token}` };

async function waitForHealth(): Promise<unknown> {
  for (;;) {
    try {
      const res = await fetch(`${url}/health`, { headers: auth, signal: AbortSignal.timeout(15_000) });
      if (res.ok) return res.json();
      console.log(`[${elapsed()}] health: ${res.status}`);
    } catch (err) {
      console.log(`[${elapsed()}] health: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (Date.now() - started > HEALTH_WAIT_MS) throw new Error(`no /health answer within ${HEALTH_WAIT_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, HEALTH_EVERY_MS));
  }
}

let ok = false;
console.log(`[${elapsed()}] provisioning ${name} in ${cfg.org} (${cfg.region}) from ${cfg.image}`);
try {
  const first = await host.ensure(name, token);
  if (!first.ok) throw new Error(`provisioning failed (retryable: ${first.retryable}): ${first.detail}`);
  console.log(`[${elapsed()}] provisioning again, which must find every step done`);
  const again = await host.ensure(name, token);
  if (!again.ok) throw new Error(`second provisioning failed: ${again.detail}`);

  console.log(`[${elapsed()}] health: ${JSON.stringify(await waitForHealth())}`);

  const ticket = await signinTicket(token, (Date.now() + TICKET_MS) as EpochMs);
  const res = await fetch(`${url}/signin/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`/signin/start answered ${res.status}: ${body.slice(0, 200)}`);
  console.log(`[${elapsed()}] sign-in URL: ${JSON.parse(body).url}`);
  ok = true;
} catch (err) {
  console.error(`[${elapsed()}] FAILED: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  const deleted = await host.destroy(name);
  console.log(`[${elapsed()}] delete ${name}: ${deleted.ok ? "done" : `FAILED, delete it by hand: ${deleted.detail}`}`);
  if (!deleted.ok) ok = false;
}
process.exit(ok ? 0 : 1);
