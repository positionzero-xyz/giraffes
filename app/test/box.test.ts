import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { boxClient } from "../src/box/client";
import { flyHost, machineConfig, type FlyConfig } from "../src/box/fly";
import { HOST_OK, staticHost, type Fetch } from "../src/box/host";
import { BOX, boxMessage, type BoxSay, type ReclaimReason } from "../src/box/machine";
import { boxName, boxSessionOwner, boxToken, signinTicket, type BoxName, type BoxToken } from "../src/box/names";
import { ACCOUNT_COPY, ERASE_JOB, type EraseBox, type Erasure } from "../src/agent/account";
import { Agent } from "../src/agent/agent";
import { MIGRATIONS } from "../src/agent/schema";
import type { StripeReply } from "../src/billing/stripe";
import { loadConfig, type Env } from "../src/config";
import type { AgentKey, EpochMs } from "../src/domain";
import { NOTICES } from "../src/notices";
import {
  billingOn,
  BOX_SECRET,
  chat,
  devChat,
  fakeBox,
  fakeProvider,
  giveKey,
  local,
  memoryLedger,
  openTask,
  propose,
  stripeChange,
  quiet,
  schedule,
  scripted,
  send,
  TEST_KEY_SECRET,
  type BillingKit,
  turn,
  type MemoryLedger,
} from "./testkit";

const NOTICE = NOTICES.en;
const say = (s: BoxSay) => boxMessage(s, "en", null).text;
const TRIP = "chiang-mai-trip";
const TITLE = "Chiang Mai long weekend";
const PLAN = "Fri 18:30 overnight train from Bangkok\nSat Doi Suthep at 7 before the heat, Nimman cafes after\nSun 16:00 flight back";
const LINK = /^https:\/\/([a-z0-9-]+)\.box\.test\/signin#t=(\d+)\.([A-Za-z0-9_-]+)$/m;

describe("names and secrets", () => {
  test("the box token and the sign-in ticket match the contract's test vector", async () => {
    const token = await boxToken("test-secret-0123456789abcdef", "gbox-0123456789ab" as BoxName);
    expect(token).toBe("b-UiaAiUIgin1zs4CJbKAY68m8rphXVQwWrWHSMO2U4");
    expect(await signinTicket(token, 1790000000000 as EpochMs)).toBe("1790000000000.AA1PzFmYf_4obmGHsfd0634YPiMbVDnmjYWbmYI62kM");
  });

  test("a box name is the prefix and 16 hex characters of HMAC(secret, 'name:' + agent key)", async () => {
    const { createHmac } = await import("node:crypto");
    const agent = "p:telegram:12345" as AgentKey;
    const expected = `gbox-${createHmac("sha256", BOX_SECRET).update(`name:${agent}`).digest("hex").slice(0, 16)}`;
    expect(await boxName(BOX_SECRET, "gbox-", agent)).toBe(expected);
    expect(await boxName(BOX_SECRET, "gbox-", "p:telegram:12346" as AgentKey)).not.toBe(expected);
  });
});

const env = (vars: Record<string, string>): Env => ({ MODEL_BACKEND: "scripted", DEV_MODE: "1", ...vars }) as unknown as Env;

describe("configuration", () => {
  const fly = { BOX_HOST: "fly", BOX_SECRET, FLY_API_TOKEN: "fake-token", FLY_ORG: "giraffes", BOX_IMAGE: "registry.fly.io/giraffes-box:1" };

  test("BOX_HOST defaults to none", () => {
    expect(loadConfig(env({})).box).toEqual({ host: "none" });
  });

  test("fly takes the contract's defaults", () => {
    expect(loadConfig(env(fly)).box).toEqual({
      host: "fly",
      secret: BOX_SECRET,
      appPrefix: "gbox-",
      maxBoxes: 10,
      fly: { apiToken: "fake-token", org: "giraffes", image: "registry.fly.io/giraffes-box:1", region: "sin", volumeGb: 5 },
    });
  });

  test.each(["FLY_API_TOKEN", "FLY_ORG", "BOX_IMAGE", "BOX_SECRET"])("fly without %s fails at load", (name) => {
    const vars: Record<string, string> = { ...fly };
    delete vars[name];
    expect(() => loadConfig(env(vars))).toThrow(name);
  });

  test("static needs its URL and the secret, and bad values fail at load", () => {
    expect(loadConfig(env({ BOX_HOST: "static", BOX_SECRET, BOX_STATIC_URL: "http://127.0.0.1:8789/" })).box).toMatchObject({
      host: "static",
      staticUrl: "http://127.0.0.1:8789",
      owner: null,
    });
    expect(() => loadConfig(env({ BOX_HOST: "static", BOX_SECRET }))).toThrow("BOX_STATIC_URL");
    expect(() => loadConfig(env({ BOX_HOST: "static", BOX_STATIC_URL: "http://127.0.0.1:8789" }))).toThrow("BOX_SECRET");
    expect(() => loadConfig(env({ ...fly, BOX_SECRET: "short" }))).toThrow("BOX_SECRET");
    expect(() => loadConfig(env({ ...fly, MAX_BOXES: "ten" }))).toThrow("MAX_BOXES");
    expect(() => loadConfig(env({ BOX_HOST: "docker" }))).toThrow("BOX_HOST");
  });
});

/** Fly answers with fields of its own in a machine's config, which a comparison must not count as a difference. */
function withFlyDefaults(config: Record<string, unknown>): Record<string, unknown> {
  const mounts = (config.mounts as { volume: string; path: string }[]).map((m) => ({ ...m, name: "data", size_gb: 5, encrypted: true }));
  return { ...config, mounts, init: {}, metadata: { fly_platform_version: "v2" }, env: { ...(config.env as object), FLY_PROCESS_GROUP: "app" } };
}

type FlyRequest = { readonly method: string; readonly path: string; readonly body: unknown; readonly authorization: string | null };

function fakeFly(org = "giraffes") {
  const apps = new Map<string, string>();
  const ips = new Map<string, { ip: string; shared: boolean }[]>();
  const volumes = new Map<string, { id: string; name: string; state: string; auto_backup_enabled: boolean }[]>();
  const machines = new Map<string, { id: string; config: Record<string, unknown> }[]>();
  const requests: FlyRequest[] = [];
  const omitOrgs = new Set<string>();
  const failures: { method: string; path: string; status: number; body?: unknown }[] = [];
  let n = 0;
  const fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/v1/, "") + url.search;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body, authorization: new Headers(init?.headers).get("authorization") });
    const failure = failures.findIndex((f) => f.method === method && f.path === path);
    if (failure >= 0) {
      const f = failures.splice(failure, 1)[0];
      return f.body === undefined ? new Response("boom", { status: f.status }) : Response.json(f.body, { status: f.status });
    }
    const [, app, sub, id] = url.pathname.match(/^\/v1\/apps(?:\/([^/]+))?(?:\/(\w+))?(?:\/([^/]+))?$/) ?? [];
    if (!app && method === "GET") {
      const orgSlug = url.searchParams.get("org_slug");
      const mine = [...apps.entries()].filter(([, owner]) => (orgSlug === "personal" ? owner !== "someone-else" : owner === orgSlug));
      return Response.json({ apps: mine.map(([name]) => ({ name })) });
    }
    if (!app && method === "POST") {
      if (apps.has(body.app_name)) return Response.json({ error: "Validation failed: Name has already been taken", status: "name_taken" }, { status: 422 });
      apps.set(body.app_name, body.org_slug);
      return Response.json({ id: `app${++n}`, created_at: 1 }, { status: 201 });
    }
    if (!app || !apps.has(app)) return Response.json({ error: "not found" }, { status: 404 });
    if (!sub && method === "GET") return Response.json(omitOrgs.has(app) ? { name: app } : { name: app, organization: { slug: apps.get(app) } });
    if (!sub && method === "DELETE") {
      apps.delete(app);
      return new Response(null, { status: 202 });
    }
    const list = <T>(m: Map<string, T[]>) => m.get(app) ?? m.set(app, []).get(app)!;
    if (sub === "ip_assignments" && method === "GET") return Response.json({ ips: list(ips) });
    if (sub === "ip_assignments") {
      if (body.type === "shared_v4" && list(ips).some((i) => i.shared)) return Response.json({ error: "already has a shared v4" }, { status: 422 });
      list(ips).push(body.type === "shared_v4" ? { ip: "66.241.124.1", shared: true } : { ip: `2a09:8280:1::${++n}`, shared: false });
      return Response.json({ ip: "x" });
    }
    if (sub === "volumes" && method === "GET") return Response.json(list(volumes));
    if (sub === "volumes" && method === "PUT") {
      const v = list(volumes).find((x) => x.id === id);
      if (!v) return Response.json({ error: "volume not found" }, { status: 404 });
      v.auto_backup_enabled = body.auto_backup_enabled;
      return Response.json(v);
    }
    if (sub === "volumes" && method === "POST") {
      const v = { id: `vol_${++n}`, name: body.name, state: "created", auto_backup_enabled: body.auto_backup_enabled ?? true };
      list(volumes).push(v);
      return Response.json(v);
    }
    if (sub === "machines" && method === "GET") return Response.json(list(machines));
    if (sub === "machines" && id) {
      const m = list(machines).find((x) => x.id === id);
      if (!m) return Response.json({ error: "machine not found" }, { status: 404 });
      m.config = withFlyDefaults(body.config);
      return Response.json(m);
    }
    if (sub === "machines") {
      const m = { id: `m${++n}`, config: withFlyDefaults(body.config) };
      list(machines).push(m);
      return Response.json(m);
    }
    return Response.json({ error: "no route" }, { status: 404 });
  };
  return { fetch, apps, ips, volumes, machines, requests, failures, org, omitOrgs };
}

const flyConfig: FlyConfig = {
  apiToken: "fake-org-token",
  org: "giraffes",
  image: "registry.fly.io/giraffes-box:1",
  region: "sin",
  volumeGb: 5,
  appPrefix: "gbox-",
  secret: BOX_SECRET,
};
const app = "gbox-0123456789ab" as BoxName;
const token = "box-token" as BoxToken;
const posts = (rs: readonly FlyRequest[]) => rs.filter((r) => r.method === "POST").map((r) => [r.path, r.body]);

