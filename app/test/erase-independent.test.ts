import { env, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { flyHost } from "../src/box/fly";
import type { Fetch, FlyDiskRetirement } from "../src/box/host";
import type { BoxName } from "../src/box/names";
import { stripeApi, type CheckoutId } from "../src/billing/stripe";
import type { SubscriptionId } from "../src/billing/plan";
import type { EpochMs } from "../src/domain";
import { billingOn, devChat, fakeBox } from "./testkit";

const cfg = { apiToken: "offline", org: "fixture-org", image: "offline", region: "sin", volumeGb: 1, appPrefix: "gbox-", secret: "offline" };
const appPath = (name: string) => "/v1/apps/" + name;
const volumePath = (name: string) => appPath(name) + "/volumes";
const owned = () => Response.json({ organization: { slug: cfg.org } });
const empty = (status: number) => new Response(null, { status });
const vol = (id: string, machine: string | null) => ({ id, attached_machine_id: machine, state: "created" });

async function draft(user: string, fetch: Fetch, opts: { health?: () => boolean; wipe?: () => boolean } = {}) {
  const fake = fakeBox({ onlyFor: user });
  const host = flyHost(cfg, fetch);
  const health = vi.fn(async () => opts.health?.() === false
    ? { kind: "unavailable" as const, detail: "fixture offline" }
    : { kind: "up" as const, signedIn: false, box: "fixture-incarnation" });
  const erase = vi.fn<typeof fake.deps.client.erase>(async (_url, _token, req) => {
    if (typeof req !== "object" || !("scope" in req) || req.scope !== "account") throw Error("expected account wipe");
    if (opts.wipe?.() === false) return { kind: "pending", detail: "fixture offline" };
    return { kind: "erased", scope: "account", box: req.box, floor: req.epoch };
  });
  const chat = await devChat(user, { model: null, at: "2099-11-04T08:00", box: { ...fake.deps, host, client: { ...fake.deps.client, health, erase } } });
  const stub = env.AGENT.get(env.AGENT.idFromName(chat.agent));
  return { chat, stub, name: await host.nameFor(chat.agent), health, erase };
}

async function register(person: Awaited<ReturnType<typeof draft>>, name = person.name) {
  await person.chat.say("hello");
  await env.LEDGER.prepare("INSERT INTO boxes (agent_key, name, host, created_at) VALUES (?, ?, 'fly', 1)").bind(person.chat.agent, name).run();
  await person.chat.say("/erase");
  const button = person.chat.channel.delivered.at(-1)?.button;
  if (!button) throw new Error("erasure button missing");
  return button.data;
}

const jobOf = (person: Awaited<ReturnType<typeof draft>>) =>
  runInDurableObject(person.stub, async (_, { storage }) => ({ job: storage.kv.get<Record<string, unknown>>("account:erase"), alarm: await storage.getAlarm() }));

test("only the attached volume is selected among two; the extra holds all deletion", async () => {
  const name = "gbox-select" as BoxName;
  const mutations: string[] = [];
  const host = flyHost(cfg, async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method !== "GET") { mutations.push(path); return empty(204); }
    return path === appPath(name) ? owned() : Response.json([vol("stray", null), vol("known", "machine")]);
  });
  const result = await host.retirementTarget(name);
  expect(result).toEqual({ ok: true, target: { disk: "known", machine: "machine", disks: ["known"] } });
  if (!result.ok) throw Error("target lookup");
  expect(await host.retireWipedDisk(name, result.target)).toMatchObject({ ok: false, retryable: true });
  expect(mutations).toEqual([]);
});

test("legacy disk and machine without a disks field retire the known live volume only", async () => {
  const name = "gbox-legacy" as BoxName;
  let live = [vol("known", "machine")];
  const calls: string[] = [];
  const host = flyHost(cfg, async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === "DELETE") {
      calls.push(path);
      if (path === volumePath(name) + "/known") live = [];
      return empty(204);
    }
    return path === appPath(name) ? owned() : Response.json(live);
  });
  expect(await host.retireWipedDisk(name, { disk: "known", machine: "machine" } as FlyDiskRetirement)).toEqual({ ok: true });
  expect(calls).toEqual([appPath(name) + "/machines/machine", volumePath(name) + "/known"]);
});

