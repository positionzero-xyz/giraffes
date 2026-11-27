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


async function advance(person: Awaited<ReturnType<typeof draft>>) {
  const { alarm } = await jobOf(person);
  if (alarm === null) throw Error("expected persisted retry alarm");
  person.chat.clock.set(alarm as EpochMs);
  await person.chat.settle();
}

const completion = (person: Awaited<ReturnType<typeof draft>>) =>
  person.chat.channel.delivered.map(({ text }) => text).filter((text) => /deleted your live Giraffe data/.test(text));

async function reservations(name: BoxName) {
  return (await env.LEDGER.prepare("SELECT COUNT(*) AS count FROM boxes WHERE name = ?").bind(name).first<{ count: number }>())?.count;
}


test.each(["still-owned", "still-listed", "list-unreadable", "confirmed-absent"] as const)(
  "a volume 404 after a pending wipe follows the independent app evidence (%s)",
  async (visibility) => {
    let name: BoxName;
    let relocating = false;
    let appReads = 0;
    const calls: string[] = [];
    const person = await draft("focused-404-" + visibility, async (url, init) => {
      const { pathname } = new URL(url);
      calls.push(init?.method + " " + pathname);
      if (init?.method !== "GET") return empty(409);
      if (pathname === appPath(name)) {
        return relocating && ++appReads > 1 && visibility !== "still-owned" ? empty(404) : owned();
      }
      if (pathname === volumePath(name)) {
        return relocating ? empty(404) : Response.json([vol("original", "original-machine")]);
      }
      if (pathname === "/v1/apps") {
        if (visibility === "list-unreadable") return empty(403);
        return Response.json({ apps: visibility === "still-listed" ? [{ name }] : [] });
      }
      throw Error(pathname);
    }, { wipe: () => false });
    name = person.name;
    await person.chat.tap(await register(person));
    expect(person.erase).toHaveBeenCalledTimes(1);
    expect(await jobOf(person)).toMatchObject({ job: { kind: "cleaning", box: { kind: "relocate", resume: "wipe-fly" } } });
    calls.length = 0;
    relocating = true;
    await advance(person);
    const gone = visibility === "confirmed-absent";
    expect.soft(calls).toEqual([
      "GET " + appPath(name), "GET " + volumePath(name), "GET " + appPath(name),
      ...(visibility === "still-owned" ? [] : ["GET /v1/apps"]),
    ]);
    expect.soft(person.erase).toHaveBeenCalledTimes(1);
    expect.soft(await reservations(name)).toBe(gone ? 0 : 1);
    if (gone) {
      expect(completion(person)).toEqual([expect.stringContaining("could not verify a disk wipe")]);
    } else {
      expect.soft(completion(person)).toEqual([]);
      expect(await jobOf(person)).toMatchObject({ job: { kind: "cleaning", box: { kind: "relocate" } } });
    }
  },
);

test.each(["empty", "replacement-after-empty-read"] as const)(
  "pre-wipe disappearance keeps the reservation while the app remains live (%s)",
  async (mode) => {
    let name: BoxName;
    let appExists = true;
    let firstEmpty = false;
    let volumes = [vol("original", "original-machine")];
    const writes: string[] = [];
    const person = await draft("focused-prewipe-" + mode, async (url, init) => {
      const { pathname, search } = new URL(url);
      if (init?.method === "DELETE") {
        writes.push(pathname + search);
        if (pathname !== appPath(name) || volumes.length > 0) return empty(409);
        appExists = false;
        return empty(204);
      }
      if (pathname === appPath(name)) return appExists ? owned() : empty(404);
      if (pathname === volumePath(name)) {
        if (!appExists) return empty(404);
        const snapshot = Response.json(volumes);
        if (firstEmpty && mode === "replacement-after-empty-read") volumes = [vol("replacement", "replacement-machine")];
        firstEmpty = false;
        return snapshot;
      }
      if (pathname === "/v1/apps") return Response.json({ apps: appExists ? [{ name }] : [] });
      throw Error(pathname);
    }, { wipe: () => false });
    name = person.name;
    await person.chat.tap(await register(person));
    expect(await jobOf(person)).toMatchObject({ job: { kind: "cleaning", box: { kind: "relocate", resume: "wipe-fly" } } });
    expect(person.erase).toHaveBeenCalledTimes(1);
    expect(await reservations(name)).toBe(1);
    volumes = [];
    firstEmpty = true;
    await advance(person);
    expect.soft(person.erase).toHaveBeenCalledTimes(1);
    expect.soft(writes.every((path) => path === appPath(name))).toBe(true);
    const receipts = completion(person);
    expect.soft(receipts.every((receipt) => receipt.includes("could not verify a disk wipe"))).toBe(true);
    expect.soft(await reservations(name)).toBe(appExists ? 1 : 0);
    if (appExists) {
      expect.soft(receipts).toEqual([]);
      expect(await jobOf(person)).toMatchObject({ job: { kind: "cleaning" }, alarm: expect.any(Number) });
    } else {
      expect(receipts).toHaveLength(1);
    }
  },
);