describe("the static host shares one Claude login", () => {
  const live = (vars: Record<string, string>): Env => ({ MODEL_BACKEND: "live", KEY_SECRET: TEST_KEY_SECRET, PUBLIC_URL: "https://giraffes.test", ...vars }) as unknown as Env;
  const shared = { BOX_HOST: "static", BOX_SECRET, BOX_STATIC_URL: "https://box.example.test" };

  test("outside DEV_MODE it needs BOX_STATIC_OWNER, which must be an agent key", () => {
    expect(() => loadConfig(live(shared))).toThrow("BOX_STATIC_OWNER");
    expect(loadConfig(live({ ...shared, BOX_STATIC_OWNER: "p:telegram:12345" })).box).toMatchObject({ host: "static", owner: "p:telegram:12345" });
    expect(() => loadConfig(live({ ...shared, BOX_STATIC_OWNER: "12345" }))).toThrow("BOX_STATIC_OWNER");
  });

  test("with an owner set, anyone else's /claude says it isn't available and their turns stay on the API", async () => {
    const box = fakeBox({ onlyFor: "own", signedIn: true });
    const owner = await devChat("own", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    const other = await devChat("oth", { model: scripted([chat("From the API.")]), at: "2099-11-04T10:00", box: box.deps });

    await other.say("/claude");
    await owner.say("/claude");
    await other.say("hello");

    expect(await other.received()).toEqual([say("unavailable"), "From the API."]);
    expect(await owner.received()).toEqual([say("setting_up"), say("connected")]);
    expect((await other.snapshot()).box).toBeNull();
    expect(box.parses).toEqual([]);
  });
});

describe("fly host", () => {
  test("account erasure waits for the wiped volume to stop being live before deleting its app", async () => {
    let volumeLive = true;
    let appExists = true;
    const requests: string[] = [];
    const host = flyHost(flyConfig, async (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method;
      requests.push(`${method} ${path}`);
      if (method === "GET" && path === `/v1/apps/${app}`) {
        return appExists ? Response.json({ organization: { slug: "giraffes" } }) : new Response(null, { status: 404 });
      }
      if (method === "GET" && path === "/v1/apps") {
        return Response.json({ apps: appExists ? [{ name: app }] : [] });
      }
      if (method === "GET" && path.endsWith("/volumes")) {
        return Response.json([{ id: "vol_1", state: volumeLive ? "created" : "pending_destroy", attached_machine_id: volumeLive ? "machine_1" : null }]);
      }
      if (method === "DELETE" && path === `/v1/apps/${app}`) appExists = false;
      return new Response(null, { status: 200 });
    });

    const found = await host.retirementTarget(app);
    expect(found).toEqual({ ok: true, target: { disk: "vol_1", machine: "machine_1", disks: ["vol_1"] } });
    if (!found.ok) throw new Error(found.detail);
    expect(await host.retireWipedDisk(app, found.target)).toMatchObject({ ok: false, retryable: true, diskDeleteAccepted: true });
    expect(requests).toContain(`DELETE /v1/apps/${app}/volumes/vol_1`);
    expect(requests).not.toContain(`DELETE /v1/apps/${app}`);
    volumeLive = false;
    expect(await host.retireWipedDisk(app, found.target)).toEqual({ ok: true });
    expect(await host.removeRetiredApp(app)).toEqual({ ok: true });
    expect(requests).toContain(`DELETE /v1/apps/${app}`);
    expect(requests).toContain("GET /v1/apps");
  });

  test("an app deletion cannot finish while Fly still lists a live volume after deletion", async () => {
    let appExists = true;
    let volumeState = "destroyed";
    const host = flyHost(flyConfig, async (url, init) => {
      const path = new URL(url).pathname;
      if (path === `/v1/apps/${app}`) {
        if (init?.method === "DELETE") {
          appExists = false;
          volumeState = "created";
          return new Response(null, { status: 202 });
        }
        return appExists ? Response.json({ organization: { slug: "giraffes" } }) : new Response(null, { status: 404 });
      }
      if (path === "/v1/apps") return Response.json({ apps: appExists ? [{ name: app }] : [] });
      if (path === `/v1/apps/${app}/volumes`) return Response.json([{ id: "vol_1", state: volumeState }]);
      return new Response(null, { status: 500 });
    });

    expect(await host.removeRetiredApp(app)).toMatchObject({ ok: false, retryable: true, detail: "box volumes remain live" });
    expect(await host.removeRetiredApp(app)).toMatchObject({ ok: false, retryable: true, detail: "box volumes remain live" });
    volumeState = "destroyed";
    expect(await host.removeRetiredApp(app)).toEqual({ ok: true });
  });

  test("retirement destroys an app with no volume instead of waiting for a mount", async () => {
    let appExists = true;
    const deletes: string[] = [];
    const host = flyHost(flyConfig, async (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method;
      if (method === "GET" && path === `/v1/apps/${app}`) {
        return appExists ? Response.json({ organization: { slug: "giraffes" } }) : new Response(null, { status: 404 });
      }
      if (method === "GET" && path === "/v1/apps") return Response.json({ apps: appExists ? [{ name: app }] : [] });
      if (method === "GET" && path.endsWith("/volumes")) return Response.json([]);
      if (method === "DELETE") {
        deletes.push(path);
        if (path === `/v1/apps/${app}`) appExists = false;
      }
      return new Response(null, { status: 200 });
    });

    const found = await host.retirementTarget(app);
    expect(found).toEqual({ ok: true, target: { disk: null, machine: null, disks: [] } });
    if (!found.ok) throw new Error(found.detail);
    expect(await host.retireWipedDisk(app, found.target)).toEqual({ ok: true });
    expect(await host.removeRetiredApp(app)).toEqual({ ok: true });
    expect(deletes).toEqual([`/v1/apps/${app}`]);
  });

  test("retirement destroys every unattached volume the app owns", async () => {
    let state = "created";
    const deletes: string[] = [];
    const host = flyHost(flyConfig, async (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method;
      if (method === "GET" && path === `/v1/apps/${app}`) return Response.json({ organization: { slug: "giraffes" } });
      if (method === "GET" && path === "/v1/apps") return Response.json({ apps: [{ name: app }] });
      if (method === "GET" && path.endsWith("/volumes")) {
        return Response.json([{ id: "vol_old", state, attached_machine_id: null }]);
      }
      if (method === "DELETE" && path.endsWith("/volumes/vol_old")) {
        deletes.push(path);
        state = "pending_destroy";
      }
      return new Response(null, { status: 200 });
    });

    const found = await host.retirementTarget(app);
    expect(found).toEqual({ ok: true, target: { disk: null, machine: null, disks: ["vol_old"] } });
    if (!found.ok) throw new Error(found.detail);
    expect(await host.retireWipedDisk(app, found.target)).toEqual({ ok: true, diskDeleteAccepted: true });
    expect(deletes).toEqual([`/v1/apps/${app}/volumes/vol_old`]);
  });

  test("an app read of 404 is gone only when the org app list confirms it", async () => {
    let listed = false;
    const host = flyHost(flyConfig, async (url) => {
      const path = new URL(url).pathname;
      if (path === `/v1/apps/${app}`) return new Response(null, { status: 404 });
      if (path === "/v1/apps") return Response.json({ apps: listed ? [{ name: app }] : [] });
      return new Response(null, { status: 500 });
    });

    expect(await host.retirementTarget(app)).toMatchObject({ ok: false, missing: true });
    listed = true;
    const held = await host.retirementTarget(app);
    expect(held).toMatchObject({ ok: false, retryable: true });
    expect(held).not.toMatchObject({ missing: true });
  });

  test("an app that disappears after locate reports missing so the caller relocates", async () => {
    let appExists = true;
    const host = flyHost(flyConfig, async (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method;
      if (method === "GET" && path === `/v1/apps/${app}`) {
        return appExists ? Response.json({ organization: { slug: "giraffes" } }) : new Response(null, { status: 404 });
      }
      if (method === "GET" && path === "/v1/apps") return Response.json({ apps: appExists ? [{ name: app }] : [] });
      if (method === "GET" && path.endsWith("/volumes")) {
        return Response.json([{ id: "vol_1", state: "created", attached_machine_id: "machine_1" }]);
      }
      return new Response(null, { status: 200 });
    });

    const found = await host.retirementTarget(app);
    if (!found.ok) throw new Error(found.detail);
    appExists = false;
    expect(await host.retireWipedDisk(app, found.target)).toMatchObject({ ok: false, missing: true });
  });

  test("provisioning sends the contract's requests: app, shared v4 and v6, a data volume, one machine", async () => {
    const fly = fakeFly();
    const host = flyHost(flyConfig, fly.fetch);

    expect(await host.ensure(app, token)).toEqual({ ok: true });

    expect(posts(fly.requests)).toEqual([
      ["/apps", { app_name: app, org_slug: "giraffes", network: app }],
      [`/apps/${app}/ip_assignments`, { type: "shared_v4" }],
      [`/apps/${app}/ip_assignments`, { type: "v6" }],
      [`/apps/${app}/volumes`, { name: "data", region: "sin", size_gb: 5, auto_backup_enabled: false }],
      [
        `/apps/${app}/machines`,
        {
          region: "sin",
          config: {
            image: "registry.fly.io/giraffes-box:1",
            guest: { cpu_kind: "shared", cpus: 1, memory_mb: 2048 },
            env: { BOX_TOKEN: "box-token", BOX_REQUIRE_EPOCH: "1" },
            mounts: [{ volume: fly.volumes.get(app)![0].id, path: "/data" }],
            services: [
              {
                protocol: "tcp",
                internal_port: 8789,
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
        },
      ],
    ]);
    expect(new Set(fly.requests.map((r) => r.authorization))).toEqual(new Set(["Bearer fake-org-token"]));
    expect(host.urlOf(app)).toBe(`https://${app}.fly.dev`);
  });

  test("provisioning disables automatic snapshots on an existing data volume in place", async () => {
    const fly = fakeFly();
    fly.apps.set(app, flyConfig.org);
    const volume = { id: "vol_existing", name: "data", state: "created", auto_backup_enabled: true };
    fly.volumes.set(app, [volume]);
    const host = flyHost(flyConfig, fly.fetch);
    const volumePath = `/apps/${app}/volumes/${volume.id}`;

    expect(await host.ensure(app, token)).toEqual({ ok: true });
    expect(fly.requests.filter((r) => r.method === "PUT")).toMatchObject([
      { path: volumePath, body: { auto_backup_enabled: false } },
    ]);
    expect(fly.volumes.get(app)).toEqual([{ ...volume, auto_backup_enabled: false }]);
    expect(fly.machines.get(app)?.[0].config.mounts).toMatchObject([{ volume: volume.id, path: "/data" }]);

    const settled = fly.requests.length;
    expect(await host.ensure(app, token)).toEqual({ ok: true });
    expect(fly.requests.slice(settled).filter((r) => r.method === "PUT")).toEqual([]);
  });

  test("provisioning waits to create the machine if disabling snapshots fails", async () => {
    const fly = fakeFly();
    fly.apps.set(app, flyConfig.org);
    const volume = { id: "vol_existing", name: "data", state: "created", auto_backup_enabled: true };
    fly.volumes.set(app, [volume]);
    fly.failures.push({ method: "PUT", path: `/apps/${app}/volumes/${volume.id}`, status: 503 });
    const host = flyHost(flyConfig, fly.fetch);

    expect(await host.ensure(app, token)).toMatchObject({ ok: false, retryable: true });
    expect(fly.machines.get(app)).toBeUndefined();

    expect(await host.ensure(app, token)).toEqual({ ok: true });
    expect(fly.volumes.get(app)).toEqual([{ ...volume, auto_backup_enabled: false }]);
    expect(fly.machines.get(app)).toHaveLength(1);
  });

  test("a run that failed midway resumes, and a run after success creates nothing", async () => {
    const fly = fakeFly();
    const host = flyHost(flyConfig, fly.fetch);
    fly.failures.push({ method: "POST", path: `/apps/${app}/volumes`, status: 503 });

    expect(await host.ensure(app, token)).toMatchObject({ ok: false, retryable: true });
    expect(await host.ensure(app, token)).toEqual({ ok: true });
    const before = fly.requests.length;
    expect(await host.ensure(app, token)).toEqual({ ok: true });

    expect(fly.apps.size).toBe(1);
    expect(fly.ips.get(app)!.map((i) => i.shared)).toEqual([true, false]);
    expect(fly.volumes.get(app)).toHaveLength(1);
    expect(fly.machines.get(app)).toHaveLength(1);
    expect(posts(fly.requests.slice(before)).map(([path]) => path)).toEqual(["/apps"]);
  });

  test("an existing machine whose image or token differs is updated in place with the full config on the same volume", async () => {
    const fly = fakeFly();
    await flyHost(flyConfig, fly.fetch).ensure(app, token);
    const [machine] = fly.machines.get(app)!;
    const volume = fly.volumes.get(app)![0].id;
    const before = fly.requests.length;

    const v2 = flyHost({ ...flyConfig, image: "registry.fly.io/giraffes-box:2" }, fly.fetch);
    expect(await v2.ensure(app, "box-token-2" as BoxToken)).toEqual({ ok: true });

    const updates = posts(fly.requests.slice(before));
    expect(updates.map(([path]) => path)).toEqual(["/apps", `/apps/${app}/machines/${machine.id}`]);
    expect(updates[1][1]).toEqual({ config: machineConfig({ ...flyConfig, image: "registry.fly.io/giraffes-box:2" }, "box-token-2" as BoxToken, volume).config });
    expect(fly.machines.get(app)).toHaveLength(1);
    expect(fly.volumes.get(app)).toHaveLength(1);

    const settled = fly.requests.length;
    expect(await v2.ensure(app, "box-token-2" as BoxToken)).toEqual({ ok: true });
    expect(posts(fly.requests.slice(settled)).map(([path]) => path)).toEqual(["/apps"]);
  });

  test("429 and 5xx are retryable, another 4xx is not, and a name owned elsewhere fails", async () => {
    const fly = fakeFly();
    const host = flyHost(flyConfig, fly.fetch);
    fly.failures.push({ method: "POST", path: "/apps", status: 429 });
    expect(await host.ensure(app, token)).toMatchObject({ ok: false, retryable: true });
    fly.failures.push({ method: "POST", path: "/apps", status: 400 });
    expect(await host.ensure(app, token)).toMatchObject({ ok: false, retryable: false });

    fly.apps.set(app, "someone-else");
    expect(await host.ensure(app, token)).toMatchObject({ ok: false, retryable: false });
    expect(fly.machines.get(app)).toBeUndefined();
  });

  test("the personal alias accepts an existing app Fly reports under the personal org's real slug", async () => {
    const fly = fakeFly();
    fly.apps.set(app, "beam-personal-abc123");
    const host = flyHost({ ...flyConfig, org: "personal" }, fly.fetch);

    expect(await host.ensure(app, token)).toEqual({ ok: true });
    expect(fly.requests.some((r) => r.method === "GET" && r.path === "/apps?org_slug=personal")).toBe(true);
    expect(fly.machines.get(app)).toHaveLength(1);
  });

  test("an app reply with no organization fails closed outside the personal alias", async () => {
    const fly = fakeFly();
    fly.apps.set(app, "giraffes");
    fly.omitOrgs.add(app);

    expect(await flyHost(flyConfig, fly.fetch).ensure(app, token)).toMatchObject({ ok: false, retryable: false });
    expect(fly.machines.get(app)).toBeUndefined();
  });

  test("the personal-filtered app list decides ownership when the direct app reply omits organization", async () => {
    const mine = fakeFly();
    mine.apps.set(app, "beam-personal-abc123");
    mine.omitOrgs.add(app);
    expect(await flyHost({ ...flyConfig, org: "personal" }, mine.fetch).ensure(app, token)).toEqual({ ok: true });
    expect(mine.machines.get(app)).toHaveLength(1);

    const foreign = fakeFly();
    foreign.apps.set(app, "someone-else");
    foreign.omitOrgs.add(app);
    expect(await flyHost({ ...flyConfig, org: "personal" }, foreign.fetch).ensure(app, token)).toMatchObject({ ok: false, retryable: false });
    expect(foreign.machines.get(app)).toBeUndefined();
  });

  test("a name Fly refuses for another reason fails with Fly's words, not as a name owned elsewhere", async () => {
    const fly = fakeFly();
    const host = flyHost(flyConfig, fly.fetch);
    const refusal = "Name blocked by abuse filter. verify is a common phishing target";
    fly.failures.push({ method: "POST", path: "/apps", status: 422, body: { error: refusal } });
    const result = await host.ensure(app, token);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok === false && result.detail).toContain(refusal);
    expect(fly.requests.filter((r) => r.method === "GET" && r.path === `/apps/${app}`)).toHaveLength(0);
  });

  test("a Fly call that hangs before answering or while sending its body times out as retryable", async () => {
    const hangs: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    expect(await flyHost(flyConfig, hangs, () => {}, 20).ensure(app, token)).toMatchObject({ ok: false, retryable: true, detail: expect.stringMatching(/Timeout/) });

    const stalls: Fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":'));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
        { status: 201 },
      );
    expect(await flyHost(flyConfig, stalls, () => {}, 20).ensure(app, token)).toMatchObject({ ok: false, retryable: true });
    expect(await flyHost(flyConfig, stalls, () => {}, 20).destroy(app)).toMatchObject({ ok: false, retryable: true });
  });

  test("a FlyV1 token goes as-is, and delete forces removal and treats a missing app as done", async () => {
    const fly = fakeFly();
    const host = flyHost({ ...flyConfig, apiToken: "FlyV1 fm2_fake" }, fly.fetch);
    await host.ensure(app, token);

    expect(await host.destroy(app)).toEqual({ ok: true });
    expect(await host.destroy(app)).toEqual({ ok: true });

    expect(fly.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`/apps/${app}?force=true`, `/apps/${app}?force=true`]);
    expect(new Set(fly.requests.map((r) => r.authorization))).toEqual(new Set(["FlyV1 fm2_fake"]));
    expect(fly.apps.size).toBe(0);
  });
});

describe("box client", () => {
  const req = { model: "claude-haiku-5-5", system: "s", user: "u", jsonSchema: { type: "object" } };
  const answering = (status: number, body: unknown): Fetch => async () => Response.json(body, { status });

  test("a 409 is signed out, a 401 is unauthorized; 5xx, a network error and a timeout are unavailable", async () => {
    expect(await boxClient(answering(409, { error: "signed_out" })).parse("https://b", token, req)).toEqual({ kind: "signed_out" });
    expect(await boxClient(answering(401, { error: "unauthorized" })).parse("https://b", token, req)).toEqual({ kind: "unauthorized" });
    expect(await boxClient(answering(401, { error: "unauthorized" })).health("https://b", token)).toEqual({ kind: "unauthorized" });
    for (const status of [502, 503]) {
      expect(await boxClient(answering(status, {})).parse("https://b", token, req)).toMatchObject({ kind: "unavailable" });
    }
    const down: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await boxClient(down).parse("https://b", token, req)).toMatchObject({ kind: "unavailable" });
    const hang: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    expect(await boxClient(hang, { parseMs: 20, healthMs: 20 }).parse("https://b", token, req)).toMatchObject({
      kind: "unavailable",
      detail: expect.stringMatching(/Timeout/),
    });
    expect(await boxClient(hang, { parseMs: 20, healthMs: 20 }).health("https://b", token)).toMatchObject({ kind: "unavailable" });
  });

  test("a 412 stale is stale, never signed out, and any other 412 is unavailable", async () => {
    const agentReq = { model: "claude-haiku-5-5", append: "a", session: null, turn: "t", fresh: "f", tools: [] };
    expect(await boxClient(answering(412, { error: "stale" })).parse("https://b", token, req)).toEqual({ kind: "stale" });
    expect(await boxClient(answering(412, { error: "stale" })).agent("https://b", token, agentReq)).toEqual({ kind: "stale" });
    expect(await boxClient(answering(412, {})).parse("https://b", token, req)).toMatchObject({ kind: "unavailable" });
  });

  test("a request carries the volume and the epoch only when the caller gives them", async () => {
    const bodies: unknown[] = [];
    const recording: Fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ structured: {}, usage: null, stop: "end" });
    };
    const box = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
    await boxClient(recording).parse("https://b", token, req);
    await boxClient(recording).parse("https://b", token, { ...req, at: { box, epoch: 3 } });
    await boxClient(recording).agent("https://b", token, { model: "m", append: "a", session: null, turn: "t", fresh: "f", tools: [], at: { box, epoch: 3 } });
    expect(bodies[0]).toEqual(req);
    expect(bodies[1]).toEqual({ ...req, box, epoch: 3 });
    expect(bodies[2]).toMatchObject({ box, epoch: 3 });
    expect(bodies[2]).not.toHaveProperty("at");
  });

  test("health names the volume when the image does", async () => {
    const box = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
    expect(await boxClient(answering(200, { ok: true, signedIn: true, box })).health("https://b", token)).toEqual({ kind: "up", signedIn: true, box });
    expect(await boxClient(answering(200, { ok: true, signedIn: true })).health("https://b", token)).toEqual({ kind: "up", signedIn: true });
  });

  test("an erase is done only when the box answers 200 with a floor at or past the epoch; an old image's 404 and every failure are pending", async () => {
    const box = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
    let sent: { url: string; body: unknown } | null = null;
    const ok: Fetch = async (url, init) => {
      sent = { url, body: JSON.parse(String(init?.body)) };
      return Response.json({ box, floor: 4 });
    };
    expect(await boxClient(ok).erase("https://b", token, 3)).toEqual({ kind: "erased", box, floor: 4 });
    expect(sent).toEqual({ url: "https://b/erase", body: { epoch: 3 } });
    expect(await boxClient(answering(200, { box, floor: 2 })).erase("https://b", token, 3)).toMatchObject({ kind: "pending" });
    expect(await boxClient(answering(200, { floor: 3 })).erase("https://b", token, 3)).toMatchObject({ kind: "pending" });
    for (const status of [404, 500, 503]) expect(await boxClient(answering(status, {})).erase("https://b", token, 3)).toMatchObject({ kind: "pending" });
    expect(await boxClient(answering(401, {})).erase("https://b", token, 3)).toEqual({ kind: "unauthorized" });
    const down: Fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await boxClient(down).erase("https://b", token, 3)).toMatchObject({ kind: "pending" });
  });

  test("account erase requires proof for the requested disk and scope", async () => {
    const box = "00000000-0000-4000-8000-000000000001";
    const request = { scope: "account", box, epoch: 3 } as const;
    expect(await boxClient(answering(200, { box, floor: 4 })).erase("https://b", token, request)).toMatchObject({ kind: "pending" });
    expect(await boxClient(answering(200, {
      box: "00000000-0000-4000-8000-000000000002", floor: 4, scope: "account",
    })).erase("https://b", token, request)).toMatchObject({ kind: "pending" });
    const receipt = { box, floor: 4, scope: "account" };
    const accountErase = boxClient(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(request);
      return new Response(JSON.stringify(receipt), { status: 200 });
    });
    expect(await accountErase.erase("https://b", token, request)).toEqual({ kind: "erased", ...receipt });
  });

  test("a reply is read as the bridge's, and the default parse timeout is 120 s", async () => {
    const ok = answering(200, { structured: { a: "hi" }, usage: { input_tokens: 5, output_tokens: 2 }, stop: "end" });
    expect(await boxClient(ok).parse("https://b", token, req)).toEqual({
      kind: "reply",
      reply: { kind: "reply", text: '{"a":"hi"}', stop: "end", usage: { inputTokens: 5, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0 }, reportedMicro: null },
    });
    const bad = answering(200, { nonsense: true });
    expect(await boxClient(bad).parse("https://b", token, req)).toMatchObject({ kind: "reply", reply: { text: "" } });
    let timeout: AbortSignal | undefined;
    await boxClient(async (_u, init) => {
      timeout = init?.signal ?? undefined;
      return Response.json({ error: "signed_out" }, { status: 409 });
    }).parse("https://b", token, req);
    expect(timeout).toBeDefined();
  });
});