test.each(["health", "wipe"])("disappearance at %s and early duplicate alarms advance only when due", async (phase) => {
  let name: BoxName;
  let vanished = false;
  let reads = 0;
  const person = await draft("independent-relocate-" + phase, async (url, init) => {
    expect(init?.method).toBe("GET");
    reads++;
    const path = new URL(url).pathname;
    if (path === appPath(name)) return vanished ? empty(404) : owned();
    if (path === volumePath(name)) return Response.json([vol("known", "machine")]);
    if (path === "/v1/apps") return Response.json({ apps: [] });
    throw Error(path);
  }, { [phase]: () => { vanished = true; return false; } });
  name = person.name;
  await person.chat.tap(await register(person));
  const nextAt = person.chat.clock.now() + 60_000;
  expect(reads).toBe(2);
  expect(await jobOf(person)).toMatchObject({ job: { box: { kind: "relocate" }, nextAt }, alarm: nextAt });
  person.chat.clock.set((nextAt - 1) as EpochMs);
  await Promise.all([person.chat.alarm(), person.chat.alarm(), person.chat.alarm()]);
  expect(reads).toBe(2);
  expect(person.health).toHaveBeenCalledTimes(1);
  expect(await jobOf(person)).toMatchObject({ job: { box: { kind: "relocate" }, nextAt }, alarm: nextAt });
  person.chat.clock.set(nextAt as EpochMs);
  await person.chat.settle();
  expect(reads).toBe(4);
  expect(person.erase).toHaveBeenCalledTimes(phase === "wipe" ? 1 : 0);
  expect(person.chat.channel.delivered.at(-1)?.text).toMatch(/removed earlier.*verify a disk wipe/);
});

test("retirement volume-list 404 stays at two reads per due alarm", async () => {
  let reads = 0;
  let name: BoxName;
  const person = await draft("independent-list404", async (url, init) => {
    expect(init?.method).toBe("GET");
    const path = new URL(url).pathname;
    if (path === appPath(name)) return owned();
    if (path === volumePath(name)) {
      reads++;
      if (reads > 8) throw Error("unbounded reads");
      return reads % 2 ? Response.json([]) : empty(404);
    }
    throw Error(path);
  });
  name = person.name;
  await person.chat.tap(await register(person));
  const nextAt = person.chat.clock.now() + 60_000;
  expect(reads).toBe(2);
  await person.chat.alarm();
  expect(reads).toBe(2);
  person.chat.clock.set(nextAt as EpochMs);
  await person.chat.settle();
  // One empty list with a live app now holds before a second list call.
  expect(reads).toBe(3);
});

test("a resume from the prior revision target cannot promote its unwiped extra to known", async () => {
  let name: BoxName;
  let live = [vol("known", "machine"), vol("unwiped-extra", null)];
  const mutations: string[] = [];
  const person = await draft("independent-upgrade", async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === "DELETE") {
      mutations.push(path);
      live = live.filter((v) => path !== volumePath(name) + "/" + v.id);
      return empty(204);
    }
    return path === appPath(name) ? owned() : Response.json(live);
  });
  name = person.name;
  await person.chat.tap(await register(person));
  expect(person.erase).toHaveBeenCalledTimes(1);
  const held = await jobOf(person);
  expect(held.job).toMatchObject({ box: { kind: "remove-volume", target: { disks: ["known"] } } });
  await runInDurableObject(person.stub, (_, { storage }) => {
    const current = storage.kv.get<{ box: { target: FlyDiskRetirement } }>("account:erase")!;
    storage.kv.put("account:erase", { ...current, box: { ...current.box, target: { disk: null, machine: null, disks: ["known", "unwiped-extra"] } } });
  });
  person.chat.clock.set(held.alarm as EpochMs);
  await person.chat.settle();
  expect(mutations).toEqual([]);
});

