import { env, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { prepareOutsideWrite } from "../src/action/writes";
import { ERASE_JOB, type Erasure } from "../src/agent/account";
import { AgentStore } from "../src/agent/store";
import { flyHost } from "../src/box/fly";
import type { Fetch, FlyDiskRetirement } from "../src/box/host";
import type { BoxName } from "../src/box/names";
import { stripeApi, type CheckoutId } from "../src/billing/stripe";
import type { SubscriptionId } from "../src/billing/plan";
import type { EpochMs } from "../src/domain";
import { billingOn, devChat, fakeBox } from "./testkit";

async function outsideApprovalFixture(user: string) {
  const person = await devChat(user, { model: null, at: "2099-11-04T10:00" });
  await person.say("hello");
  const stub = env.AGENT.get(env.AGENT.idFromName(person.agent));

  await runInDurableObject(stub, (_, { storage }) => {
    const store = new AgentStore(storage);
    const now = person.clock.now();
    const proposed = prepareOutsideWrite({
      intent: "send-private-note", provider: "mail", action: "send", args: { body: "Private note" },
      epoch: store.forget().epoch, now, approval: { owner: person.agent, expiresAt: (now + 60_000) as EpochMs },
    });
    if (!proposed?.approval) throw new Error("missing approval fixture");
    expect(store.putOutsideWrite(proposed.write, proposed.approval)).toMatchObject({
      kind: "created", approval: { writeId: proposed.write.id },
    });
  });

  await person.say("/erase");
  const confirm = person.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("erasure button missing");
  return { person, stub, confirm: `/tap ${confirm.data}` };
}

test("a confirmed account erase removes an outside write and its linked approval", async () => {
  const { person, stub, confirm } = await outsideApprovalFixture("erase-outside-write");
  await person.say(confirm);

  const state = await runInDurableObject(stub, (_, { storage }) => ({
    job: storage.kv.get<Erasure>(ERASE_JOB)?.kind,
    writes: storage.sql.exec("SELECT id FROM outside_write").toArray(),
    approvals: storage.sql.exec("SELECT id FROM outside_approval").toArray(),
  }));
  expect({ ...state, message: person.channel.delivered.at(-1)?.text }).toEqual({
    job: undefined, writes: [], approvals: [], message: expect.stringMatching(/deleted your live Giraffe data/),
  });
  expect((await person.snapshot()).agent).toBeNull();
});

test("a persistent approval deletion failure rolls back the erase on every attempt", async () => {
  const { person, stub, confirm } = await outsideApprovalFixture("erase-outside-write-fault");
  await runInDurableObject(stub, (_, { storage }) => {
    storage.sql.exec(`CREATE TRIGGER fail_approval_delete BEFORE DELETE ON outside_approval
      BEGIN SELECT RAISE(ABORT, 'approval deletion failed'); END`);
  });

  const persisted = () => runInDurableObject(stub, (_, { storage }) => ({
    job: storage.kv.get<Erasure>(ERASE_JOB),
    linkedWrites: storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM outside_write JOIN outside_approval ON write_id = outside_write.id",
    ).one().count,
  }));
  await person.say(confirm);
  const first = await persisted();
  expect(first).toMatchObject({ job: { kind: "starting" }, linkedWrites: 1 });
  if (first.job?.nextAt === undefined) throw new Error("erasure retry is missing");
  person.clock.set(first.job.nextAt);
  await person.settle();

  const second = await persisted();
  expect(second).toMatchObject({ job: { kind: "starting" }, linkedWrites: 1 });
  expect(second.job?.nextAt).toBeGreaterThan(first.job.nextAt);
  expect(person.channel.delivered.at(-1)?.text).toMatch(/permanently delete your account data/);
});

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