async function linkIn(text: string, user: string, sentAt: EpochMs) {
  const m = text.match(LINK);
  if (!m) throw new Error(`no sign-in link in ${JSON.stringify(text)}`);
  const [, name, exp, mac] = m;
  const expected = await signinTicket(await boxToken(BOX_SECRET, name as BoxName), Number(exp) as EpochMs);
  return { name, exp: Number(exp), valid: expected === `${exp}.${mac}`, expiresInMs: Number(exp) - sentAt, user };
}

describe("a turn on the person's own Claude Code session", () => {
  async function signedIn(user: string, at = "2099-11-04T10:00") {
    const box = fakeBox({ signedIn: true });
    const c = await devChat(user, { model: scripted([]), at, box: box.deps });
    await c.say("/claude");
    await c.received();
    return { box, c };
  }

  test("its tool calls are applied like any turn's actions: the reminder is pending, the note kept, and the reply sent", async () => {
    const { box, c } = await signedIn("agt");
    box.replies.push({
      kind: "reply",
      step: turn({ actions: [schedule("call-clinic", "2099-11-06T09:00", "Call the clinic"), { type: "remember", note: "Allergic to peanuts." }, send("Friday at 9.")] }),
    });

    await c.say("I'm allergic to peanuts. Remind me Friday 9 am to call the clinic");

    expect(await c.received()).toEqual(["Friday at 9."]);
    const s = await c.snapshot();
    expect(s.pendingWakeups.filter((w) => w.kind === "reminder").map((w) => [w.key, w.origin])).toEqual([["call-clinic", "person"]]);
    expect(s.memoryNotes).toEqual(["Allergic to peanuts."]);
    expect(box.parses[0].agent?.tools).toEqual(["schedule_wakeup", "cancel_wakeup", "remember", "set_locale", "forget", "task"]);
  });

  test("a refused box reminder is corrected in the same reply and every refusal is logged", async () => {
    const { box, c } = await signedIn("refused");
    box.replies.push({
      kind: "reply",
      step: chat("Got it, set for Friday."),
      refusedCalls: [
        { name: "schedule_wakeup", input: { key: "call-clinic", asked: true }, problems: ["missing at", "missing note", "missing task"] },
        { name: "schedule_wakeup", input: { key: "check-in", asked: false }, problems: ["missing at", "missing note", "missing task"] },
        { name: "remember", input: { note: "Call the clinic.", extra: true }, problems: ["unknown field extra"] },
      ],
    });

    await c.say("Remind me Friday to call the clinic");

    expect(await c.received()).toEqual(["Got it, set for Friday.\n" + NOTICE.reminderNotSet]);
    const s = await c.snapshot();
    expect(s.pendingWakeups.filter((w) => w.kind === "reminder")).toEqual([]);
    expect(s.memoryNotes).toEqual([]);
    expect(c.logs("rejection").map((l) => l.reason)).toEqual([
      "tool_refused",
      "tool_refused",
      "tool_refused",
    ]);
  });

  test("a refused box reminder move keeps the original reminder", async () => {
    const { box, c } = await signedIn("refused-move");
    box.replies.push({ kind: "reply", step: turn({ actions: [schedule("clinic", "2099-11-06T09:00", "Call the clinic"), send("Friday at 9.")] }) });
    await c.say("Remind me Friday at 9 to call the clinic");
    await c.received();
    box.replies.push({
      kind: "reply",
      step: turn({ actions: [{ type: "cancel_wakeup", key: "clinic" }, send("Moved it to Saturday.")] }),
      refusedCalls: [{ name: "schedule_wakeup", input: { key: "clinic", asked: true }, problems: ["missing at", "missing note", "missing task"] }],
    });

    await c.say("Move that reminder to Saturday");

    const reminders = (await c.snapshot()).pendingWakeups.filter((w) => w.kind === "reminder");
    expect(reminders.map((w) => [w.key, w.dueAt])).toEqual([["clinic", local("2099-11-06T09:00")]]);
    expect(await c.received()).toEqual(["Moved it to Saturday.\n" + NOTICE.reminderNotSet + "\n" + NOTICE.reminderKept("2099-11-06 09:00")]);
  });

  test("a successful retry after a box refusal still sets the reminder and reports the failed attempt", async () => {
    const { box, c } = await signedIn("refused-retry");
    box.replies.push({
      kind: "reply",
      step: turn({ actions: [schedule("clinic", "2099-11-06T09:00", "Call the clinic"), send("Set for Friday at 9.")] }),
      refusedCalls: [{ name: "schedule_wakeup", input: { key: "clinic", asked: true }, problems: ["missing at", "missing note", "missing task"] }],
    });

    await c.say("Remind me Friday at 9 to call the clinic");

    expect(await c.received()).toEqual(["Set for Friday at 9.\n(One attempt to set that reminder failed.)"]);
    expect((await c.snapshot()).pendingWakeups.filter((w) => w.kind === "reminder").map((w) => w.key)).toEqual(["clinic"]);
    expect(c.logs("rejection").map((l) => l.reason)).toEqual(["tool_refused"]);
  });

  test("the session holds the conversation, so a turn sends only the context and what is new", async () => {
    const { box, c } = await signedIn("ctx");
    box.replies.push({ kind: "reply", step: chat("Hi!") }, { kind: "reply", step: chat("Fine, thanks.") });

    await c.say("hello there");
    await c.say("how are you");

    const second = box.parses[1].user;
    expect(second).toContain("Person: how are you");
    expect(second).not.toContain("hello there");
    expect(second).not.toContain("Hi!");
  });

  test("every turn runs on their plan: a reminder they asked for, and a daily check-in with nothing to say sends nothing", async () => {
    const { box, c } = await signedIn("own", "2099-11-04T08:00");
    box.replies.push({ kind: "reply", step: turn({ actions: [schedule("stretch", "2099-11-04T08:30", "Stretch"), send("At 8:30.")] }) });
    await c.say("remind me at 8:30 to stretch");
    box.replies.push({ kind: "reply", step: chat("Time to stretch!") }, { kind: "reply", step: turn({ actions: [quiet()] }) });

    await c.advanceTo("2099-11-04T09:05");

    expect(box.parses.map((p) => p.user.split("\n").find((l) => l.startsWith("Your wake-up") || l.startsWith("Person:") || l.startsWith("Daily")))).toEqual([
      "Person: remind me at 8:30 to stretch",
      expect.stringContaining('Your wake-up "stretch" fired'),
      "Daily check-in.",
    ]);
    expect(await c.received()).toEqual(["At 8:30.", "Time to stretch!"]);
    expect(c.logs("turn").filter((r) => r.eventKind === "checkin").map((r) => r.outcome)).toEqual(["quiet"]);
    expect(box.replies).toEqual([]);
  });

  test("a late box reminder gets the standard notice without asking the session for lateNotice", async () => {
    const { box, c } = await signedIn("late-box", "2099-11-04T21:30");
    box.replies.push({ kind: "reply", step: turn({ actions: [schedule("bins", "2099-11-04T23:00", "Ask about the bins", false), send("OK.")] }) });
    await c.say("I need to take the bins out later");
    await c.received();
    box.replies.push({ kind: "reply", step: chat("Did the bins go out?") });

    await c.advanceTo("2099-11-05T08:00");

    expect(await c.received()).toEqual([`${NOTICE.lateFallback("2099-11-04 23:00")}\nDid the bins go out?`]);
    const reminder = box.parses.at(-1)?.user;
    expect(reminder).toContain('Your wake-up "bins" fired');
    expect(reminder).not.toContain("lateNotice");
  });

  test("a person with only their Claude plan gets their daily check-in from the box", async () => {
    const { box, c } = await signedIn("checkin", "2099-11-04T08:00");
    box.replies.push({ kind: "reply", step: chat("Morning! Want me to plan the long weekend?") });

    await c.advanceTo("2099-11-04T09:05");

    expect(await c.received()).toEqual(["Morning! Want me to plan the long weekend?"]);
    expect(box.parses.at(-1)?.user).toContain("Daily check-in.");
    expect(c.logs("model_call").map((r) => [r.backend, r.costMicro])).toEqual([["box", 0]]);
    expect(c.logs("unasked").map((u) => [u.status, u.purpose])).toEqual([["sent", "unlinked"]]);
  });

  test("a follow-up the agent scheduled for itself runs on the box", async () => {
    const { box, c } = await signedIn("follow-up");
    box.replies.push({
      kind: "reply",
      step: turn({ actions: [schedule("ask-flight", "2099-11-04T15:00", "Ask whether the flight got booked", false), send("Good luck with the booking!")] }),
    });
    await c.say("I'm booking my flight this afternoon");
    box.replies.push({ kind: "reply", step: chat("Did the flight booking work out?") });

    await c.advanceTo("2099-11-04T15:05");

    expect(await c.received()).toEqual(["Good luck with the booking!", "Did the flight booking work out?"]);
    expect(box.parses.at(-1)?.user).toContain('Your wake-up "ask-flight" fired');
    expect(c.logs("unasked").map((u) => [u.status, u.purpose])).toEqual([["sent", "unlinked"]]);
  });

  test("a box check-in that proposes a plan sends it under Accept, and the tap completes the task", async () => {
    const { box, c } = await signedIn("plan", "2099-11-04T08:00");
    box.replies.push({ kind: "reply", step: turn({ actions: [send("Morning! The long weekend is close, so I sketched a trip.")], tasks: [propose(TRIP, TITLE, PLAN)] }) });

    await c.advanceTo("2099-11-04T09:00");

    expect(c.channel.delivered.at(-1)).toMatchObject({
      text: `Morning! The long weekend is close, so I sketched a trip.\n${PLAN}`,
      button: { label: NOTICE.acceptButton, data: "a:1.1" },
    });
    await c.received();
    box.replies.push({ kind: "reply", step: chat("Great, I'll remind you on Friday.") });

    await c.tap("a:1.1");

    expect(await c.received()).toEqual([`Great, I'll remind you on Friday.\n${NOTICE.planAccepted(TITLE)}`]);
    expect(box.parses.at(-1)?.user).toContain("The person tapped Accept on plan 1.1.");
    const [task] = (await c.snapshot()).tasks;
    expect(task).toMatchObject({ ref: TRIP, kind: "plan", title: TITLE, status: "completed" });
    expect(task.facts.map((f) => [f.kind, f.completes, f.personDecision])).toEqual([
      ["opened", false, false],
      ["proposed", false, false],
      ["plan_accepted", true, true],
    ]);
    expect(c.logs("task_fact").filter((f) => f.completes).map((f) => [f.kind, f.causeKind])).toEqual([
      ["plan_accepted", "choice"],
    ]);
    expect(c.logs("unasked").map((u) => [u.status, u.purpose])).toEqual([["sent", "task_followup"]]);
  });

  test("a box check-in that names an open task is a follow-up on it and changes nothing else", async () => {
    const { box, c } = await signedIn("about", "2099-11-04T08:00");
    box.replies.push({ kind: "reply", step: turn({ actions: [send("Noted, a weekend in Chiang Mai.")], tasks: [openTask(TRIP, TITLE, "plan")] }) });
    await c.say("I want a long weekend in Chiang Mai");
    box.replies.push({ kind: "reply", step: turn({ actions: [send("Still thinking about Chiang Mai? Trains sell out early.")], tasks: [openTask(TRIP, TITLE, "plan")] }) });

    await c.advanceTo("2099-11-04T09:05");

    expect(await c.received()).toEqual(["Noted, a weekend in Chiang Mai.", "Still thinking about Chiang Mai? Trains sell out early."]);
    const [task] = (await c.snapshot()).tasks;
    expect([task.status, task.facts.map((f) => f.kind)]).toEqual(["open", ["opened"]]);
    expect(c.logs("unasked").map((u) => [u.status, u.purpose])).toEqual([["sent", "task_followup"]]);
  });

  test("a refused box task call is logged like a refused action, and no plan goes out", async () => {
    const { box, c } = await signedIn("refused-task");
    box.replies.push({
      kind: "reply",
      step: chat("I'll sketch a plan for you."),
      refusedCalls: [{ name: "task", input: { op: "propose", ref: TRIP, kind: "plan", title: TITLE }, problems: ["missing plan"] }],
    });

    await c.say("plan me a weekend in Chiang Mai");

    expect(await c.received()).toEqual(["I'll sketch a plan for you."]);
    expect(c.channel.delivered.at(-1)).not.toHaveProperty("button");
    expect((await c.snapshot()).tasks).toEqual([]);
    expect(c.logs("rejection").map((l) => l.reason)).toEqual(["tool_refused"]);
  });

  test("a bad task ref from the box does not lose the check-in reply or a valid task call", async () => {
    const { box, c } = await signedIn("bad-task-ref", "2099-11-04T08:00");
    box.replies.push({
      kind: "reply",
      step: turn({ actions: [send("Morning! Have you booked the train?")], tasks: [openTask(TRIP, TITLE, "plan"), openTask("Bad ref", "Invalid")] }),
    });

    await c.advanceTo("2099-11-04T09:00");

    expect(await c.received()).toEqual(["Morning! Have you booked the train?"]);
    expect((await c.snapshot()).tasks.map((task) => task.ref)).toEqual([TRIP]);
    expect(c.logs("unasked").map((u) => [u.status, u.purpose])).toEqual([["sent", "task_followup"]]);
    expect(c.logs("rejection").map((r) => r.reason)).toEqual(["tool_refused"]);
  });

  test("a near-miss task ref from the box links the check-in to the one open task", async () => {
    const { box, c } = await signedIn("typo-task-ref", "2099-11-04T08:00");
    box.replies.push({ kind: "reply", step: turn({ actions: [send("Noted.")], tasks: [openTask(TRIP, TITLE, "plan")] }) });
    await c.say("I want a weekend in Chiang Mai");
    box.replies.push({
      kind: "reply",
      step: turn({ actions: [send("Still thinking about Chiang Mai?")], tasks: [openTask("chiang-mai-tirp", TITLE, "plan")] }),
    });

    await c.advanceTo("2099-11-04T09:00");

    expect(await c.received()).toEqual(["Noted.", "Still thinking about Chiang Mai?"]);
    expect((await c.snapshot()).tasks.map((task) => task.ref)).toEqual([TRIP]);
    expect(c.logs("unasked").map((u) => [u.status, u.purpose])).toEqual([["sent", "task_followup"]]);
  });

  test("an ambiguous near-miss task ref from the box is refused without losing the reply", async () => {
    const { box, c } = await signedIn("ambiguous-task-ref", "2099-11-04T08:00");
    const other = "chiang-mai-drib";
    box.replies.push({
      kind: "reply",
      step: turn({ actions: [send("Noted.")], tasks: [openTask(TRIP, TITLE), openTask(other, "Get a basketball")] }),
    });
    await c.say("I want a trip and a basketball");
    box.replies.push({
      kind: "reply",
      step: turn({ actions: [send("How's it going?")], tasks: [openTask("chiang-mai-trib", TITLE)] }),
    });

    await c.advanceTo("2099-11-04T09:00");

    expect(await c.received()).toEqual(["Noted.", "How's it going?"]);
    expect((await c.snapshot()).tasks.map((task) => task.ref).sort()).toEqual([other, TRIP]);
    expect(c.logs("unasked").map((u) => [u.status, u.purpose])).toEqual([["sent", "unlinked"]]);
    expect(c.logs("rejection").map((r) => r.reason)).toEqual(["task_unknown"]);
  });
});