test("an unknown volume remains when it appears after the last empty listing", async () => {
  const name = "gbox-final-race" as BoxName;
  let live: ReturnType<typeof vol>[] = [];
  let appExists = true;
  const mutations: string[] = [];
  const host = flyHost(cfg, async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === "DELETE" && path === appPath(name)) {
      expect(new URL(url).searchParams.get("force")).toBe("true");
      mutations.push(...live.map((disk) => disk.id));
      live = [];
      appExists = false;
      return empty(204);
    }
    if (path === appPath(name)) return appExists ? owned() : empty(404);
    if (path === "/v1/apps") return Response.json({ apps: [] });
    if (path === volumePath(name) && appExists) {
      const snapshot = Response.json(live);
      live = [vol("arrived-after-list", null)];
      return snapshot;
    }
    if (path === volumePath(name)) return empty(404);
    throw Error(path);
  });
  const result = await host.removeRetiredApp(name);
  expect({ result, mutations }).toEqual({ result: expect.objectContaining({ ok: false }), mutations: [] });
});

test("an erase confirmation cannot be replayed into another account with its own pending confirmation", async () => {
  const fetch = vi.fn<Fetch>(async () => { throw Error("unexpected Fly call"); });
  const a = await draft("independent-account-a", fetch);
  const b = await draft("independent-account-b", fetch);
  const tapA = await register(a);
  await register(b);
  await b.chat.tap(tapA);
  expect(fetch).not.toHaveBeenCalled();
  expect((await jobOf(b)).job).toBeUndefined();
  expect(await env.LEDGER.prepare("SELECT name FROM boxes WHERE agent_key = ?").bind(b.chat.agent).first()).toEqual({ name: b.name });
});

test("Stripe ownership mismatches reject subscription and Checkout before mutation", async () => {
  const stripe = billingOn().config;
  const fakeFetch = vi.fn<Fetch>(async (url) => new URL(url).pathname.includes("/subscriptions/")
    ? Response.json({ id: "sub_other", status: "active", metadata: { agent_key: "p:dev:other" } })
    : Response.json({ id: "cs_other", status: "open", client_reference_id: "p:dev:other", metadata: {}, subscription: null }));
  const api = stripeApi(stripe.stripe, stripe.rules, fakeFetch);
  const { chat } = await draft("independent-stripe-owner", async () => { throw Error("unexpected Fly call"); });
  expect(await api.closeCheckout("cs_other" as CheckoutId, chat.agent)).toMatchObject({ ok: false });
  expect(await api.closeSubscription("sub_other" as SubscriptionId, chat.agent)).toMatchObject({ ok: false });
  expect(fakeFetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
});


test("new live volume after known disk retirement holds the app", async () => {
  const name = "gbox-post-retirement" as BoxName;
  let live = [vol("known", "machine")];
  const requests: { method: string | undefined; path: string }[] = [];
  const host = flyHost(cfg, async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ method: init?.method, path });
    if (init?.method === "DELETE") {
      if (path === volumePath(name) + "/known") live = [];
      return empty(204);
    }
    return path === appPath(name) ? owned() : Response.json(live);
  });
  const target = await host.retirementTarget(name);
  if (!target.ok) throw Error("target lookup");
  expect(await host.retireWipedDisk(name, target.target)).toEqual({ ok: true });
  live = [vol("late-extra", null)];
  const before = requests.length;
  expect(await host.removeRetiredApp(name)).toMatchObject({ ok: false, retryable: true });
  expect(requests.slice(before)).toEqual([
    { method: "GET", path: appPath(name) },
    { method: "GET", path: volumePath(name) },
  ]);
});

