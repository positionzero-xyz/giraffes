import { FLY_API, FLY_TIMEOUT_MS, FlyVolumesReply, flyAuthorization, flyHost, type FlyConfig } from "../src/box/fly.ts";
import { boxToken, newBoxSetup, signinTicket, type BoxName } from "../src/box/names.ts";
import type { EpochMs } from "../src/domain.ts";

const HEALTH_WAIT_MS = 5 * 60_000;
const HEALTH_EVERY_MS = 5_000;
const SUSPEND_WAIT_MS = 90_000;
const RESUME_WAIT_MS = 60_000;
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
const name = `${cfg.appPrefix}check-${started.toString(36)}` as BoxName;
const changed: string[] = [];
const host = flyHost(cfg, fetch, (step, outcome) => {
  console.log(`[${elapsed()}] ${step}: ${outcome}`);
  if (outcome !== "exists") changed.push(`${step} ${outcome}`);
});
const token = await boxToken(cfg.secret, name, newBoxSetup());
const url = host.urlOf(name);
const auth = { authorization: `Bearer ${token}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let step = "start";
function begin(what: string): void {
  step = what;
  console.log(`[${elapsed()}] ${what}`);
}

async function fly(method: string, path: string): Promise<unknown> {
  const res = await fetch(`${FLY_API}${path}`, {
    method,
    headers: { authorization: flyAuthorization(cfg.apiToken), "content-type": "application/json" },
    signal: AbortSignal.timeout(FLY_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

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
    await sleep(HEALTH_EVERY_MS);
  }
}

async function machineState(id: string): Promise<string> {
  const m = (await fly("GET", `/apps/${name}/machines/${id}`)) as { state?: unknown };
  return typeof m.state === "string" ? m.state : "unknown";
}

let ok = false;
console.log(`[${elapsed()}] provisioning ${name} in ${cfg.org} (${cfg.region}) from ${cfg.image}`);
try {
  begin("provisioning");
  const first = await host.ensure(name, token);
  if (!first.ok) throw new Error(`provisioning failed (retryable: ${first.retryable}): ${first.detail}`);

  begin("checking that the data volume has automatic snapshots disabled");
  const volumes = FlyVolumesReply.parse(await fly("GET", `/apps/${name}/volumes`));
  const data = volumes.find((volume) => volume.name === "data");
  if (data?.auto_backup_enabled !== false) throw new Error("Fly did not confirm automatic snapshots are disabled on the data volume");

  begin("provisioning again, which must find every step done and the machine's config current");
  changed.length = 0;
  const again = await host.ensure(name, token);
  if (!again.ok) throw new Error(`second provisioning failed: ${again.detail}`);
  if (changed.length > 0) throw new Error(`second provisioning changed ${changed.join(", ")}`);

  begin("waiting for /health");
  console.log(`[${elapsed()}] health: ${JSON.stringify(await waitForHealth())}`);

  begin("starting a sign-in");
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

  begin("suspending the machine");
  const [machine] = (await fly("GET", `/apps/${name}/machines`)) as { id: string }[];
  if (!machine) throw new Error("the app has no machine");
  await fly("POST", `/apps/${name}/machines/${machine.id}/suspend`);
  const suspendBy = Date.now() + SUSPEND_WAIT_MS;
  let state = await machineState(machine.id);
  while (state !== "suspended") {
    if (Date.now() > suspendBy) throw new Error(`the machine is ${state}, not suspended, after ${SUSPEND_WAIT_MS / 1000}s`);
    await sleep(1_000);
    state = await machineState(machine.id);
  }
  console.log(`[${elapsed()}] machine ${machine.id} is suspended`);

  begin("resuming through the proxy with /health");
  const resumeStarted = Date.now();
  const resumed = await fetch(`${url}/health`, { headers: auth, signal: AbortSignal.timeout(RESUME_WAIT_MS) });
  const resumedBody = await resumed.text();
  if (!resumed.ok) throw new Error(`/health after suspend answered ${resumed.status}: ${resumedBody.slice(0, 200)}`);
  console.log(`[${elapsed()}] resumed in ${Date.now() - resumeStarted}ms: ${resumedBody}`);
  ok = true;
} catch (err) {
  console.error(`[${elapsed()}] FAILED while ${step}: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  const deleted = await host.destroy(name).catch((err: unknown) => ({ ok: false as const, detail: String(err) }));
  console.log(`[${elapsed()}] delete ${name}: ${deleted.ok ? "done" : `FAILED, delete it by hand: ${deleted.detail}`}`);
  if (!deleted.ok) ok = false;
}
process.exit(ok ? 0 : 1);