describe("connecting a Claude plan", () => {
  test("with BOX_HOST=none, /claude says it isn't available and calls no model", async () => {
    const model = scripted([]);
    const c = await devChat("nia", { model, at: "2099-11-04T10:00" });

    await c.say("/claude");

    expect(await c.received()).toEqual([say("unavailable")]);
    expect((await c.snapshot()).box).toBeNull();
    expect(model.calls).toHaveLength(0);
  });

  test("/claude with no box records it, provisions it, and sends one sign-in link that polling then stops chasing", async () => {
    const box = fakeBox();
    const ledger = memoryLedger();
    const model = scripted([]);
    const c = await devChat("ann", { model, at: "2099-11-04T10:00", box: box.deps, ledger });

    await c.say("/claude");

    const [setup, link, ...rest] = await c.received();
    expect([setup, rest]).toEqual([say("setting_up"), []]);
    const l = await linkIn(link, "ann", local("2099-11-04T10:00"));
    expect({ name: l.name, valid: l.valid, expiresInMs: l.expiresInMs }).toEqual({ name: await box.nameOf("ann"), valid: true, expiresInMs: 30 * 60_000 });
    expect((await c.snapshot()).box).toEqual({ host: "fly", state: "signed_out" });
    expect(ledger.boxes.get("p:dev:ann")).toEqual({ name: await box.nameOf("ann"), host: "fly" });
    expect(JSON.stringify((await c.snapshot()).turns)).not.toContain("#t=");

    await c.advanceTo("2099-11-04T11:00");

    expect(await c.received()).toEqual([]);
    expect(box.healthCalls).toHaveLength(1 + BOX.pollForMs / BOX.pollEveryMs);
    expect((await c.snapshot()).box?.state).toBe("signed_out");
    expect(model.calls).toHaveLength(0);
  // This drive walks every 30-second sign-in poll for the full half-hour polling window.
  }, 10_000);

  test("a provisioning step that died after creating the app is retried and converges on one app and one link", async () => {
    const box = fakeBox({ host: ["die"] });
    const c = await devChat("bo", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });

    await c.say("/claude");
    expect(await c.received()).toEqual([say("setting_up")]);
    expect((await c.snapshot()).box?.state).toBe("provisioning");

    await c.advanceTo("2099-11-04T10:01");

    const sent = await c.received();
    expect(sent).toHaveLength(1);
    expect((await linkIn(sent[0], "bo", local("2099-11-04T10:00"))).valid).toBe(true);
    expect(box.ensureCalls).toHaveLength(2);
    expect(box.created.size).toBe(1);
  });

  test("a provisioning step that dies every time runs out of attempts, removes what it made, frees the slot and tells the person once", async () => {
    const box = fakeBox({ host: Array(50).fill("die") });
    const ledger = memoryLedger();
    const c = await devChat("cy", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps, ledger });

    await c.say("/claude");
    await c.advanceTo("2099-11-04T12:00");

    expect(await c.received()).toEqual([say("setting_up"), say("setup_failed")]);
    expect(box.ensureCalls).toHaveLength(BOX.maxProvisionAttempts);
    expect(box.destroyCalls).toEqual([await box.nameOf("cy")]);
    expect(box.created.size).toBe(0);
    expect(ledger.boxes.has("p:dev:cy")).toBe(false);
    expect((await c.snapshot()).box).toBeNull();
  });

  test("a provisioning failure with no app frees the slot, and the next /claude starts over", async () => {
    const box = fakeBox({ host: [{ retryable: false, detail: "POST /apps: 400" }] });
    const ledger = memoryLedger();
    const c = await devChat("di", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps, ledger });

    await c.say("/claude");
    expect(await c.received()).toEqual([say("setting_up"), say("setup_failed")]);
    expect(box.destroyCalls).toEqual([]);
    expect(ledger.boxes.has("p:dev:di")).toBe(false);

    await c.say("/claude");
    const [again, link] = await c.received();
    expect(again).toBe(say("setting_up"));
    expect((await linkIn(link, "di", local("2099-11-04T10:00"))).valid).toBe(true);
    expect(ledger.boxes.has("p:dev:di")).toBe(true);
  });

  test("/claude while a failed box is still being removed says to try again in a few minutes", async () => {
    const box = fakeBox({ host: [{ retryable: false, detail: "POST /apps: 400" }], destroy: ["fail"] });
    box.created.add(await box.nameOf("dot"));
    const c = await devChat("dot", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });

    await c.say("/claude");
    expect(await c.received()).toEqual([say("setting_up")]);
    expect((await c.snapshot()).box?.state).toBe("reclaiming");

    await c.say("/claude");
    expect(await c.received()).toEqual([say("resetting")]);

    await c.advanceTo("2099-11-04T10:01");
    expect(await c.received()).toEqual([say("setup_failed")]);
    expect((await c.snapshot()).box).toBeNull();
  });

  test("polling sees the sign-in, flips the box to signed_in, confirms once, and stops polling", async () => {
    const box = fakeBox();
    const c = await devChat("eli", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    await c.advanceTo("2099-11-04T10:01");
    box.signedIn = true;
    await c.advanceTo("2099-11-04T10:02");

    expect(await c.received()).toEqual([say("connected")]);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
    const polls = box.healthCalls.length;
    await c.advanceTo("2099-11-04T10:30");
    expect(box.healthCalls).toHaveLength(polls);

    await c.say("/claude");
    expect(await c.received()).toEqual([say("already_connected")]);
  });

  test("the initial setup reply does not promise a link before the box is checked", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("setup-signed-in", { model: null, at: "2099-11-04T10:00", box: box.deps });

    await c.say("/claude");

    const [setup, ...followUps] = await c.received();
    expect(setup).toContain("Setting up");
    expect(setup).not.toMatch(/sign-in link/i);
    expect(followUps).toEqual([say("connected")]);
  });

  test("repeating /claude during setup does not promise a link before the box is checked", async () => {
    const box = fakeBox({ signedIn: true });
    box.reachable = false;
    const c = await devChat("provisioning-signed-in", { model: null, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();
    expect((await c.snapshot()).box?.state).toBe("provisioning");
    box.reachable = true;

    await c.say("/claude");

    const [setup, ...followUps] = await c.received();
    expect(setup).toContain("still being set up");
    expect(setup).not.toMatch(/sign-in link/i);
    expect(followUps).toEqual([]);

    await c.advanceTo("2099-11-04T10:01");
    expect(await c.received()).toEqual([say("connected")]);
  });

  test("repeating /claude after sign-in confirms the connection before the next poll", async () => {
    const box = fakeBox();
    const c = await devChat("sign-in-before-poll", { model: null, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();
    expect((await c.snapshot()).box?.state).toBe("signed_out");
    box.signedIn = true;

    await c.say("/claude");

    expect(await c.received()).toEqual([say("connected")]);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
    await c.say("/claude");
    expect(await c.received()).toEqual([say("already_connected")]);
  });

  test("after polling ends, /claude confirms a completed sign-in", async () => {
    const box = fakeBox();
    const c = await devChat("late-signin", { model: null, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    c.clock.set(local("2099-11-04T10:30"));
    await c.alarm();
    box.signedIn = true;
    await c.advanceTo("2099-11-04T10:31");
    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).box?.state).toBe("signed_out");

    await c.say("/claude");

    expect(await c.received()).toEqual([say("connected")]);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
  });

  const NOT_READY = [
    {
      lang: "en" as const,
      channel: undefined,
      ids: ["not-ready-setup", "not-ready-gone-out", "not-ready-gone-in"],
      text: "Your Claude plan isn't ready to answer yet. Send /claude to see where it stands. I might say setup is still running, send you a sign-in link, or confirm it's connected.",
    },
    {
      lang: "th" as const,
      channel: "line" as const,
      ids: ["U00000000000000000000000000000b01", "U00000000000000000000000000000b02", "U00000000000000000000000000000b03"],
      text: "ตอนนี้แพ็กเกจ Claude ของคุณยังไม่พร้อมตอบค่ะ ส่ง /claude เพื่อดูสถานะได้เลยนะคะ คำตอบอาจเป็นการแจ้งว่ายังตั้งค่าอยู่ ลิงก์เข้าสู่ระบบ หรือการยืนยันว่าเชื่อมแพ็กเกจแล้วค่ะ",
    },
  ];

  test.each(NOT_READY)("in $lang, a request while setup runs gets the not-ready notice, and /claude says setup is still running", async ({ lang, channel, ids, text }) => {
    const retry = { retryable: true, detail: "503" };
    const box = fakeBox({ host: [retry, retry, retry, retry] });
    const c = await devChat(ids[0], { model: null, at: "2099-11-04T10:00", box: box.deps, channel });
    await c.say("/claude");
    expect(await c.received()).toEqual([boxMessage("setting_up", lang, null).text]);
    expect((await c.snapshot()).box?.state).toBe("provisioning");

    await c.say("hello");
    expect(await c.received()).toEqual([text]);

    await c.say("/claude");
    expect(await c.received()).toEqual([boxMessage("still_setting_up", lang, null).text]);
  });

  test.each(NOT_READY)("in $lang, a request after the box is gone gets the not-ready notice, and /claude sets it up and sends a link", async ({ lang, channel, ids, text }) => {
    const box = fakeBox({ host: [{ retryable: false, detail: "POST /apps: 400" }] });
    const c = await devChat(ids[1], { model: null, at: "2099-11-04T10:00", box: box.deps, channel });
    await c.say("/claude");
    expect(await c.received()).toEqual([boxMessage("setting_up", lang, null).text, boxMessage("setup_failed", lang, null).text]);
    expect((await c.snapshot()).box).toBeNull();

    await c.say("hello");
    expect(await c.received()).toEqual([text]);

    await c.say("/claude");
    const [setup, link, ...rest] = await c.received();
    expect([setup, rest]).toEqual([boxMessage("setting_up", lang, null).text, []]);
    expect(link.replace(LINK, "<sign-in link>")).toBe(boxMessage("link", lang, null).note);
  });

  test.each(NOT_READY)("in $lang, a request after the box is gone gets the not-ready notice, and /claude confirms a sign-in the box already has", async ({ lang, channel, ids, text }) => {
    const box = fakeBox({ host: [{ retryable: false, detail: "POST /apps: 400" }], signedIn: true });
    const c = await devChat(ids[2], { model: null, at: "2099-11-04T10:00", box: box.deps, channel });
    await c.say("/claude");
    await c.received();
    expect((await c.snapshot()).box).toBeNull();

    await c.say("hello");
    expect(await c.received()).toEqual([text]);

    box.replies.push({ kind: "reply", step: chat("Hi.") });
    await c.say("/claude");
    expect(await c.received()).toEqual([boxMessage("setting_up", lang, null).text, boxMessage("connected", lang, null).text, `${NOTICES[lang].catchUp}\nHi.`]);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
  });

  test("a signed-in person's turn runs on their box with their token, reserves no spend, and is logged as backend 'box'", async () => {
    const box = fakeBox({ signedIn: true });
    const model = scripted([]);
    const c = await devChat("fin", { model, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    expect(await c.received()).toEqual([say("setting_up"), say("connected")]);

    box.replies.push({ kind: "reply", step: chat("Hello from your own plan.") });
    await c.say("hello");

    expect(await c.received()).toEqual(["Hello from your own plan."]);
    expect(box.parses).toEqual([
      {
        authorization: `Bearer ${await boxToken(BOX_SECRET, await box.nameOf("fin"))}`,
        user: expect.stringContaining("Person: hello"),
        agent: {
          append: expect.stringContaining("You are Giraffe"),
          tools: ["schedule_wakeup", "cancel_wakeup", "remember", "set_locale", "forget", "task"],
          session: null,
          sessionOwner: await boxSessionOwner(BOX_SECRET, "p:dev:fin" as AgentKey),
          resumed: false,
          fresh: expect.stringContaining("Person: hello"),
        },
        at: null,
      },
    ]);
    expect(model.calls).toHaveLength(0);
    expect((await c.snapshot()).spendThisMonthMicro).toBe(0);
    expect(c.logs("model_call").map((r) => [r.backend, r.status, r.costMicro, r.estimateMicro])).toEqual([["box", "settled", 0, 0]]);
    expect(c.logs("turn").map((r) => [r.outcome, r.costMicro])).toEqual([
      ["no_model", 0],
      ["acted", 0],
    ]);
  });

  test("each person names their own opaque session owner", async () => {
    const box = fakeBox({ signedIn: true });
    const first = await devChat("sess-one", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    const second = await devChat("sess-two", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await first.say("/claude");
    await second.say("/claude");
    await first.received();
    await second.received();
    box.replies.push({ kind: "reply", step: chat("One.") }, { kind: "reply", step: chat("Two.") });

    await first.say("hello one");
    await second.say("hello two");

    const owners = box.parses.map((p) => p.agent?.sessionOwner);
    expect(owners).toHaveLength(2);
    expect(owners[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(owners[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(owners[0]).not.toBe(owners[1]);
    expect(owners.join(" ")).not.toContain("sess-");
  });

  test("a box that answers signed_out mid-turn is marked and the person gets one fresh link, and no other money answers for it", async () => {
    const box = fakeBox({ signedIn: true });
    const model = scripted([]);
    const c = await devChat("gus", { model, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();
    box.signedIn = false;
    box.replies.push({ kind: "signed_out" });

    await c.say("hello");

    const [notice, ...rest] = await c.received();
    expect(rest).toEqual([]);
    expect(notice.startsWith(say("signed_out_link").split("\n")[0])).toBe(true);
    expect(notice).not.toMatch(/answering/);
    expect((await linkIn(notice, "gus", local("2099-11-04T10:00"))).valid).toBe(true);
    expect((await c.snapshot()).box?.state).toBe("signed_out");

    await c.say("again");
    expect(await c.received()).toEqual([]);
    expect(box.parses).toHaveLength(1);
    expect(model.calls).toHaveLength(0);
    expect(c.logs("model_call").map((r) => [r.backend, r.status])).toEqual([["box", "rejected"]]);
    expect(c.logs("turn").map((r) => r.outcome)).toEqual(["no_model", "no_access", "no_access"]);
    expect((await c.snapshot()).spendThisMonthMicro).toBe(0);
  });

  test("a box signing back in answers the rejected turn and the later waiting message together", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("catch-up-box", { model: null, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();
    box.signedIn = false;
    box.replies.push({ kind: "signed_out" });
    await c.say("Help me plan dinner.");
    expect(await c.received()).toEqual([expect.stringContaining("Once you sign in, I'll answer requests from the last 24 hours.")]);
    await c.say("Use the vegetables I have.");
    expect(await c.received()).toEqual([]);

    box.signedIn = true;
    box.replies.push({ kind: "reply", step: chat("Roast the vegetables for dinner.") });
    await c.advanceTo("2099-11-04T10:01");

    expect(await c.received()).toEqual([say("connected"), `${NOTICE.catchUp}\nRoast the vegetables for dinner.`]);
    expect(box.parses).toHaveLength(2);
    expect(box.parses[1].user.match(/Help me plan dinner\./g)).toHaveLength(1);
    expect(box.parses[1].user).toMatch(/Help me plan dinner\.[\s\S]*Use the vegetables I have\./);
    await c.say("/claude");
    expect(await c.received()).toEqual([say("already_connected")]);
    expect(box.parses).toHaveLength(2);
  });

  test("an unavailable box blip backs the turn off, retries it on the box, and never spends anyone's money", async () => {
    const box = fakeBox({ signedIn: true });
    const model = scripted([]);
    const c = await devChat("hal", { model, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    box.replies.push({ kind: "status", status: 503 });
    await c.say("hello");
    box.replies.push({ kind: "reply", step: chat("Recovered on your plan.") });
    await c.advanceTo("2099-11-04T10:01");

    expect(await c.received()).toEqual(["Recovered on your plan."]);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
    expect(box.parses).toHaveLength(2);

    box.replies.push({ kind: "reply", step: chat("Back on your plan.") });
    await c.say("later");
    expect(await c.received()).toEqual(["Back on your plan."]);
    expect(c.logs("model_call").map((r) => [r.backend, r.status])).toEqual([
      ["box", "unavailable"],
      ["box", "settled"],
      ["box", "settled"],
    ]);
    expect(model.calls).toHaveLength(0);
    expect((await c.snapshot()).spendThisMonthMicro).toBe(0);
  });

  test("a box that refuses a turn as stale keeps the person signed in and sends no sign-in link; the turn is retried, then apologised for", async () => {
    const box = fakeBox({ signedIn: true });
    const model = scripted([]);
    const c = await devChat("hap", { model, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    box.replies.push({ kind: "stale" }, { kind: "stale" }, { kind: "stale" });
    await c.say("hello");
    await c.advanceTo("2099-11-04T10:04");
    expect(await c.received()).toEqual([NOTICE.failed]);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
    expect(box.parses).toHaveLength(3);
    expect(c.logs("model_call").map((r) => [r.backend, r.status])).toEqual([
      ["box", "rejected"],
      ["box", "rejected"],
      ["box", "rejected"],
    ]);
    expect(model.calls).toHaveLength(0);
  });

  test("a person's own key backs up their box only after they said yes", async () => {
    const box = fakeBox({ signedIn: true });
    const provider = fakeProvider([{ kind: "output", value: { actions: [{ type: "send", text: "From your key." }], tasks: [], about: "" } }]);
    const c = await devChat("hil", { model: scripted([]), provider, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();
    await giveKey(c.agent);

    box.replies.push({ kind: "status", status: 503 }, { kind: "status", status: 503 }, { kind: "status", status: 503 });
    await c.say("hello");
    await c.advanceTo("2099-11-04T10:04");
    expect(await c.received()).toEqual([NOTICE.backupAsk("OpenCode Go"), NOTICE.failed]);
    expect(provider.seen).toHaveLength(0);

    c.clock.set(local("2099-11-04T10:10"));
    await giveKey(c.agent, { backup: true });
    box.replies.push({ kind: "status", status: 503 });
    await c.say("again");
    expect(await c.received()).toEqual(["From your key."]);
    expect(c.logs("model_call").map((r) => [r.backend, r.status])).toEqual([
      ["box", "unavailable"],
      ["box", "unavailable"],
      ["box", "unavailable"],
      ["box", "unavailable"],
      ["key", "settled"],
    ]);
  });

  test("a resting backup key does not hold a recovered box off", async () => {
    const box = fakeBox({ signedIn: true });
    const provider = fakeProvider([{ kind: "output", value: { actions: [{ type: "send", text: "From your key." }], tasks: [], about: "" } }]);
    const c = await devChat("resk", { model: scripted([]), provider, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await giveKey(c.agent, { backup: true });
    await c.received();

    box.replies.push({ kind: "status", status: 503 });
    await c.say("first");
    expect(await c.received()).toEqual(["From your key."]);
    expect(box.parses).toHaveLength(1);
    expect(provider.seen).toHaveLength(1);

    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(c.agent));
    await runInDurableObject(stub, (_agent, state) => {
      state.storage.sql.exec("UPDATE model_key SET fault = 'rate', failures = 1, rest_until = NULL, told_on = NULL, unreadable_under = NULL");
    });
    box.replies.push({ kind: "reply", step: chat("Back on your plan.") });
    await c.say("second");

    expect(await c.received()).toEqual(["Back on your plan."]);
    expect(box.parses).toHaveLength(2);
    expect(provider.seen).toHaveLength(1);
  });

  test("a backup key without worst-case cap room does not hold a recovered box off", async () => {
    const box = fakeBox({ signedIn: true });
    const provider = fakeProvider([{ kind: "output", value: { actions: [{ type: "send", text: "From your key." }], tasks: [], about: "" } }]);
    const c = await devChat("capk", { model: scripted([]), provider, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await giveKey(c.agent, { backup: true });
    await c.received();

    box.replies.push({ kind: "status", status: 503 });
    await c.say("first");
    expect(await c.received()).toEqual(["From your key."]);
    expect(box.parses).toHaveLength(1);
    expect(provider.seen).toHaveLength(1);

    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(c.agent));
    await runInDurableObject(stub, (_agent, state) => {
      state.storage.sql.exec("UPDATE model_key SET cap_micro = 1");
    });
    box.replies.push({ kind: "reply", step: chat("Back on your plan.") });
    await c.say("second");

    expect(await c.received()).toEqual(["Back on your plan."]);
    expect(box.parses).toHaveLength(2);
    expect(provider.seen).toHaveLength(1);
  });

  test("a box that answers signed_out says the backup key answers for now, and the key does", async () => {
    const box = fakeBox({ signedIn: true });
    const provider = fakeProvider([{ kind: "output", value: { actions: [{ type: "send", text: "From your key." }], tasks: [], about: "" } }]);
    const c = await devChat("hob", { model: scripted([]), provider, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await giveKey(c.agent, { backup: true });
    await c.received();
    box.signedIn = false;
    box.replies.push({ kind: "signed_out" });

    await c.say("hello");

    const [notice, ...rest] = await c.received();
    expect(notice.startsWith(say("signed_out_backup").split("\n")[0])).toBe(true);
    expect((await linkIn(notice, "hob", local("2099-11-04T10:00"))).valid).toBe(true);
    expect(rest).toEqual(["From your key."]);
  });

  test("a new BOX_IMAGE brings a live box up to date on its next drain, once and without a word to the person", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("ida", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    expect(await c.received()).toEqual([say("setting_up"), say("connected")]);
    expect(box.ensuredWith).toEqual(["registry.test/box:1"]);

    box.image = "registry.test/box:2";
    box.replies.push({ kind: "reply", step: chat("On your plan.") }, { kind: "reply", step: chat("Still on it.") });
    await c.say("hello");
    await c.say("again");

    expect(await c.received()).toEqual(["On your plan.", "Still on it."]);
    expect(box.ensuredWith).toEqual(["registry.test/box:1", "registry.test/box:2"]);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
  });

  test("a box that refuses its token is ensured again, silently, and the turn waits for it", async () => {
    const box = fakeBox({ signedIn: true });
    const model = scripted([]);
    const c = await devChat("jo", { model, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    box.replies.push({ kind: "status", status: 401 }, { kind: "reply", step: chat("Back on your plan.") });
    await c.say("hello");
    await c.advanceTo("2099-11-04T10:01");
    expect(await c.received()).toEqual(["Back on your plan."]);
    expect(box.ensureCalls).toHaveLength(2);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
    expect(model.calls).toHaveLength(0);
  });

  test("an ensure of a live box that fails every time retries every few minutes and never touches its state", async () => {
    const box = fakeBox({ signedIn: true, host: ["ok", ...Array(100).fill({ retryable: true, detail: "GET /apps: 503" })] });
    const c = await devChat("kai", { model: scripted([quietCheckin()]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    box.image = "registry.test/box:2";
    box.replies.push({ kind: "reply", step: chat("On your plan.") });
    await c.say("hello");
    await c.advanceTo("2099-11-04T11:00");

    expect(await c.received()).toEqual(["On your plan."]);
    expect(box.ensureCalls.length).toBeGreaterThan(10);
    expect(box.ensureCalls.length).toBeLessThan(15);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
  });

  test("MAX_BOXES refuses a box past the cap, and the refused person has none", async () => {
    const box = fakeBox({ maxBoxes: 1 });
    const ledger = memoryLedger();
    const ann = await devChat("ivy", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps, ledger });
    const bob = await devChat("jon", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps, ledger });

    await ann.say("/claude");
    await bob.say("/claude");

    expect((await ann.received())[0]).toBe(say("setting_up"));
    expect(await bob.received()).toEqual([say("full")]);
    expect((await bob.snapshot()).box).toBeNull();
    expect([...ledger.boxes.keys()]).toEqual(["p:dev:ivy"]);
  });

  test("a D1 failure while claiming the box says setup can't start now, once, and is not a model failure", async () => {
    const box = fakeBox();
    const ledger: MemoryLedger = {
      ...memoryLedger(),
      claimBox: async () => {
        throw new Error("D1 unavailable");
      },
    };
    const c = await devChat("lou", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps, ledger });

    await c.say("/claude");
    await c.advanceTo("2099-11-04T11:00");

    expect(await c.received()).toEqual([say("busy")]);
    expect(c.logs("turn").map((t) => [t.outcome, t.attempts])).toEqual([["no_model", 1]]);
    expect(c.logs("model_call")).toEqual([]);
    expect((await c.snapshot()).box).toBeNull();
  });

  test("/claude in a burst of messages is handled alone, and the model never sees it as part of its batch", async () => {
    const box = fakeBox();
    const model = scripted([chat("Hi!")]);
    const c = await devChat("kim", { model, at: "2099-11-04T10:00", box: box.deps });

    await c.post("hi");
    await c.post("/claude");
    await c.settle();

    const sent = await c.received();
    expect(sent.slice(0, 2)).toEqual(["Hi!", say("setting_up")]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].user).not.toContain("/claude");
  });
});

describe("confirming disk deletion on automatic reclaim", () => {
  async function startReclaim(
    user: string, reason: ReclaimReason | null, box: NonNullable<Parameters<typeof devChat>[1]["box"]>,
    opts: { signedIn?: true; channel?: "line" } = {},
  ) {
    const ledger = memoryLedger();
    const c = await devChat(user, { model: scripted([chat("Hi.")]), at: "2099-11-04T10:00", ledger, box, channel: opts.channel });
    await c.say("hello");
    await c.received();
    const now = c.clock.now();
    const name = box.host.kind === "fly" ? app : await box.host.nameFor(c.agent);
    await ledger.claimBox({ agent: c.agent, name, host: box.host.kind, at: now, max: 10 });
    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(c.agent));
    const stateName = opts.signedIn ? "signed_in" : reason === null ? "provisioning" : "reclaiming";
    await runInDurableObject(stub, (_agent, state) => {
      state.storage.sql.exec(
        `INSERT INTO box (one, name, host, url, state, state_at, attempts, next_at, reclaim_reason)
         VALUES (1, ?, ?, ?, ?, ?, 0, ?, ?)`,
        name, box.host.kind, box.host.urlOf(name), stateName, now, opts.signedIn ? null : now, reason,
      );
    });
    return { c, ledger, stub };
  }

  function flyReclaim({
    machine, boxFailure, relistAfterAppDelete = false, keepVolumeAfterDelete = !relistAfterAppDelete, createApp,
  }: {
    machine: string | null;
    boxFailure?: "health" | "erase";
    relistAfterAppDelete?: boolean;
    keepVolumeAfterDelete?: boolean;
    createApp?: () => Response;
  }) {
    const requests: string[] = [];
    const boxRequests: string[] = [];
    let appExists = true;
    let volumeState = "created";
    let volumeListDown = false;
    const incarnation = crypto.randomUUID();
    const host = flyHost(flyConfig, async (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method;
      requests.push(`${method} ${path}`);
      if (path === "/v1/apps" && method === "POST" && createApp) return createApp();
      if (path === "/v1/apps") return Response.json({ apps: appExists ? [{ name: app }] : [] });
      if (path === `/v1/apps/${app}`) {
        if (method === "DELETE") {
          appExists = false;
          if (relistAfterAppDelete) volumeState = "created";
          return new Response(null, { status: 202 });
        }
        return appExists ? Response.json({ organization: { slug: "giraffes" } }) : new Response(null, { status: 404 });
      }
      if (method === "GET" && path === `/v1/apps/${app}/volumes`) {
        if (volumeListDown) {
          volumeListDown = false;
          return new Response(null, { status: 500 });
        }
        return Response.json([{ id: "vol_1", state: volumeState, attached_machine_id: machine }]);
      }
      if (method === "DELETE" && (path.endsWith("/volumes/vol_1") || path.endsWith("/machines/machine_1"))) {
        if (path.endsWith("/volumes/vol_1") && !keepVolumeAfterDelete) volumeState = "destroyed";
        return new Response(null, { status: 202 });
      }
      return new Response(null, { status: 500 });
    });
    const client = boxClient(async (url, init) => {
      const path = new URL(url).pathname;
      boxRequests.push(path);
      if (boxFailure === "health") return new Response(null, { status: 503 });
      if (path === "/health") return Response.json({ ok: true, signedIn: false, authMethod: "none", box: incarnation });
      if (path === "/erase") {
        if (boxFailure === "erase") return new Response(null, { status: 412 });
        const payload = JSON.parse(String(init?.body));
        if (payload.scope === "account" && payload.box === incarnation) {
          requests.push("box wipe");
          return Response.json({ scope: "account", box: incarnation, floor: payload.epoch });
        }
      }
      return new Response(null, { status: 500 });
    });
    return {
      deps: { host, client, secret: BOX_SECRET, onlyFor: null, maxBoxes: 10 },
      requests, boxRequests,
      destructive: () => requests.filter((request) => request === "box wipe" || request.startsWith("DELETE")),
      confirmVolumeGone: () => { volumeState = "destroyed"; },
      failNextVolumeList: () => { volumeListDown = true; },
      restoreBox: () => { boxFailure = undefined; },
    };
  }

  const volumeList = `GET /v1/apps/${app}/volumes`;
  const volumeDelete = `DELETE /v1/apps/${app}/volumes/vol_1`;
  const appDelete = `DELETE /v1/apps/${app}`;
  test.each([
    { reason: "retired", notice: say("retired"), machine: "machine_1" },
    { reason: "unused", notice: say("reclaimed"), machine: "machine_1" },
    { reason: "failed", notice: say("setup_failed"), machine: null },
  ] satisfies { reason: ReclaimReason; notice: string; machine: string | null }[])("keeps a $reason box reserved while its volume is still live", async ({ reason, notice, machine }) => {
    const { deps, destructive, confirmVolumeGone } = flyReclaim({ machine });
    const { c, ledger } = await startReclaim(`reclaim-${reason}`, reason, deps);
    await c.alarm();

    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).box?.state).toBe("reclaiming");
    expect(ledger.boxes.has(c.agent)).toBe(true);
    const firstDeletes = machine ? ["box wipe", `DELETE /v1/apps/${app}/machines/${machine}`, volumeDelete] : [volumeDelete];
    expect(destructive()).toEqual(firstDeletes);

    await c.advanceTo("2099-11-04T10:01");
    expect(await c.received()).toEqual([]);
    expect(ledger.boxes.has(c.agent)).toBe(true);
    expect(destructive().filter((request) => request === volumeDelete).length).toBeGreaterThan(1);
    expect(destructive()).not.toContain(appDelete);

    confirmVolumeGone();
    await c.advanceTo("2099-11-04T10:03");
    expect(await c.received()).toEqual([notice]);
    expect((await c.snapshot()).box).toBeNull();
    expect(ledger.boxes.has(c.agent)).toBe(false);
    expect(destructive().filter((request) => request === "box wipe")).toHaveLength(machine ? 1 : 0);
    expect(destructive().at(-1)).toBe(appDelete);
  });

  test.each<"health" | "erase">(["health", "erase"])(
    "a failed setup with permanent %s failure skips the wipe after three tries and waits for disk confirmation",
    async (boxFailure) => {
      const { deps, requests, boxRequests, destructive, confirmVolumeGone } = flyReclaim({
        machine: "machine_1", boxFailure, relistAfterAppDelete: true,
      });
      const { c, ledger } = await startReclaim(`reclaim-failed-${boxFailure}`, "failed", deps);

      await c.alarm();
      expect(destructive()).toEqual([]);
      await c.advanceTo("2099-11-04T10:01");
      expect(destructive()).toEqual([`DELETE /v1/apps/${app}/machines/machine_1`, volumeDelete, appDelete]);
      const failedPath = `/${boxFailure}`;
      expect(boxRequests.filter((path) => path === failedPath)).toHaveLength(3);
      expect(requests.at(-1)).toBe(volumeList);
      expect(await c.received()).toEqual([]);
      expect((await c.snapshot()).box?.state).toBe("reclaiming");
      expect(ledger.boxes.has(c.agent)).toBe(true);

      confirmVolumeGone();
      await c.advanceTo("2099-11-04T10:03");
      expect(requests.at(-1)).toBe(volumeList);
      expect(await c.received()).toEqual([say("setup_failed")]);
      expect((await c.snapshot()).box).toBeNull();
      expect(ledger.boxes.has(c.agent)).toBe(false);
      await c.advanceTo("2099-11-04T11:00");
      expect(await c.received()).toEqual([]);
      expect(boxRequests.filter((path) => path === failedPath)).toHaveLength(3);
    },
  );

  async function failedSetupInRetryWindow(user: string) {
    const fly = flyReclaim({ machine: "machine_1", boxFailure: "health", keepVolumeAfterDelete: false });
    const { c, ledger } = await startReclaim(user, "failed", fly.deps);
    await c.alarm();
    expect(fly.boxRequests).toEqual(["/health"]);
    expect(fly.destructive()).toEqual([]);
    expect(await c.received()).toEqual([]);
    return { ...fly, c, ledger };
  }

  test.each([false, true])("/claude remove during failed setup cleanup frees the slot (restart: %s)", async (restart) => {
    const { c, ledger, deps, boxRequests, destructive } = await failedSetupInRetryWindow(`failed-remove-${restart}`);

    await c.say("/claude remove");
    expect(await c.received()).toEqual([say("removing")]);
    if (restart) {
      const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(c.agent));
      await runInDurableObject(stub, async (_agent, state) => {
        const fresh = new Agent(state, testEnv);
        fresh.withDeps({
          admission: "open", clock: c.clock, ledger, box: deps,
          channels: { dev: c.channel, line: c.channel, telegram: c.channel },
        });
        for (let retry = 0; retry < 2; retry++) {
          const due = await state.storage.getAlarm();
          if (due === null) throw new Error("missing cleanup retry alarm");
          c.clock.set(due as EpochMs);
          await fresh.alarm();
        }
      });
    } else {
      await c.advanceTo("2099-11-04T10:01");
    }

    expect(destructive()).toEqual([`DELETE /v1/apps/${app}/machines/machine_1`, volumeDelete, appDelete]);
    expect(boxRequests).toEqual(["/health", "/health", "/health"]);
    expect(await c.received()).toEqual([say("removed")]);
    expect((await c.snapshot()).box).toBeNull();
    expect(ledger.boxes.has(c.agent)).toBe(false);
    await c.say("/claude");
    expect(await c.received()).toEqual([say("setting_up")]);
  });

  test("operator removal during failed setup cleanup frees the slot", async () => {
    const { c, ledger, boxRequests, destructive } = await failedSetupInRetryWindow("failed-operator-remove");

    await c.remove();
    await c.advanceTo("2099-11-04T10:01");

    expect(destructive()).toEqual([`DELETE /v1/apps/${app}/machines/machine_1`, volumeDelete, appDelete]);
    expect(boxRequests).toEqual(["/health", "/health", "/health"]);
    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).box).toBeNull();
    expect(ledger.boxes.has(c.agent)).toBe(false);
  });

  test("/erase during failed setup cleanup sends a receipt after the disk and app go", async () => {
    const { c, boxRequests, requests, destructive } = await failedSetupInRetryWindow("failed-account-erase");
    await testEnv.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at) VALUES (?, ?, 'fly', ?)")
      .bind(c.agent, app, c.clock.now()).run();

    await c.say("/erase");
    const confirm = c.channel.delivered.at(-1)?.button;
    if (!confirm) throw new Error("missing erasure confirmation");
    await c.tap(confirm.data);
    expect(destructive()).toEqual([]);
    expect((await c.received()).every((text) => !text.includes(ACCOUNT_COPY.en.receipt))).toBe(true);

    await c.advanceTo("2099-11-04T10:03");

    expect(destructive()).toEqual([`DELETE /v1/apps/${app}/machines/machine_1`, volumeDelete, appDelete]);
    const diskCheck = requests.indexOf(volumeList, requests.indexOf(volumeDelete) + 1);
    expect(diskCheck).toBeGreaterThan(requests.indexOf(volumeDelete));
    expect(diskCheck).toBeLessThan(requests.indexOf(appDelete));
    expect(boxRequests).toEqual(["/health", "/health", "/health"]);
    const receipt = await c.received();
    expect(receipt).toEqual([expect.stringContaining(ACCOUNT_COPY.en.receipt)]);
    expect(receipt[0]).toContain(ACCOUNT_COPY.en.deletedUnwipedBox);
    expect(await testEnv.LEDGER.prepare("SELECT name FROM boxes WHERE name = ?").bind(app).first()).toBeNull();
  });

  test.each(["person", "operator"])("removal by the %s while setup is still retrying frees the slot", async (who) => {
    const fly = flyReclaim({ machine: "machine_1", boxFailure: "health", keepVolumeAfterDelete: false });
    const deps = { ...fly.deps, host: { ...fly.deps.host, ensure: async () => HOST_OK } };
    const { c, ledger, stub } = await startReclaim(`remove-retrying-${who}`, null, deps);
    await c.alarm();
    expect(fly.boxRequests).toEqual(["/health"]);
    expect((await c.snapshot()).box?.state).toBe("provisioning");

    if (who === "operator") {
      await c.remove();
    } else {
      await c.say("/claude remove");
      expect(await c.received()).toEqual([say("removing")]);
    }
    await c.advanceTo("2099-11-04T10:03");

    expect(fly.destructive()).toEqual([`DELETE /v1/apps/${app}/machines/machine_1`, volumeDelete, appDelete]);
    const diskCheck = fly.requests.indexOf(volumeList, fly.requests.indexOf(volumeDelete) + 1);
    expect(diskCheck).toBeGreaterThan(fly.requests.indexOf(volumeDelete));
    expect(diskCheck).toBeLessThan(fly.requests.indexOf(appDelete));
    expect((await c.snapshot()).box).toBeNull();
    expect(ledger.boxes.has(c.agent)).toBe(false);
    expect(await c.received()).toEqual(who === "operator" ? [] : [say("removed")]);

    if (who === "operator") {
      await runInDurableObject(stub, (_, { storage }) => { storage.sql.exec("DELETE FROM admission"); });
      await c.say("hello");
    }
    await c.say("/claude");
    expect(await c.received()).toEqual([say("setting_up")]);
    expect((await c.snapshot()).box?.state).toBe("provisioning");
    expect(ledger.boxes.has(c.agent)).toBe(true);
  });

  async function driveRetirement(
    { c, stub, ledger }: Awaited<ReturnType<typeof startReclaim>>,
    box: NonNullable<Parameters<typeof devChat>[1]["box"]>,
    until: number,
    restart = false,
    billing?: BillingKit["deps"],
  ) {
    const attempts: number[] = [];
    for (;;) {
      const due = await runInDurableObject(stub, (_, { storage }) => storage.getAlarm());
      if (due === null || due > until) return attempts;
      if (attempts.length === 250) throw new Error("too many cleanup alarms");
      c.clock.set(Math.max(due, c.clock.now()) as EpochMs);
      attempts.push(c.clock.now());
      if (!restart) {
        await c.alarm();
        continue;
      }
      await runInDurableObject(stub, async (_, state) => {
        const fresh = new Agent(state, testEnv);
        fresh.withDeps({
          admission: "open", clock: c.clock, ledger, box, ...(billing ? { billing } : {}),
          channels: { dev: c.channel, line: c.channel, telegram: c.channel },
        });
        await fresh.alarm();
      });
    }
  }

  async function eraseDeadRemovedBox(user: string, keepVolumeAfterDelete = false, subscribed = false) {
    const fly = flyReclaim({ machine: "machine_1", boxFailure: "health", keepVolumeAfterDelete });
    const person = await startReclaim(user, "removed", fly.deps);
    const { c } = person;
    const startedAt = c.clock.now();
    await c.alarm();
    expect(fly.boxRequests).toEqual(["/health"]);
    expect(fly.destructive()).toEqual([]);
    await testEnv.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at) VALUES (?, ?, 'fly', ?)")
      .bind(c.agent, app, startedAt).run();
    if (subscribed) {
      await testEnv.LEDGER.prepare("INSERT INTO billing_subscription (id, owner_key, plan, status, seats, updated_at) VALUES (?, ?, 'standard', 'active', 1, 1)")
        .bind("sub_" + user, c.agent).run();
    }

    await c.say("/erase");
    const confirm = c.channel.delivered.at(-1)?.button;
    if (!confirm) throw new Error("missing erasure confirmation");
    await c.tap(confirm.data);
    await c.received();
    return {
      ...person, ...fly, startedAt,
      slot: () => testEnv.LEDGER.prepare("SELECT name FROM boxes WHERE name = ?").bind(app).first(),
    };
  }

  const hour = 60 * 60_000;

  test.each([
    {
      language: "en", channel: undefined,
      disclosure: "Giraffe deleted your box and its disk while erasing your account. Giraffe could not verify a disk wipe.",
    },
    {
      language: "th", channel: "line",
      disclosure: "Giraffe ลบกล่องของคุณพร้อมดิสก์ระหว่างการลบบัญชีนี้ Giraffe ไม่สามารถยืนยันได้ว่าข้อมูลบนดิสก์ถูกลบแล้ว",
    },
  ] as const)("direct erase of a used, never-removed dead box sends the $language receipt", async ({ language, channel, disclosure }) => {
    const { deps, destructive } = flyReclaim({ machine: "machine_1", boxFailure: "health", keepVolumeAfterDelete: false });
    const person = await startReclaim(`erase-dead-direct-${language}`, null, deps, { signedIn: true, channel });
    const { c } = person;
    const startedAt = c.clock.now();
    const copy = ACCOUNT_COPY[language];
    await testEnv.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at) VALUES (?, ?, 'fly', ?)")
      .bind(c.agent, app, startedAt).run();
    await c.say("/erase");
    const confirm = c.channel.delivered.at(-1)?.button;
    if (!confirm) throw new Error("missing erasure confirmation");
    await c.tap(confirm.data);
    await c.received();

    await driveRetirement(person, deps, startedAt + hour - 1, true);
    expect(destructive()).toEqual([]);
    expect(await c.received()).toEqual([]);

    await driveRetirement(person, deps, startedAt + hour, true);
    expect(destructive()).toEqual([`DELETE /v1/apps/${app}/machines/machine_1`, volumeDelete, appDelete]);
    expect(await c.received()).toEqual([expect.stringContaining(`${copy.receipt}\n\n${disclosure}\n\n${copy.flyCopies}`)]);
  });

  test("erasing a dead box keeps the earlier wording when the disk disappears before cleanup", async () => {
    const fly = flyReclaim({ machine: "machine_1", boxFailure: "health" });
    const person = await startReclaim("erase-dead-disk-gone", null, fly.deps, { signedIn: true });
    const { c } = person;
    const startedAt = c.clock.now();
    await testEnv.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at) VALUES (?, ?, 'fly', ?)")
      .bind(c.agent, app, startedAt).run();
    await c.say("/erase");
    const confirm = c.channel.delivered.at(-1)?.button;
    if (!confirm) throw new Error("missing erasure confirmation");
    await c.tap(confirm.data);
    await c.received();

    await driveRetirement(person, fly.deps, startedAt + hour - 1, true);
    expect(fly.destructive()).toEqual([]);
    vi.spyOn(fly.deps.client, "health").mockImplementationOnce(async () => {
      fly.confirmVolumeGone();
      return { kind: "unavailable", detail: "box offline" };
    });
    await driveRetirement(person, fly.deps, startedAt + hour, true);

    expect(fly.destructive()).toEqual([`DELETE /v1/apps/${app}/machines/machine_1`, appDelete]);
    const { reclaimedBox, flyCopies } = ACCOUNT_COPY.en;
    expect(await c.received()).toEqual([expect.stringContaining(`${reclaimedBox}\n\n${flyCopies}`)]);
    expect(await testEnv.LEDGER.prepare("SELECT name FROM boxes WHERE name = ?").bind(app).first()).toBeNull();
  });

  test.each([false, true])("a dead removed box finishes erasure after one hour without claiming a wipe (restart: %s)", async (restart) => {
    const person = await eraseDeadRemovedBox("erase-dead-removed-" + restart);
    const { c, deps, startedAt, destructive, requests, boxRequests, slot } = person;
    const tries = [
      startedAt,
      ...await driveRetirement(person, deps, startedAt + 10 * 60_000),
      ...await driveRetirement(person, deps, startedAt + hour - 1, restart),
      startedAt + hour,
    ];
    expect(Math.max(...tries.slice(1).map((at, i) => at - tries[i]))).toBeLessThanOrEqual(10 * 60_000);
    expect(destructive()).toEqual([]);
    expect(await c.received()).toEqual([]);
    expect(await slot()).not.toBeNull();

    await driveRetirement(person, deps, startedAt + hour, restart);
    expect(destructive()).toEqual(["DELETE /v1/apps/" + app + "/machines/machine_1", volumeDelete, appDelete]);
    const diskCheck = requests.indexOf(volumeList, requests.indexOf(volumeDelete) + 1);
    expect(diskCheck).toBeGreaterThan(requests.indexOf(volumeDelete));
    expect(diskCheck).toBeLessThan(requests.indexOf(appDelete));
    expect(boxRequests.length).toBeLessThanOrEqual(13);
    const receipts = await c.received();
    expect(receipts).toEqual([expect.stringContaining(ACCOUNT_COPY.en.receipt)]);
    expect(receipts[0]).toContain(ACCOUNT_COPY.en.deletedUnwipedBox);
    expect(await slot()).toBeNull();
  });

  test.each([20, 40])("a box that comes back at minute %i of the erase grace period is wiped within ten minutes", async (minute) => {
    const person = await eraseDeadRemovedBox("erase-recovered-removed-" + minute);
    const { c, deps, startedAt, destructive, restoreBox, slot } = person;
    const attempts = await driveRetirement(person, deps, startedAt + minute * 60_000);
    expect(destructive()).toEqual([]);
    restoreBox();
    await driveRetirement(person, deps, startedAt + (minute + 10) * 60_000);
    expect(destructive()[0]).toBe("box wipe");
    expect(destructive().at(-1)).toBe(appDelete);
    const receipts = await c.received();
    expect(receipts).toEqual([expect.stringContaining(ACCOUNT_COPY.en.receipt)]);
    expect(receipts[0]).not.toContain("could not verify a disk wipe");
    expect(await slot()).toBeNull();
    expect(attempts.slice(0, 4).map((at) => (at - startedAt) / 1000)).toEqual([15, 45, 105, 225]);
  });

  test("a disk that keeps listing after a dead box is erased holds the slot and backs off", async () => {
    const person = await eraseDeadRemovedBox("erase-dead-disk-stays", true);
    const { c, deps, startedAt, destructive, slot } = person;
    await driveRetirement(person, deps, startedAt + hour);
    expect(destructive()).toContain(volumeDelete);
    expect(await c.received()).toEqual([]);
    expect(await slot()).not.toBeNull();

    const attempts = await driveRetirement(person, deps, startedAt + 6 * hour, true);
    expect(attempts.slice(0, 3).map((at) => (at - startedAt - hour) / 1000)).toEqual([15, 45, 105]);
    expect(await c.received()).toEqual([]);
    expect(await slot()).not.toBeNull();
    expect(destructive()).not.toContain(appDelete);
    expect(destructive().filter((request) => request === volumeDelete).length).toBeGreaterThan(1);
    expect(attempts.length).toBeLessThan(12);
    expect(attempts.at(-1)! - attempts.at(-2)!).toBe(hour);
  });

  async function expectErasedWithinAMinuteOfTheHour(person: Awaited<ReturnType<typeof eraseDeadRemovedBox>>, restart: boolean) {
    const { c, deps, startedAt, destructive, slot } = person;
    await driveRetirement(person, deps, startedAt + hour + 60_000, restart);
    expect(destructive().at(-1)).toBe(appDelete);
    const receipts = await c.received();
    expect(receipts).toEqual([expect.stringContaining(ACCOUNT_COPY.en.receipt)]);
    expect(receipts[0]).toContain(ACCOUNT_COPY.en.deletedUnwipedBox);
    expect(await slot()).toBeNull();
  }

  test.each([false, true])("a disk delete that fails once after the hour is retried within seconds (restart: %s)", async (restart) => {
    const person = await eraseDeadRemovedBox("erase-disk-fails-once-" + restart, true);
    const { c, deps, startedAt, destructive, confirmVolumeGone, slot } = person;
    await driveRetirement(person, deps, startedAt + hour, restart);
    expect(destructive()).toContain(volumeDelete);
    expect(destructive()).not.toContain(appDelete);
    expect(await c.received()).toEqual([]);
    expect(await slot()).not.toBeNull();

    confirmVolumeGone();
    await expectErasedWithinAMinuteOfTheHour(person, restart);
  });

  test.each([false, true])("a Fly check that fails once at the end of the hour is retried within seconds (restart: %s)", async (restart) => {
    const person = await eraseDeadRemovedBox("erase-check-fails-once-" + restart);
    const { c, deps, startedAt, destructive, failNextVolumeList, slot } = person;
    await driveRetirement(person, deps, startedAt + hour - 1, restart);
    failNextVolumeList();
    await driveRetirement(person, deps, startedAt + hour, restart);
    expect(destructive()).toEqual([]);
    expect(await c.received()).toEqual([]);
    expect(await slot()).not.toBeNull();

    await expectErasedWithinAMinuteOfTheHour(person, restart);
  });

  async function eraseWhileStripeIsDown(user: string) {
    let stripeDown = true;
    const kit = billingOn();
    const closeSubscription = async (): Promise<StripeReply<{ readonly retained: boolean }>> =>
      stripeDown ? { ok: false, status: 500, detail: "stripe 500" } : { ok: true, value: { retained: false } };
    const person = await eraseDeadRemovedBox(user, true, true);
    const billing = { ...kit.deps, stripe: { ...kit.stripe, closeSubscription } };
    return {
      ...person,
      drive: (until: number) => driveRetirement(person, person.deps, until, true, billing),
      restoreStripe: () => { stripeDown = false; },
    };
  }

  /** What the previous build saved here: tries counted across the wipe deadline, and a one-minute alarm for billing. */
  async function saveAsPreviousBuild({ stub, c }: Awaited<ReturnType<typeof eraseWhileStripeIsDown>>, attempts: number, boxNextAt: number) {
    await runInDurableObject(stub, async (_, { storage }) => {
      const job = storage.kv.get<Extract<Erasure, { kind: "cleaning" }>>(ERASE_JOB);
      expect(job?.billing.kind).toBe("pending");
      const nextAt = c.clock.now() + 60_000;
      storage.kv.put(ERASE_JOB, { ...job, boxRetry: { attempts, nextAt: boxNextAt }, nextAt });
      await storage.setAlarm(nextAt);
    });
  }

  test("an erase the previous build saved after the hour tries the disk again within a minute once billing clears", async () => {
    const person = await eraseWhileStripeIsDown("erase-previous-build-after-hour");
    const { c, startedAt, destructive, confirmVolumeGone, restoreStripe, drive, slot } = person;
    await drive(startedAt + hour);
    expect(destructive()).toContain(volumeDelete);
    await saveAsPreviousBuild(person, 9, startedAt + 2 * hour);

    confirmVolumeGone();
    restoreStripe();
    await drive(startedAt + hour + 60_000);
    expect(destructive().at(-1)).toBe(appDelete);
    expect(await c.received()).toEqual([expect.stringContaining(ACCOUNT_COPY.en.receipt)]);
    expect(await slot()).toBeNull();
  });

  test("an erase the previous build saved after the hour, whose disk never goes, holds the slot and backs off to hourly", async () => {
    const person = await eraseWhileStripeIsDown("erase-previous-build-disk-stays");
    const { c, startedAt, destructive, restoreStripe, drive, slot } = person;
    await drive(startedAt + hour);
    await saveAsPreviousBuild(person, 9, startedAt + 2 * hour);
    restoreStripe();

    const attempts = await drive(startedAt + 8 * hour);
    expect(attempts.slice(0, 4).map((at) => (at - startedAt - hour) / 1000)).toEqual([60, 75, 105, 165]);
    expect(attempts.at(-1)! - attempts.at(-2)!).toBe(hour);
    expect(await c.received()).toEqual([]);
    expect(await slot()).not.toBeNull();
    expect(destructive()).not.toContain(appDelete);
  });

  test("an erase the previous build saved during the hour keeps tries ten minutes apart and deletes nothing early", async () => {
    const person = await eraseWhileStripeIsDown("erase-previous-build-in-hour");
    const { c, startedAt, destructive, restoreStripe, drive, slot } = person;
    await drive(startedAt + 40 * 60_000);
    await saveAsPreviousBuild(person, 8, startedAt + hour);
    restoreStripe();

    const savedAt = c.clock.now();
    const tries = [savedAt, ...await drive(startedAt + hour - 1), startedAt + hour];
    expect(Math.max(...tries.slice(1).map((at, i) => at - tries[i]))).toBeLessThanOrEqual(10 * 60_000);
    expect(destructive()).toEqual([]);

    const after = await drive(startedAt + 8 * hour);
    expect(destructive()).toContain(volumeDelete);
    expect(destructive()).not.toContain(appDelete);
    expect(after.at(-1)! - after.at(-2)!).toBe(hour);
    expect(await c.received()).toEqual([]);
    expect(await slot()).not.toBeNull();
  });

  test.each([false, true])("removal after setup fails on the last alarm step frees the slot (restart: %s)", async (restart) => {
    let advanceClock = (_ms: number) => {};
    let tries = 0;
    const fly = flyReclaim({
      machine: "machine_1", boxFailure: "health", keepVolumeAfterDelete: false,
      createApp: () => {
        tries++;
        if (tries === 3) return new Response(null, { status: 403 });
        advanceClock(tries === 1 ? 16_000 : 31_000);
        throw new Error("Fly timed out");
      },
    });
    const person = await startReclaim("remove-after-last-step-" + restart, null, fly.deps);
    const { c, ledger } = person;
    advanceClock = (ms) => c.clock.set((c.clock.now() + ms) as EpochMs);
    await c.alarm();
    expect(tries).toBe(3);
    expect((await c.snapshot()).box?.state).toBe("reclaiming");
    expect(fly.boxRequests).toEqual([]);

    await c.say("/claude remove");
    expect(await c.received()).toEqual([say("removing")]);
    await driveRetirement(person, fly.deps, c.clock.now() + 2 * 60_000, restart);
    expect(fly.destructive()).toEqual(["DELETE /v1/apps/" + app + "/machines/machine_1", volumeDelete, appDelete]);
    expect(await c.received()).toEqual([say("removed")]);
    expect((await c.snapshot()).box).toBeNull();
    expect(ledger.boxes.has(c.agent)).toBe(false);
  });

  test("a saved retirement from before the failed-setup flag still requires a wipe", async () => {
    const { deps, boxRequests, destructive } = flyReclaim({
      machine: "machine_1", boxFailure: "health", keepVolumeAfterDelete: false,
    });
    const { c, ledger } = await startReclaim("legacy-failed-reclaim", "failed", deps);
    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(c.agent));
    await runInDurableObject(stub, (_agent, state) => {
      state.storage.kv.put("box:retirement", {
        kind: "locate", box: { name: app, host: "fly", url: deps.host.urlOf(app), incarnation: null },
      } satisfies EraseBox);
    });

    await c.alarm();
    await c.advanceTo("2099-11-04T10:03");

    expect(boxRequests.length).toBeGreaterThan(3);
    expect(destructive()).toEqual([]);
    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).box?.state).toBe("reclaiming");
    expect(ledger.boxes.has(c.agent)).toBe(true);
  });

  test("a lapsed box with permanent health failure keeps its slot without deleting anything", async () => {
    const { deps, boxRequests, destructive } = flyReclaim({ machine: "machine_1", boxFailure: "health" });
    const { c, ledger } = await startReclaim("reclaim-lapsed-dead", "retired", deps);
    await c.alarm();
    await c.advanceTo("2099-11-05T12:00");

    expect(boxRequests.filter((path) => path === "/health").length).toBeGreaterThan(3);
    expect(destructive()).toEqual([]);
    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).box?.state).toBe("reclaiming");
    expect(ledger.boxes.has(c.agent)).toBe(true);
  });

  test.each([
    { reason: "retired", notice: say("retired") },
    { reason: "unused", notice: say("reclaimed") },
    { reason: "failed", notice: say("setup_failed") },
  ] satisfies { reason: ReclaimReason; notice: string }[])("releases a $reason slot for an ownerless shared box without touching the box", async ({ reason, notice }) => {
    const requests: string[] = [];
    const host = staticHost({ url: "http://static.box.test", appPrefix: "gbox-" });
    const client = boxClient(async (url) => {
      requests.push(url);
      return new Response(null, { status: 503 });
    });
    const { c, ledger } = await startReclaim(`reclaim-shared-${reason}`, reason, { host, client, secret: BOX_SECRET, onlyFor: null, maxBoxes: 10 });

    await c.alarm();
    expect(requests).toEqual([]);
    expect(await c.received()).toEqual([notice]);
    expect((await c.snapshot()).box).toBeNull();
    expect(ledger.boxes.has(c.agent)).toBe(false);
  });
});

describe("a sign-in link sent for the box before a replacement", () => {
  const FLY_LINK = /https:\/\/[a-z0-9-]+\.fly\.dev\/signin#t=((\d+)\.[A-Za-z0-9_-]+)/;

  /** One Fly app at a time under one name, as a replacement box reuses its predecessor's name. */
  function replaceableFly() {
    const requests: string[] = [];
    const box = { name: "", appExists: false, volume: "destroyed", incarnation: "", reachable: true, signedIn: false };
    const host = flyHost(flyConfig, async (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      requests.push(`${method} ${path}`);
      const [, name, rest = ""] = /^\/v1\/apps(?:\/([^/]+))?(\/.*)?$/.exec(path) ?? [];
      if (!name) return Response.json({ apps: box.appExists ? [{ name: box.name }] : [] });
      if (rest === "" && method === "DELETE") {
        box.appExists = false;
        return new Response(null, { status: 202 });
      }
      if (rest === "") return box.appExists ? Response.json({ organization: { slug: "giraffes" } }) : new Response(null, { status: 404 });
      if (rest === "/volumes" && method === "GET") {
        return box.appExists
          ? Response.json([{ id: "vol_1", state: box.volume, attached_machine_id: box.volume === "created" ? "machine_1" : null }])
          : new Response(null, { status: 404 });
      }
      if (rest === "/volumes/vol_1" && method === "DELETE") {
        box.volume = "destroyed";
        return new Response(null, { status: 202 });
      }
      if (rest === "/machines/machine_1" && method === "DELETE") return new Response(null, { status: 202 });
      return new Response(null, { status: 500 });
    });
    const ensure: typeof host.ensure = async (name) => {
      box.name = name;
      if (!box.appExists) Object.assign(box, { appExists: true, volume: "created", incarnation: crypto.randomUUID(), signedIn: false });
      return HOST_OK;
    };
    const client = boxClient(async (url, init) => {
      const path = new URL(url).pathname;
      requests.push(`box ${path}`);
      if (!box.reachable || !box.appExists) return new Response(null, { status: 503 });
      if (path === "/health") return Response.json({ ok: true, signedIn: box.signedIn, authMethod: box.signedIn ? "oauth" : "none", box: box.incarnation });
      const erase = path === "/erase" ? JSON.parse(String(init?.body)) : null;
      if (erase?.scope !== "account" || erase.box !== box.incarnation) return new Response(null, { status: 412 });
      requests.push("box wipe");
      box.signedIn = false;
      return Response.json({ scope: "account", box: box.incarnation, floor: erase.epoch });
    });
    const unwipedDelete = () => [`DELETE /v1/apps/${box.name}/machines/machine_1`, `DELETE /v1/apps/${box.name}/volumes/vol_1`, `DELETE /v1/apps/${box.name}`];
    return {
      box, requests, unwipedDelete,
      deps: { host: { ...host, ensure }, client, secret: BOX_SECRET, onlyFor: null, maxBoxes: 10 },
      destructive: () => requests.filter((r) => r === "box wipe" || r.startsWith("DELETE")),
      wipeThenDelete: () => ["box wipe", ...unwipedDelete()],
    };
  }

  /** The first box sends its link at 10:00 and is wiped and removed at 10:01; its replacement starts at `replaceAt` and never answers Giraffe's setup check. */
  async function replacementInSetup(user: string, replaceAt: string) {
    const fly = replaceableFly();
    const ledger = memoryLedger();
    const c = await devChat(user, { model: scripted([chat("Hi.")]), at: "2099-11-04T10:00", ledger, box: fly.deps });
    await c.say("hello");
    await c.received();
    await c.say("/claude");
    const link = FLY_LINK.exec((await c.received()).join("\n"));
    if (!link) throw new Error("the first box sent no sign-in link");
    const [, ticket, expires] = link;
    expect(Number(expires)).toBe(local("2099-11-04T10:30"));
    await c.advanceTo("2099-11-04T10:01");
    await c.say("/claude remove");
    await c.advanceTo("2099-11-04T10:04");
    expect(fly.destructive()).toEqual(fly.wipeThenDelete());
    expect((await c.snapshot()).box).toBeNull();

    await c.advanceTo(replaceAt);
    fly.box.reachable = false;
    await c.say("/claude");
    expect(await c.received()).toEqual([say("removing"), say("removed"), say("setting_up")]);
    expect((await c.snapshot()).box?.state).toBe("provisioning");
    const replacementTicket = await signinTicket(await boxToken(BOX_SECRET, fly.box.name as BoxName), Number(expires) as EpochMs);
    expect(replacementTicket, "the old link opens the replacement").toBe(ticket);
    fly.requests.length = 0;
    return { c, fly, ledger };
  }

  test.each([
    { by: "person", replaceAt: "10:05", removeAt: "10:05", checkAt: "10:25" },
    { by: "person", replaceAt: "10:20", removeAt: "10:40", checkAt: "11:00" },
    { by: "operator", replaceAt: "10:05", removeAt: "10:07", checkAt: "10:27" },
  ] as const)(
    "removal by the $by at $removeAt keeps the disk of a replacement set up at $replaceAt until the box is wiped",
    async ({ by, replaceAt, removeAt, checkAt }) => {
      const { c, fly, ledger } = await replacementInSetup(`old-link-${by}-${removeAt.replace(":", "")}`, `2099-11-04T${replaceAt}`);
      fly.box.signedIn = true;
      await c.advanceTo(`2099-11-04T${removeAt}`);
      expect((await c.snapshot()).box?.state).toBe("provisioning");
      const mark = fly.requests.length;
      if (by === "operator") {
        await c.remove();
      } else {
        await c.say("/claude remove");
        expect(await c.received()).toEqual([say("removing")]);
      }

      await c.advanceTo(`2099-11-04T${checkAt}`);
      expect(fly.destructive()).toEqual([]);
      expect(fly.requests.slice(mark).filter((r) => r === "box /health").length).toBeGreaterThan(3);
      expect((await c.snapshot()).box?.state).toBe("reclaiming");
      expect(ledger.boxes.has(c.agent)).toBe(true);

      fly.box.reachable = true;
      await c.advanceTo("2099-11-04T12:00");
      expect(fly.destructive()).toEqual(fly.wipeThenDelete());
      expect(fly.box.signedIn).toBe(false);
      expect((await c.snapshot()).box).toBeNull();
      expect(ledger.boxes.has(c.agent)).toBe(false);
      expect(await c.received()).toEqual(by === "operator" ? [] : [say("removed")]);
    },
  );

  test("a replacement whose setup fails while an earlier link could have signed it in keeps its disk until the box is wiped", async () => {
    const { c, fly, ledger } = await replacementInSetup("old-link-failed-setup", "2099-11-04T10:15");
    fly.box.signedIn = true;

    await c.advanceTo("2099-11-04T10:33");
    expect((await c.snapshot()).box?.state, "setup still tries after the old link and its grace ran out").toBe("provisioning");
    await c.advanceTo("2099-11-04T11:00");
    expect(fly.destructive()).toEqual([]);
    expect((await c.snapshot()).box?.state).toBe("reclaiming");
    expect(fly.requests.filter((r) => r === "box /health").length).toBeGreaterThan(BOX.maxProvisionAttempts + 3);
    expect(ledger.boxes.has(c.agent)).toBe(true);

    fly.box.reachable = true;
    await c.advanceTo("2099-11-04T12:30");
    expect(fly.destructive()).toEqual(fly.wipeThenDelete());
    expect((await c.snapshot()).box).toBeNull();
    expect(ledger.boxes.has(c.agent)).toBe(false);
    expect(await c.received()).toEqual([say("setup_failed")]);
  });

  test("a replacement set up once the old link and its grace ran out is deleted without a wipe after three tries", async () => {
    const { c, fly, ledger } = await replacementInSetup("old-link-expired", "2099-11-04T10:32");

    await c.say("/claude remove");
    expect(await c.received()).toEqual([say("removing")]);
    await c.advanceTo("2099-11-04T10:35");

    expect(fly.destructive()).toEqual(fly.unwipedDelete());
    expect(fly.requests.filter((r) => r === "box /health")).toHaveLength(3);
    expect((await c.snapshot()).box).toBeNull();
    expect(ledger.boxes.has(c.agent)).toBe(false);
    expect(await c.received()).toEqual([say("removed")]);
  });

  test("an account erase keeps no record of the last sign-in link while it waits for the box", async () => {
    const fly = replaceableFly();
    const c = await devChat("old-link-erase", { model: scripted([chat("Hi.")]), at: "2099-11-04T10:00", ledger: memoryLedger(), box: fly.deps });
    await c.say("hello");
    await c.say("/claude");
    expect((await c.received()).join("\n")).toMatch(FLY_LINK);
    fly.box.reachable = false;

    await c.say("/erase");
    const confirm = c.channel.delivered.at(-1)?.button;
    if (!confirm) throw new Error("missing erasure confirmation");
    await c.tap(confirm.data);
    await c.advanceTo("2099-11-04T10:05");

    expect(fly.destructive()).toEqual([]);
    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName(c.agent));
    expect(await runInDurableObject(stub, async (_, { storage }) => [...(await storage.list()).keys()])).toEqual([ERASE_JOB]);
  });
});

describe("retiring a box the plan no longer allows", () => {
  const retiring = (until: string) => boxMessage("retiring", "en", null, until).text;
  const subscribe = async (kit: BillingKit, user: string, plan: "standard" | "included") => {
    expect((await stripeChange(kit, { user, sub: `sub_${user}`, plan, status: "active", type: "customer.subscription.created" })).status).toBe(200);
  };

  test("with billing on, a lapsed person is told the date once, and the box goes then even though it was signed in", async () => {
    const box = fakeBox({ signedIn: true });
    const ledger = memoryLedger();
    const c = await devChat("uma", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps, ledger, billing: billingOn({ TRIAL_DAYS: "1" }).deps });
    await c.say("/claude");
    expect(await c.received()).toEqual([say("setting_up"), say("connected")]);
    box.sessions.add("plan-session");
    box.replies.push({ kind: "reply", step: quietCheckin() });

    await c.advanceTo("2099-11-05T11:00");
    await c.say("hello");
    await c.say("still there?");
    expect(await c.received()).toEqual([retiring("19 November 2099"), NOTICE.lapsed]);

    await c.advanceTo("2099-11-19T10:59");
    expect(box.destroyCalls).toEqual([]);
    expect(box.sessions.has("plan-session")).toBe(true);
    await c.advanceTo("2099-11-19T11:00");

    expect(await c.received()).toEqual([say("retired")]);
    expect(box.destroyCalls).toEqual([await box.nameOf("uma")]);
    expect(box.sessions.size).toBe(0);
    expect(ledger.boxes.has("p:dev:uma")).toBe(false);
    expect((await c.snapshot()).box).toBeNull();
  });

  test("a plan that allows a box again before the date keeps the box, silently", async () => {
    const box = fakeBox({ signedIn: true });
    const kit = billingOn({ TRIAL_DAYS: "1" });
    const c = await devChat("vic", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps, billing: kit.deps });
    box.replies.push(...Array.from({ length: 30 }, () => ({ kind: "reply" as const, step: quietCheckin() })));
    await c.say("/claude");
    await c.advanceTo("2099-11-05T11:00");
    await c.say("hello");
    expect(await c.received()).toEqual([say("setting_up"), say("connected"), retiring("19 November 2099"), NOTICE.lapsed]);

    await c.advanceTo("2099-11-06T10:00");
    await subscribe(kit, "vic", "standard");
    await c.settle();
    expect(await c.received()).toEqual(["Thanks. Your Standard plan is active."]);
    await c.advanceTo("2099-11-25T10:00");

    expect(await c.received()).toEqual([]);
    expect(box.destroyCalls).toEqual([]);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
  });

  test("with billing off, a box is never retired", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("wyn", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    box.replies.push({ kind: "reply", step: chat("From your plan.") }, ...Array.from({ length: 30 }, () => ({ kind: "reply" as const, step: quietCheckin() })));
    await c.say("/claude");
    await c.received();

    await c.say("hello");
    expect(await c.received()).toEqual(["From your plan."]);
    await c.advanceTo("2099-11-25T10:00");

    expect(await c.received()).toEqual([]);
    expect(box.destroyCalls).toEqual([]);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
  });
});

describe("a box row written by the code before reclaim reasons", () => {
  test("a box the old code left failed is removed on the next drain, freeing its slot, and its person told once", async () => {
    const box = fakeBox();
    const ledger = memoryLedger();
    const c = await devChat("rex", { model: scripted([chat("Hi.")]), at: "2099-11-04T10:00", box: box.deps, ledger });
    await c.say("hello");
    await c.received();
    const name = await box.nameOf("rex");
    box.created.add(name);
    await ledger.claimBox({ agent: "p:dev:rex" as AgentKey, name, host: "fly", at: local("2099-11-04T10:00"), max: 10 });
    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName("p:dev:rex"));
    await runInDurableObject(stub, (_agent, state) => {
      const sql = state.storage.sql;
      const created = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE box ("));
      sql.exec("DROP TABLE box");
      sql.exec(MIGRATIONS[created]);
      sql.exec(MIGRATIONS[created + 1]);
      sql.exec(
        "INSERT INTO box (one, name, host, url, state, state_at, error, attempts) VALUES (1, ?, 'fly', ?, 'failed', ?, 'no answer', 10)",
        name,
        `https://${name}.box.test`,
        local("2099-11-04T09:00"),
      );
      sql.exec(MIGRATIONS[MIGRATIONS.findIndex((m) => m.includes("CASE state WHEN 'failed' THEN 'reclaiming'"))]);
      sql.exec("ALTER TABLE box ADD COLUMN volume TEXT");
    });

    await c.alarm();

    expect(await c.received()).toEqual([say("setup_failed")]);
    expect(box.destroyCalls).toEqual([name]);
    expect(ledger.boxes.has("p:dev:rex")).toBe(false);
    expect((await c.snapshot()).box).toBeNull();
  });
});

describe("log rows queued by the code before the box path", () => {
  test("a queued model call row without a backend ships as backend 'api'", async () => {
    const c = await devChat("old", { model: scripted([chat("Hi.")]), at: "2099-11-04T10:00" });
    await c.say("hello");
    const stub = testEnv.AGENT.get(testEnv.AGENT.idFromName("p:dev:old"));
    await runInDurableObject(stub, (_agent, state) => {
      const { backend: _, ...old } = { ...c.logs("model_call")[0], id: "queued-before-box" };
      state.storage.sql.exec("INSERT INTO log_outbox (id, stream, row, created_at) VALUES (?, 'model_call', ?, ?)", `model_call:${old.id}`, JSON.stringify(old), 0);
    });

    await c.alarm();

    expect(c.logs("model_call").map((r) => [r.id, r.backend])).toContainEqual(["queued-before-box", "api"]);
  });
});

const quietCheckin = () => turn({ actions: [quiet()] });

describe("reclaiming a box nobody signed in to", () => {
  test("48 hours after the first link the box is destroyed, its slot freed, its row forgotten, and /claude starts over", async () => {
    const box = fakeBox();
    const ledger = memoryLedger();
    const c = await devChat("lea", { model: scripted([quietCheckin(), quietCheckin()]), at: "2099-11-04T10:00", box: box.deps, ledger });
    const name = await box.nameOf("lea");
    await c.say("/claude");
    await c.received();

    await c.advanceTo("2099-11-05T12:00");
    await c.say("/claude");
    expect(await c.received()).toHaveLength(1);
    await c.advanceTo("2099-11-06T09:59");
    expect((await c.snapshot()).box?.state).toBe("signed_out");
    expect(box.destroyCalls).toEqual([]);

    await c.advanceTo("2099-11-06T10:00");

    expect(await c.received()).toEqual([say("reclaimed")]);
    expect(box.destroyCalls).toEqual([name]);
    expect(box.created.has(name)).toBe(false);
    expect(ledger.boxes.has("p:dev:lea")).toBe(false);
    expect((await c.snapshot()).box).toBeNull();

    await c.say("/claude");
    const [again, link] = await c.received();
    expect(again).toBe(say("setting_up"));
    expect((await linkIn(link, "lea", local("2099-11-06T10:00"))).valid).toBe(true);
    expect(ledger.boxes.has("p:dev:lea")).toBe(true);
  });

  test("a box that was ever signed in is never destroyed on its own", async () => {
    const box = fakeBox({ signedIn: true });
    const model = scripted([chat("From the API."), quietCheckin(), quietCheckin(), quietCheckin()]);
    const c = await devChat("max", { model, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    box.signedIn = false;
    box.replies.push({ kind: "signed_out" });
    await c.say("hello");
    await c.received();

    await c.advanceTo("2099-11-07T12:00");

    expect(box.destroyCalls).toEqual([]);
    expect((await c.snapshot()).box?.state).toBe("signed_out");
    expect(await c.received()).toEqual([]);
  });

  test("a box found signed in at reclaim time is kept and connected", async () => {
    const box = fakeBox();
    const c = await devChat("ned", { model: scripted([quietCheckin(), quietCheckin()]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();
    await c.advanceTo("2099-11-06T09:00");

    box.signedIn = true;
    await c.advanceTo("2099-11-06T10:00");

    expect(await c.received()).toEqual([say("connected")]);
    expect(box.destroyCalls).toEqual([]);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
  });

  test("a crash between the host's destroy and the row update converges on the retry with one message, without probing again", async () => {
    const box = fakeBox({ destroy: ["die"] });
    const ledger = memoryLedger();
    const c = await devChat("ola", { model: scripted([quietCheckin(), quietCheckin()]), at: "2099-11-04T10:00", box: box.deps, ledger });
    const name = await box.nameOf("ola");
    await c.say("/claude");
    await c.received();

    await c.advanceTo("2099-11-06T10:00");
    expect((await c.snapshot()).box?.state).toBe("reclaiming");
    expect(ledger.boxes.has("p:dev:ola")).toBe(true);
    await c.say("/claude");
    expect(await c.received()).toEqual([say("resetting")]);
    const probes = box.healthCalls.length;

    await c.advanceTo("2099-11-06T10:05");

    expect(box.healthCalls).toHaveLength(probes);
    expect(await c.received()).toEqual([say("reclaimed")]);
    expect(box.destroyCalls).toEqual([name, name]);
    expect(ledger.boxes.has("p:dev:ola")).toBe(false);
    expect((await c.snapshot()).box).toBeNull();
  });

  test("a link sent near the end moves the reclaim past that link's expiry", async () => {
    const box = fakeBox();
    const c = await devChat("pam", { model: scripted([quietCheckin(), quietCheckin()]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    await c.advanceTo("2099-11-06T09:50");
    await c.say("/claude");
    expect(await c.received()).toHaveLength(1);
    await c.advanceTo("2099-11-06T10:21");
    expect(box.destroyCalls).toEqual([]);

    await c.advanceTo("2099-11-06T10:23");
    expect(box.destroyCalls).toEqual([await box.nameOf("pam")]);
    expect(await c.received()).toEqual([say("reclaimed")]);
  });

  test("a box that doesn't answer at reclaim time is never destroyed, and is looked at again later", async () => {
    const box = fakeBox();
    const c = await devChat("quy", { model: scripted([quietCheckin(), quietCheckin()]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    box.reachable = false;
    await c.advanceTo("2099-11-06T11:00");
    expect(box.destroyCalls).toEqual([]);
    expect((await c.snapshot()).box?.state).toBe("signed_out");

    box.reachable = true;
    await c.advanceTo("2099-11-06T11:10");
    expect(box.destroyCalls).toEqual([await box.nameOf("quy")]);
    expect(await c.received()).toEqual([say("reclaimed")]);
  });

  test("a destroy that fails every time keeps retrying with backoff and tells the person nothing", async () => {
    const box = fakeBox({ destroy: Array(200).fill("fail") });
    const c = await devChat("pia", { model: scripted([quietCheckin(), quietCheckin(), quietCheckin()]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    await c.advanceTo("2099-11-07T10:00");

    expect(await c.received()).toEqual([]);
    expect((await c.snapshot()).box?.state).toBe("reclaiming");
    expect(box.destroyCalls.length).toBeGreaterThan(20);
    expect(box.destroyCalls.length).toBeLessThan(40);
  });
});
