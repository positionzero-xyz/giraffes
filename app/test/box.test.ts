import { env as testEnv, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { boxClient } from "../src/box/client";
import { flyHost, machineConfig, type FlyConfig } from "../src/box/fly";
import type { Fetch } from "../src/box/host";
import { BOX, boxMessage, type BoxSay } from "../src/box/machine";
import { boxName, boxToken, signinTicket, type BoxName, type BoxToken } from "../src/box/names";
import { MIGRATIONS } from "../src/agent/schema";
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
      return Response.json({ apps: mine.map(([name, owner]) => ({ name, organization: { slug: owner } })) });
    }
    if (!app && method === "POST") {
      if (apps.has(body.app_name)) return Response.json({ error: "Validation failed: Name has already been taken", status: "name_taken" }, { status: 422 });
      apps.set(body.app_name, body.org_slug);
      return Response.json({ id: `app${++n}`, created_at: 1 }, { status: 201 });
    }
    if (!app || !apps.has(app)) return Response.json({ error: "not found" }, { status: 404 });
    if (!sub && method === "GET") return Response.json({ name: app, organization: { slug: apps.get(app) } });
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
  return { fetch, apps, ips, volumes, machines, requests, failures, org };
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
    expect(box.parses[0].agent?.tools).toEqual(["schedule_wakeup", "cancel_wakeup", "remember", "set_locale", "task"]);
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
  });

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

  test("a provisioning failure that can't be retried is removed at once, and the next /claude starts over", async () => {
    const box = fakeBox({ host: [{ retryable: false, detail: "POST /apps: 400" }] });
    const ledger = memoryLedger();
    const c = await devChat("di", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps, ledger });

    await c.say("/claude");
    expect(await c.received()).toEqual([say("setting_up"), say("setup_failed")]);
    expect(box.destroyCalls).toEqual([await box.nameOf("di")]);
    expect(ledger.boxes.has("p:dev:di")).toBe(false);

    await c.say("/claude");
    const [again, link] = await c.received();
    expect(again).toBe(say("setting_up"));
    expect((await linkIn(link, "di", local("2099-11-04T10:00"))).valid).toBe(true);
    expect(ledger.boxes.has("p:dev:di")).toBe(true);
  });

  test("/claude while a failed box is still being removed says to try again in a few minutes", async () => {
    const box = fakeBox({ host: [{ retryable: false, detail: "POST /apps: 400" }], destroy: ["fail"] });
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
          tools: ["schedule_wakeup", "cancel_wakeup", "remember", "set_locale", "task"],
          session: null,
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

  test("an unavailable box backs the turn off, never spends anyone's money, skips the box for 5 minutes, and then tries it again", async () => {
    const box = fakeBox({ signedIn: true });
    const model = scripted([]);
    const c = await devChat("hal", { model, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();

    box.replies.push({ kind: "status", status: 503 });
    await c.say("hello");
    await c.advanceTo("2099-11-04T10:04");
    expect(await c.received()).toEqual([NOTICE.failed]);
    expect((await c.snapshot()).box?.state).toBe("signed_in");
    expect(box.parses).toHaveLength(1);

    c.clock.set(local("2099-11-04T10:05"));
    box.replies.push({ kind: "reply", step: chat("Back on your plan.") });
    await c.say("later");
    expect(await c.received()).toEqual(["Back on your plan."]);
    expect(c.logs("model_call").map((r) => [r.backend, r.status])).toEqual([
      ["box", "unavailable"],
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

    box.replies.push({ kind: "status", status: 503 });
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
      ["key", "settled"],
    ]);
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
    box.replies.push({ kind: "reply", step: quietCheckin() });

    await c.advanceTo("2099-11-05T11:00");
    await c.say("hello");
    await c.say("still there?");
    expect(await c.received()).toEqual([retiring("19 November 2099"), NOTICE.lapsed]);

    await c.advanceTo("2099-11-19T10:59");
    expect(box.destroyCalls).toEqual([]);
    await c.advanceTo("2099-11-19T11:00");

    expect(await c.received()).toEqual([say("retired")]);
    expect(box.destroyCalls).toEqual([await box.nameOf("uma")]);
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
