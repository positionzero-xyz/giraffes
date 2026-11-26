import { z } from "zod";
import { HOST_OK, type BoxHost, type Fetch, type FlyBoxRetirement, type HostFailure, type HostResult } from "./host.ts";
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
const AppsReply = z.object({ apps: z.array(z.object({ name: z.string() })) });
const IpsReply = z.object({ ips: z.array(z.object({ ip: z.string(), shared: z.boolean().nullish(), egress: z.boolean().nullish() })).nullable() });
export const FlyVolumesReply = z.array(z.object({ id: z.string(), name: z.string(), state: z.string(), auto_backup_enabled: z.boolean().optional() }));
const RetirementVolumes = z.array(z.object({ id: z.string(), state: z.string(), attached_machine_id: z.string().nullish() }));
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

export function flyHost(cfg: FlyConfig, fetch: Fetch, log: StepLog = () => {}, timeoutMs: number = FLY_TIMEOUT_MS): BoxHost & FlyBoxRetirement {
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
    if (!success(r.status)) {
      return { ...fail(false, `${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`), ...(r.status === 404 ? { missing: true as const } : {}) };
    }
    const parsed = schema.safeParse(r.body);
    return parsed.success ? parsed.data : fail(false, `${what}: unexpected reply`);
  }

  const failed = (x: unknown): x is HostFailure => typeof x === "object" && x !== null && "ok" in x && x.ok === false;

  async function retirementVolumes(name: BoxName) {
    const path = `/apps/${name}/volumes`;
    const listed = await call("GET", path);
    return listed.ok ? read(listed, RetirementVolumes, `GET ${path}`) : listed;
  }

  /** App names the org token can see. Only a successful read proves an app is absent. */
  async function appNames(): Promise<readonly string[] | HostFailure> {
    const path = `/apps?org_slug=${encodeURIComponent(cfg.org)}`;
    const listed = await call("GET", path);
    if (!listed.ok) return listed;
    const reply = read(listed, AppsReply, `GET ${path}`);
    if (failed(reply)) return { ok: false, retryable: true, detail: reply.detail };
    return reply.apps.map(({ name: app }) => app);
  }

  /**
   * A name alone is not ownership. Read the app and require this org. A 404 is only gone when a
   * successful org app list omits the name; an unreadable list holds instead of claiming removal.
   */
  async function ownership(name: BoxName): Promise<HostResult> {
    const got = await call("GET", `/apps/${name}`);
    if (!got.ok) return got;
    if (got.status === 404) {
      const names = await appNames();
      if (failed(names)) return names;
      return names.includes(name)
        ? fail(true, `app ${name} is listed but unreadable`)
        : { ...fail(false, `app ${name} is gone`), missing: true };
    }
    const owner = read(got, AppReply, `GET /apps/${name}`);
    if (failed(owner)) return { ...fail(true, owner.detail) };
    if (!owner.organization || owner.organization.slug !== cfg.org) {
      return fail(false, `app ${name} ownership unverified`);
    }
    return HOST_OK;
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
    if (owner.organization && owner.organization.slug !== cfg.org) return fail(false, `app ${name} belongs to ${owner.organization.slug}`);
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
    async retirementTarget(name) {
      const owned = await ownership(name);
      if (failed(owned)) return owned;
      const volumes = await retirementVolumes(name);
      if (failed(volumes)) {
        if (!volumes.missing) return volumes;
        const again = await ownership(name);
        return failed(again) ? again : fail(true, `app ${name} disappeared after locate`);
      }
      const live = volumes.filter((v) => !GONE_VOLUME.has(v.state));
      const mounted = live.filter((v) => v.state === "created" && v.attached_machine_id);
      // A single mounted volume can bind the box's own wipe proof. Any other shape (none,
      // unattached, or several) has no single proof, so retirement destroys every live disk.
      const one = live.length === 1 && mounted.length === 1 ? mounted[0] : null;
      return {
        ok: true,
        target: {
          disk: one?.id ?? null,
          machine: one?.attached_machine_id ?? null,
          disks: live.map((v) => v.id),
        },
      };
    },
    async retireWipedDisk(name, target) {
      const owned = await ownership(name);
      if (failed(owned)) return owned;
      const volumes = await retirementVolumes(name);
      if (failed(volumes)) return volumes;
      const live = volumes.filter((v) => !GONE_VOLUME.has(v.state));
      const known = new Set(target.disks);
      if (live.some((v) => !known.has(v.id))) return fail(true, "unexpected live volume remains");

      const machines = new Set<string>();
      if (target.machine) machines.add(target.machine);
      for (const v of volumes) if (v.attached_machine_id && known.has(v.id)) machines.add(v.attached_machine_id);
      for (const machine of machines) {
        const removed = await call("DELETE", `/apps/${name}/machines/${encodeURIComponent(machine)}?force=true`);
        if (!removed.ok) return removed;
        if (!success(removed.status) && removed.status !== 404) return fail(true, "box machine retirement unverified");
      }

      for (const disk of new Set([...target.disks, ...(target.disk ? [target.disk] : [])])) {
        if (GONE_VOLUME.has(volumes.find((v) => v.id === disk)?.state ?? "destroyed")) continue;
        const removed = await call("DELETE", `/apps/${name}/volumes/${encodeURIComponent(disk)}`);
        if (!removed.ok) return removed;
        if (!success(removed.status) && removed.status !== 404) return fail(true, "box disk retirement unverified");
      }

      const remaining = await retirementVolumes(name);
      if (failed(remaining)) return remaining;
      if (remaining.some((v) => !GONE_VOLUME.has(v.state))) return fail(true, "box disk remains live");
      return HOST_OK;
    },
    async removeRetiredApp(name) {
      const owned = await ownership(name);
      if (failed(owned)) return owned.missing ? HOST_OK : owned;
      const removedApp = await call("DELETE", `/apps/${name}?force=true`);
      if (!removedApp.ok) return removedApp;
      if (!success(removedApp.status) && removedApp.status !== 404) return fail(true, "box app retirement unverified");
      const app = await call("GET", `/apps/${name}`);
      if (!app.ok) return app;
      if (app.status !== 404) return fail(true, "box app remains live");
      const names = await appNames();
      if (failed(names)) return names;
      if (names.includes(name)) return fail(true, "box app remains live");
      const volumes = await retirementVolumes(name);
      if (failed(volumes)) return volumes.missing ? HOST_OK : volumes;
      return volumes.some((v) => !GONE_VOLUME.has(v.state))
        ? fail(true, "box volumes remain live")
        : HOST_OK;
    },
  };
}