test.each([false, true])("relocation keeps holding when only volumes return 404 (legacy saved target: %s)", async (legacy) => {
  let name: BoxName;
  const disk = vol("still-live", "known-machine");
  const requests: string[] = [];
  let lists = 0;
  const person = await draft("new-volume-404-" + legacy, async (url, init) => {
    const { pathname } = new URL(url);
    requests.push(init?.method + " " + pathname);
    if (pathname === appPath(name)) return owned();
    if (pathname === volumePath(name)) return ++lists === 1 ? Response.json([disk]) : empty(404);
    if (pathname === "/v1/apps") return Response.json({ apps: [{ name }] });
    throw Error(pathname);
  });
  name = person.name;
  await person.chat.tap(await register(person));
  expect(await jobOf(person)).toMatchObject({
    job: { kind: "cleaning", box: { kind: "relocate" } },
  });
  expect(await reservations(name)).toBe(1);
  if (legacy) {
    await runInDurableObject(person.stub, (_, { storage }) => {
      const job = storage.kv.get<{ box: { box: unknown } }>("account:erase")!;
      storage.kv.put("account:erase", {
        ...job,
        box: { kind: "remove-volume", box: job.box.box, target: { disk: disk.id, machine: "known-machine" } },
      });
    });
    await advance(person);
    expect(await jobOf(person)).toMatchObject({ job: { kind: "cleaning" } });
  }
  await advance(person);
  expect(requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
  expect({
    job: (await jobOf(person)).job,
    receipts: completion(person),
    reservations: await reservations(name),
  }).toEqual({
    job: expect.objectContaining({ kind: "cleaning" }),
    receipts: [],
    reservations: 1,
  });
});

test("an absent disk on a pre-wipe retry cannot produce a verified-wipe receipt", async () => {
  let name: BoxName;
  let live = [vol("unwiped", "known-machine")];
  let exists = true;
  const writes: string[] = [];
  const person = await draft("new-unwiped-gone", async (url, init) => {
    const { pathname, search } = new URL(url);
    if (init?.method === "DELETE") {
      writes.push(pathname + search);
      if (pathname !== appPath(name) || live.length) return empty(409);
      exists = false;
      return empty(204);
    }
    if (pathname === appPath(name)) return exists ? owned() : empty(404);
    if (pathname === volumePath(name)) return exists ? Response.json(live) : empty(404);
    if (pathname === "/v1/apps") return Response.json({ apps: exists ? [{ name }] : [] });
    throw Error(pathname);
  }, { wipe: () => false });
  name = person.name;
  await person.chat.tap(await register(person));
  expect(await jobOf(person)).toMatchObject({ job: { box: { kind: "relocate" } } });
  expect(person.erase).toHaveBeenCalledTimes(1);
  live = [];
  await advance(person);
  const receipts = completion(person);
  expect({ claimedWipe: receipts.some((receipt) => !/could not verify a disk wipe/.test(receipt)), writes }).toEqual({
    claimedWipe: false,
    writes: expect.not.arrayContaining([volumePath(name) + "/unwiped"]),
  });
});

test("a saved no-wipe target cannot authorize a newly attached machine and mounted disk", async () => {
  let name: BoxName;
  let live = [vol("previously-detached", null)];
  let exists = true;
  let lists = 0;
  const writes: string[] = [];
  const person = await draft("new-old-detached-now-mounted", async (url, init) => {
    const { pathname, search } = new URL(url);
    if (init?.method === "DELETE") {
      writes.push(pathname + search);
      if (pathname === volumePath(name) + "/previously-detached") live = [];
      if (pathname === appPath(name)) {
        if (live.length) return empty(409);
        exists = false;
      }
      return empty(204);
    }
    if (pathname === appPath(name)) return exists ? owned() : empty(404);
    if (pathname === volumePath(name)) return !exists || ++lists === 2 ? empty(404) : Response.json(live);
    if (pathname === "/v1/apps") return Response.json({ apps: exists ? [{ name }] : [] });
    throw Error(pathname);
  });
  name = person.name;
  await person.chat.tap(await register(person));
  expect(await jobOf(person)).toMatchObject({
    job: { kind: "cleaning", box: { kind: "relocate" } },
  });
  expect(person.erase).not.toHaveBeenCalled();
  live = [vol("previously-detached", "new-machine")];
  await advance(person);
  const unwiped = person.erase.mock.calls.length === 0;
  expect({ unwipedDeletes: unwiped ? writes : [], unwipedReceipts: unwiped ? completion(person) : [] }).toEqual({
    unwipedDeletes: [],
    unwipedReceipts: [],
  });
});

test("the non-force app request leaves an unknown racing volume and the job pending", async () => {
  let name: BoxName;
  let exists = true;
  let live: ReturnType<typeof vol>[] = [];
  const deletes: string[] = [];
  let listCount = 0;
  const person = await draft("new-app-delete-race", async (url, init) => {
    const { pathname, search } = new URL(url);
    if (init?.method === "DELETE") {
      deletes.push(pathname + search);
      if (pathname !== appPath(name)) return empty(409);
      if (live.length && search !== "?force=true") return empty(409);
      exists = false;
      live = [];
      return empty(204);
    }
    if (pathname === appPath(name)) return exists ? owned() : empty(404);
    if (pathname === "/v1/apps") return Response.json({ apps: exists ? [{ name }] : [] });
    if (pathname === volumePath(name)) {
      if (!exists) return empty(404);
      const snapshot = Response.json(live);
      if (++listCount === 4) live = [vol("late-unknown", "late-machine")];
      return snapshot;
    }
    throw Error(pathname);
  });
  name = person.name;
  await person.chat.tap(await register(person));
  expect({ deletes, live, receipts: completion(person), reservations: await reservations(name), job: (await jobOf(person)).job })
    .toEqual({
      deletes: [appPath(name)],
      live: [vol("late-unknown", "late-machine")],
      receipts: [],
      reservations: 1,
      job: expect.objectContaining({ kind: "cleaning", box: expect.objectContaining({ kind: "remove-app" }) }),
    });
  await advance(person);
  expect(deletes).toEqual([appPath(name)]);
  expect(completion(person)).toEqual([]);
});

test("a targetless legacy relocation preserves its hold and emits only rate-limited diagnostics", async () => {
  let name: BoxName;
  let providerCalls = 0;
  const person = await draft("new-legacy-relocation", async (url, init) => {
    providerCalls++;
    const { pathname } = new URL(url);
    if (init?.method !== "GET") throw Error("unexpected provider mutation");
    if (pathname === appPath(name)) return owned();
    if (pathname === volumePath(name)) return Response.json([vol(providerCalls > 2 ? "replacement" : "known", "machine")]);
    throw Error(pathname);
  }, { health: () => false });
  name = person.name;
  await person.chat.tap(await register(person));
  await runInDurableObject(person.stub, (_, { storage }) => {
    const { startedAt, diagnosedAt, box, ...job } = storage.kv.get<{
      box: { box: unknown }; startedAt: number; diagnosedAt: number;
    }>("account:erase")!;
    storage.kv.put("account:erase", { ...job, box: { kind: "relocate", box: box.box } });
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await advance(person);
    await advance(person);
    person.chat.clock.set((person.chat.clock.now() + 24 * 3_600_000) as EpochMs);
    await person.chat.settle();
    expect(warn.mock.calls).toEqual([
      [{ code: "erase_box_hold", value: 24 }],
      [{ code: "erase_box_hold", value: 48 }],
    ]);
    expect(providerCalls).toBe(2);
    expect(completion(person)).toEqual([]);
    expect(await reservations(name)).toBe(1);
    expect(await jobOf(person)).toMatchObject({ job: { kind: "cleaning", box: { kind: "relocate" } } });
  } finally {
    warn.mockRestore();
  }
});