test.each(["before-wipe-retry", "after-wipe-ack"] as const)(
  "a live known disk reassigned to a different machine holds before deletion (%s)",
  async (phase) => {
    let name: BoxName;
    let swapped = false;
    const writes: string[] = [];
    const person = await draft("focused-reassigned-" + phase, async (url, init) => {
      const { pathname, search } = new URL(url);
      if (init?.method === "DELETE") {
        writes.push(pathname + search);
        return empty(409);
      }
      if (pathname === appPath(name)) return owned();
      if (pathname === volumePath(name)) return Response.json([vol("known", swapped ? "new-machine" : "old-machine")]);
      throw Error(pathname);
    }, {
      wipe: () => {
        if (phase === "before-wipe-retry") return false;
        swapped = true;
        return true;
      },
    });
    name = person.name;
    await person.chat.tap(await register(person));
    if (phase === "before-wipe-retry") {
      expect(await jobOf(person)).toMatchObject({ job: { box: { kind: "relocate", resume: "wipe-fly" } } });
      swapped = true;
      await advance(person);
    }
    expect.soft(person.erase).toHaveBeenCalledTimes(1);
    expect.soft(writes).toEqual([]);
    expect.soft(completion(person)).toEqual([]);
    expect.soft(await reservations(name)).toBe(1);
    expect(await jobOf(person)).toMatchObject({ job: { kind: "cleaning" }, alarm: expect.any(Number) });
  },
);

test.each(["wiped", "no-wipe"] as const)(
  "a destroying volume row cannot authorize deletion of its new machine (%s target)",
  async (evidence) => {
    const name = "gbox-fixture" as BoxName;
    const target = evidence === "wiped"
      ? { disk: "known", machine: "old-machine", disks: ["known"] }
      : { disk: null, machine: null, disks: ["known"] };
    const writes: string[] = [];
    const host = flyHost(cfg, async (url, init) => {
      const { pathname, search } = new URL(url);
      if (init?.method === "DELETE") {
        writes.push(pathname + search);
        return empty(204);
      }
      if (pathname === appPath(name)) return owned();
      if (pathname === volumePath(name)) {
        return Response.json([{ id: "known", state: "destroying", attached_machine_id: "new-machine" }]);
      }
      throw Error(pathname);
    });
    await host.retireWipedDisk(name, target);
    expect(writes).not.toContain(appPath(name) + "/machines/new-machine?force=true");
  },
);

test("an acknowledged wipe on the saved attachment permits a normal completion receipt", async () => {
  let name: BoxName;
  let appExists = true;
  let volumes = [vol("known", "old-machine")];
  const writes: string[] = [];
  const person = await draft("focused-ack-control", async (url, init) => {
    const { pathname, search } = new URL(url);
    if (init?.method === "DELETE") {
      writes.push(pathname + search);
      if (pathname === appPath(name) + "/machines/old-machine") return empty(204);
      if (pathname === volumePath(name) + "/known") volumes = [];
      else if (pathname === appPath(name) && volumes.length === 0) appExists = false;
      else return empty(409);
      return empty(204);
    }
    if (pathname === appPath(name)) return appExists ? owned() : empty(404);
    if (pathname === volumePath(name)) return appExists ? Response.json(volumes) : empty(404);
    if (pathname === "/v1/apps") return Response.json({ apps: appExists ? [{ name }] : [] });
    throw Error(pathname);
  });
  name = person.name;
  await person.chat.tap(await register(person));
  expect(person.erase).toHaveBeenCalledTimes(1);
  expect(writes).toEqual([appPath(name) + "/machines/old-machine?force=true", volumePath(name) + "/known", appPath(name)]);
  expect(completion(person)).toHaveLength(1);
  expect(completion(person)[0]).not.toContain("could not verify a disk wipe");
  expect(await reservations(name)).toBe(0);
});



test.each(["other-incarnation", "low-floor"] as const)(
  "an invalid wipe acknowledgment never upgrades a subsequent app disappearance (%s)",
  async (mismatch) => {
    let name: BoxName;
    let appExists = true;
    const person = await draft("focused-invalid-ack-" + mismatch, async (url, init) => {
      const { pathname } = new URL(url);
      if (init?.method !== "GET") throw Error("unexpected provider mutation");
      if (pathname === appPath(name)) return appExists ? owned() : empty(404);
      if (pathname === volumePath(name)) return Response.json([vol("original", "old-machine")]);
      if (pathname === "/v1/apps") return Response.json({ apps: appExists ? [{ name }] : [] });
      throw Error(pathname);
    });
    name = person.name;
    person.erase.mockImplementationOnce(async (_url, _token, req) => {
      if (typeof req !== "object" || !("scope" in req) || req.scope !== "account") throw Error("expected account wipe");
      return {
        kind: "erased", scope: "account",
        box: mismatch === "other-incarnation" ? "unrelated-incarnation" : req.box,
        floor: mismatch === "low-floor" ? req.epoch - 1 : req.epoch,
      };
    });
    await person.chat.tap(await register(person));
    expect(await jobOf(person)).toMatchObject({ job: { box: { kind: "relocate", resume: "wipe-fly" } } });
    expect(completion(person)).toEqual([]);
    appExists = false;
    await advance(person);
    expect(person.erase).toHaveBeenCalledTimes(1);
    expect(completion(person)).toEqual([expect.stringContaining("could not verify a disk wipe")]);
  },
);

