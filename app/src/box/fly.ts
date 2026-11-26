import { z } from "zod";
import { HOST_OK, type BoxHost, type Fetch, type HostFailure, type HostResult } from "./host.ts";
import { boxName, type BoxName, type BoxToken } from "./names.ts";

export const FLY_API = "https://api.machines.dev/v1";
export const BOX_PORT = 8789;
export const FLY_TIMEOUT_MS = 15_000;

export type FlyConfig = {
  readonly apiToken: string;
  readonly org: string;
  readonly image: string;
  readonly region: string;
  readonly volumeGb: number;
  readonly appPrefix: string;
  readonly secret: string;
};

export type FlyStep = "app" | "ip shared_v4" | "ip v6" | "volume" | "machine";
export type StepLog = (step: FlyStep, outcome: "created" | "exists" | "updated") => void;

const NameTaken = z.object({ status: z.literal("name_taken") });
const AppReply = z.object({ organization: z.object({ slug: z.string() }).nullish() });
const AppsReply = z.object({ apps: z.array(z.object({ name: z.string(), organization: z.object({ slug: z.string() }).nullish() })) });
const IpsReply = z.object({ ips: z.array(z.object({ ip: z.string(), shared: z.boolean().nullish(), egress: z.boolean().nullish() })).nullable() });
export const FlyVolumesReply = z.array(z.object({ id: z.string(), name: z.string(), state: z.string(), auto_backup_enabled: z.boolean().optional() }));
const VolumeReply = z.object({ id: z.string(), auto_backup_enabled: z.literal(false) });
const MachinesReply = z.array(z.object({ id: z.string(), config: z.unknown() }));

const GONE_VOLUME = new Set(["destroyed", "destroying", "pending_destroy"]);

type Reply = { readonly ok: true; readonly status: number; readonly body: unknown };

export function flyAuthorization(apiToken: string): string {
  return apiToken.startsWith("FlyV1 ") ? apiToken : `Bearer ${apiToken}`;
}

const fail = (retryable: boolean, detail: string): HostFailure => ({ ok: false, retryable, detail });
const exists = (status: number) => status === 409 || status === 422;
const success = (status: number) => status >= 200 && status < 300;

/** True when `have` holds every value `want` sets. Fly adds fields of its own to a machine's config, so extra ones don't count. */
function covers(want: unknown, have: unknown): boolean {
  if (Array.isArray(want)) return Array.isArray(have) && have.length === want.length && want.every((w, i) => covers(w, have[i]));
  if (typeof want === "object" && want !== null) {
    if (typeof have !== "object" || have === null) return false;
    return Object.entries(want).every(([key, w]) => covers(w, (have as Record<string, unknown>)[key]));
  }
  return want === have;
}

export function machineConfig(cfg: FlyConfig, token: BoxToken, volumeId: string) {
  return {
    region: cfg.region,
    config: {
      image: cfg.image,
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 2048 },
      env: { BOX_TOKEN: token, BOX_REQUIRE_EPOCH: "1" },
      mounts: [{ volume: volumeId, path: "/data" }],
      services: [
        {
          protocol: "tcp",
          internal_port: BOX_PORT,
          ports: [
            { port: 443, handlers: ["tls", "http"] },
            { port: 80, handlers: ["http"], force_https: true },
          ],
          autostop: "suspend",
          autostart: true,
          min_machines_running: 0,
        },
      ],
      restart: { policy: "on-failure" },
    },
  };
}