test("relocation after a list 404 does not authorize a replacement volume", async () => {
  let name: BoxName;
  let reads = 0;
  let appExists = true;
  let live = [vol("confirmed", "machine")];
  const mutations: string[] = [];
  const person = await draft("independent-replacement", async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === "DELETE") {
      mutations.push(path);
      if (path === appPath(name)) appExists = false;
      if (path === volumePath(name) + "/replacement") live = [];
      return empty(204);
    }
    if (path === appPath(name)) return appExists ? owned() : empty(404);
    if (path === "/v1/apps") return Response.json({ apps: [] });
    if (path === volumePath(name)) {
      if (!appExists) return empty(404);
      if (++reads === 2) {
        live = [vol("replacement", null)];
        return empty(404);
      }
      return Response.json(live);
    }
    throw Error(path);
  });
  name = person.name;
  await person.chat.tap(await register(person));
  const held = await jobOf(person);
  expect(held.job).toMatchObject({ box: { kind: "relocate" } });
  expect(person.erase).toHaveBeenCalledTimes(1);
  expect(mutations).toEqual([]);
  person.chat.clock.set(held.alarm as EpochMs);
  await person.chat.settle();
  expect(person.erase).toHaveBeenCalledTimes(1);
  expect(mutations).toEqual([]);
});

test("legacy erasures that stay in relocation report a bounded, content-free diagnostic", async () => {
  let name: BoxName;
  const person = await draft("independent-relocate-diagnostic", async (url, init) => {
    expect(init?.method).toBe("GET");
    const path = new URL(url).pathname;
    if (path === appPath(name)) return owned();
    if (path === volumePath(name)) return Response.json([vol("known", "machine")]);
    throw Error(path);
  }, { health: () => false });
  name = person.name;
  await person.chat.tap(await register(person));
  const held = await jobOf(person);
  await runInDurableObject(person.stub, (_, { storage }) => {
    const { startedAt, diagnosedAt, ...current } = storage.kv.get<Record<string, unknown>>("account:erase")!;
    storage.kv.put("account:erase", current);
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    person.chat.clock.set(held.alarm as EpochMs);
    await person.chat.settle();
    person.chat.clock.set((person.chat.clock.now() + 60_000) as EpochMs);
    await person.chat.settle();
    expect(warn.mock.calls.map(([code]) => code)).toEqual([{ code: "erase_box_hold", value: 24 }]);
  } finally { warn.mockRestore(); }
});


test("valid account A confirmation mutates only A's Fly resources and preserves account B", async () => {
  const apps = new Map<BoxName, { disk: string; machine: string; live: boolean; exists: boolean }>();
  const mutations: string[] = [];
  const fly: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/v1/apps") {
      return Response.json({ apps: [...apps].filter(([, app]) => app.exists).map(([name]) => ({ name })) });
    }
    const name = path.split("/")[3] as BoxName;
    const entry = apps.get(name);
    if (!entry) throw Error("unknown app fixture");
    if (init?.method === "DELETE") {
      mutations.push(path);
      if (path === appPath(name)) entry.exists = false;
      if (path === volumePath(name) + "/" + entry.disk) entry.live = false;
      return empty(204);
    }
    if (path === appPath(name)) return entry.exists ? owned() : empty(404);
    if (path === volumePath(name)) return entry.exists
      ? Response.json(entry.live ? [vol(entry.disk, entry.machine)] : [])
      : empty(404);
    throw Error(path);
  };
  const a = await draft("independent-valid-account-a", fly);
  const b = await draft("independent-valid-account-b", fly);
  apps.set(a.name, { disk: "a-disk", machine: "a-machine", live: true, exists: true });
  apps.set(b.name, { disk: "b-disk", machine: "b-machine", live: true, exists: true });
  const tapA = await register(a);
  await register(b);
  await a.chat.tap(tapA);
  expect(a.erase).toHaveBeenCalledTimes(1);
  expect(a.erase.mock.calls[0][0]).toBe("https://" + a.name + ".fly.dev");
  expect(mutations).toEqual([appPath(a.name) + "/machines/a-machine", volumePath(a.name) + "/a-disk", appPath(a.name)]);
  expect(a.chat.channel.delivered.at(-1)?.text).toMatch(/deleted your live Giraffe data/);
  expect(b.erase).not.toHaveBeenCalled();
  expect(apps.get(b.name)).toMatchObject({ live: true, exists: true });
  expect((await jobOf(b)).job).toBeUndefined();
  expect(await env.LEDGER.prepare("SELECT name FROM boxes WHERE agent_key = ?").bind(b.chat.agent).first()).toEqual({ name: b.name });
});