test("an app Fly still lists after its delete holds the erasure on every retry, then completes once the list drops it", async () => {
  let name: BoxName;
  let appExists = true;
  let listed = true;
  let volumes = [vol("known", "old-machine")];
  const person = await draft("focused-still-listed-after-delete", async (url, init) => {
    const { pathname } = new URL(url);
    if (init?.method === "DELETE") {
      if (pathname === appPath(name) + "/machines/old-machine") return empty(204);
      if (pathname === volumePath(name) + "/known") volumes = [];
      else if (pathname === appPath(name) && volumes.length === 0) appExists = false;
      else return empty(409);
      return empty(204);
    }
    if (pathname === appPath(name)) return appExists ? owned() : empty(404);
    if (pathname === volumePath(name)) return appExists ? Response.json(volumes) : empty(404);
    if (pathname === "/v1/apps") return Response.json({ apps: listed ? [{ name }] : [] });
    throw Error(pathname);
  });
  name = person.name;
  await person.chat.tap(await register(person));
  expect(person.erase).toHaveBeenCalledTimes(1);
  for (let retry = 0; retry < 3; retry++) {
    expect(appExists).toBe(false);
    expect(completion(person)).toEqual([]);
    expect(await reservations(name)).toBe(1);
    expect(await jobOf(person)).toMatchObject({ job: { kind: "cleaning", box: { kind: "remove-app" } } });
    await advance(person);
  }
  listed = false;
  await advance(person);
  expect(completion(person)).toHaveLength(1);
  expect(completion(person)[0]).not.toContain("could not verify a disk wipe");
  expect(await reservations(name)).toBe(0);
});

test("detached-volume cleanup must distinguish deletion from an acknowledged wipe", async () => {
  let name: BoxName;
  let appExists = true;
  let volumes = [vol("detached", null)];
  const person = await draft("focused-detached-no-ack", async (url, init) => {
    const { pathname } = new URL(url);
    if (init?.method === "DELETE") {
      if (pathname === volumePath(name) + "/detached") volumes = [];
      else if (pathname === appPath(name) && volumes.length === 0) appExists = false;
      else return empty(409);
      return empty(204);
    }
    if (pathname === appPath(name)) return appExists ? owned() : empty(404);
    if (pathname === volumePath(name)) return appExists ? Response.json(volumes) : empty(404);
    if (pathname === "/v1/apps") return Response.json({ apps: appExists ? [{ name }] : [] });
    throw Error(pathname);
  });
  name = person.name;
  const confirmation = await register(person);
  const texts: string[] = [];
  const delivery = vi.spyOn(person.chat.channel, "deliver").mockImplementation(async (message) => {
    texts.push(...message.texts);
    return { kind: "retry", afterMs: 1_000, detail: "hold receipt to inspect state" };
  });
  try {
    await person.chat.tap(confirmation);
    expect(person.erase).not.toHaveBeenCalled();
    expect(appExists).toBe(false);
    expect(await jobOf(person)).toMatchObject({ job: { kind: "receipt" } });
    expect.soft((await jobOf(person)).job?.box).not.toMatchObject({ kind: "wiped" });
    expect(texts).toEqual([expect.stringContaining("could not verify a disk wipe")]);
  } finally {
    delivery.mockRestore();
  }
});

test("a replacement arriving after relocation recheck must not receive an account wipe", async () => {
  let name: BoxName;
  let announceReplacement = false;
  let volumes = [vol("known", "old-machine")];
  let currentBox = "original-incarnation";
  const writes: string[] = [];
  const person = await draft("focused-recheck-to-health-race", async (url, init) => {
    const { pathname, search } = new URL(url);
    if (init?.method === "DELETE") {
      writes.push(pathname + search);
      return empty(409);
    }
    if (pathname === appPath(name)) return owned();
    if (pathname === volumePath(name)) {
      const response = Response.json(volumes);
      if (announceReplacement) {
        volumes = [vol("replacement", "new-machine")];
        currentBox = "replacement-incarnation";
        announceReplacement = false;
      }
      return response;
    }
    throw Error(pathname);
  }, { health: () => false });
  name = person.name;
  await person.chat.tap(await register(person));
  expect(await jobOf(person)).toMatchObject({ job: { box: { kind: "relocate", resume: "wipe-fly" } } });
  expect(person.erase).not.toHaveBeenCalled();
  person.health.mockImplementation(async () => ({ kind: "up", signedIn: false, box: currentBox }));
  announceReplacement = true;
  await advance(person);
  expect.soft(writes).toEqual([]);
  expect.soft(completion(person)).toEqual([]);
  expect.soft(await reservations(name)).toBe(1);
  const wipedBoxes = person.erase.mock.calls.map(([, , req]) => typeof req === "object" ? req.box : null);
  expect(wipedBoxes).not.toContain("replacement-incarnation");
});