export function flyHost(cfg: FlyConfig, fetch: Fetch, log: StepLog = () => {}, timeoutMs: number = FLY_TIMEOUT_MS): BoxHost {
  const authorization = flyAuthorization(cfg.apiToken);

  async function call(method: string, path: string, body?: unknown): Promise<Reply | HostFailure> {
    const what = `${method} ${path}`;
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${FLY_API}${path}`, {
        method,
        headers: { authorization, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      return fail(true, `${what}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
    if (res.status === 429 || res.status >= 500) return fail(true, `${what}: ${res.status} ${text.slice(0, 200)}`);
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { ok: true, status: res.status, body: parsed };
  }

  function read<T>(r: Reply, schema: z.ZodType<T>, what: string): T | HostFailure {
    if (!success(r.status)) return fail(false, `${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const parsed = schema.safeParse(r.body);
    return parsed.success ? parsed.data : fail(false, `${what}: unexpected reply`);
  }

  const failed = (x: unknown): x is HostFailure => typeof x === "object" && x !== null && "ok" in x && x.ok === false;

  /** Fly accepts "personal" as an org alias but reports the org's real slug on an app. The list proves this app is ours. */
  async function ownerInOrg(name: BoxName, ownerSlug: string): Promise<boolean | HostFailure> {
    if (ownerSlug === cfg.org) return true;
    if (cfg.org !== "personal") return false;
    const listed = await call("GET", `/apps?org_slug=${encodeURIComponent(cfg.org)}`);
    if (!listed.ok) return listed;
    const apps = read(listed, AppsReply, "GET /apps?org_slug=personal");
    if (failed(apps)) return apps;
    return apps.apps.some((app) => app.name === name && app.organization?.slug === ownerSlug);
  }

  async function app(name: BoxName): Promise<HostResult> {
    const created = await call("POST", "/apps", { app_name: name, org_slug: cfg.org, network: name });
    if (!created.ok) return created;
    if (success(created.status)) {
      log("app", "created");
      return HOST_OK;
    }
    const taken = created.status === 409 || (created.status === 422 && NameTaken.safeParse(created.body).success);
    if (!taken) return fail(false, `POST /apps: ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
    const got = await call("GET", `/apps/${name}`);
    if (!got.ok) return got;
    const owner = read(got, AppReply, `GET /apps/${name}`);
    if (failed(owner)) return fail(false, `app name ${name} is taken outside ${cfg.org}`);
    if (owner.organization) {
      const owned = await ownerInOrg(name, owner.organization.slug);
      if (failed(owned)) return owned;
      if (!owned) return fail(false, `app ${name} belongs to ${owner.organization.slug}`);
    }
    log("app", "exists");
    return HOST_OK;
  }

  async function ips(name: BoxName): Promise<HostResult> {
    const listed = await call("GET", `/apps/${name}/ip_assignments`);
    if (!listed.ok) return listed;
    const reply = read(listed, IpsReply, `GET /apps/${name}/ip_assignments`);
    if (failed(reply)) return reply;
    const public6 = (ip: string) => ip.includes(":") && !ip.startsWith("fdaa:");
    const have = {
      shared_v4: (reply.ips ?? []).some((i) => i.shared === true && !i.ip.includes(":")),
      v6: (reply.ips ?? []).some((i) => i.egress !== true && public6(i.ip)),
    };
    for (const type of ["shared_v4", "v6"] as const) {
      if (have[type]) {
        log(`ip ${type}`, "exists");
        continue;
      }
      const r = await call("POST", `/apps/${name}/ip_assignments`, { type });
      if (!r.ok) return r;
      if (!success(r.status) && !exists(r.status)) return fail(false, `POST ip_assignments ${type}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      log(`ip ${type}`, success(r.status) ? "created" : "exists");
    }
    return HOST_OK;
  }

  async function volume(name: BoxName): Promise<{ readonly ok: true; readonly id: string } | HostFailure> {
    const path = `/apps/${name}/volumes`;
    const listed = await call("GET", path);
    if (!listed.ok) return listed;
    const volumes = read(listed, FlyVolumesReply, `GET ${path}`);
    if (failed(volumes)) return volumes;
    const current = volumes.find((v) => v.name === "data" && !GONE_VOLUME.has(v.state));
    if (current) {
      if (current.auto_backup_enabled === false) {
        log("volume", "exists");
        return { ok: true, id: current.id };
      }
      const updatePath = `${path}/${current.id}`;
      const r = await call("PUT", updatePath, { auto_backup_enabled: false });
      if (!r.ok) return r;
      const updated = read(r, VolumeReply, `PUT ${updatePath}`);
      if (failed(updated)) return updated;
      log("volume", "updated");
      return { ok: true, id: current.id };
    }
    const r = await call("POST", path, { name: "data", region: cfg.region, size_gb: cfg.volumeGb, auto_backup_enabled: false });
    if (!r.ok) return r;
    const made = read(r, VolumeReply, `POST ${path}`);
    if (failed(made)) return made;
    log("volume", "created");
    return { ok: true, id: made.id };
  }

  async function machine(name: BoxName, token: BoxToken, volumeId: string): Promise<HostResult> {
    const listed = await call("GET", `/apps/${name}/machines`);
    if (!listed.ok) return listed;
    const machines = read(listed, MachinesReply, `GET /apps/${name}/machines`);
    if (failed(machines)) return machines;
    const wanted = machineConfig(cfg, token, volumeId);
    const current = machines[0];
    if (current && covers(wanted.config, current.config)) {
      log("machine", "exists");
      return HOST_OK;
    }
    if (current) {
      const r = await call("POST", `/apps/${name}/machines/${current.id}`, { config: wanted.config });
      if (!r.ok) return r;
      if (!success(r.status)) return fail(false, `POST /apps/${name}/machines/${current.id}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      log("machine", "updated");
      return HOST_OK;
    }
    const r = await call("POST", `/apps/${name}/machines`, wanted);
    if (!r.ok) return r;
    if (!success(r.status)) return fail(false, `POST /apps/${name}/machines: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    log("machine", "created");
    return HOST_OK;
  }

  return {
    kind: "fly",
    image: cfg.image,
    nameFor: (agent) => boxName(cfg.secret, cfg.appPrefix, agent),
    urlOf: (name) => `https://${name}.fly.dev`,
    async ensure(name, token) {
      const a = await app(name);
      if (!a.ok) return a;
      const i = await ips(name);
      if (!i.ok) return i;
      const v = await volume(name);
      if (!v.ok) return v;
      return machine(name, token, v.id);
    },
    async destroy(name) {
      const r = await call("DELETE", `/apps/${name}?force=true`);
      if (!r.ok) return r;
      return success(r.status) || r.status === 404 ? HOST_OK : fail(false, `DELETE /apps/${name}: ${r.status}`);
    },
  };
}
