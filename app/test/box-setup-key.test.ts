import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { ACCOUNT_COPY } from "../src/agent/account";
import type { Agent } from "../src/agent/agent";
import { boxClient } from "../src/box/client";
import { flyHost, type FlyConfig } from "../src/box/fly";
import { HOST_OK } from "../src/box/host";
import { boxMessage, type BoxSay } from "../src/box/machine";
import { boxToken, signinTicket, type BoxName, type BoxSetup, type BoxToken } from "../src/box/names";
import type { EpochMs } from "../src/domain";
import { BOX_SECRET, chat, devChat, fakeBox, memoryLedger, scripted, ticketOpens, type DevChat, type FakeBox } from "./testkit";

const say = (s: BoxSay) => boxMessage(s, "en", null).text;
const at = (hm: string) => `2099-11-04T${hm}`;
const LINK = /https:\/\/\S+\/signin#t=\S+/;

function linkIn(texts: readonly string[]): string {
  const link = LINK.exec(texts.join("\n"))?.[0];
  if (!link) throw new Error(`no sign-in link in ${JSON.stringify(texts)}`);
  return link;
}

const VECTOR = {
  secret: "test-secret-0123456789abcdef",
  name: "gbox-0123456789ab" as BoxName,
  exp: 1790000000000 as EpochMs,
  nameOnly: "b-UiaAiUIgin1zs4CJbKAY68m8rphXVQwWrWHSMO2U4",
  setups: [
    {
      setup: "0123456789abcdef0123456789abcdef" as BoxSetup,
      token: "bR54N2ECmvOaNzfY-MAjNxSljEJGcUg37IULiGJPpi8",
      ticket: "1790000000000.T6Ty05be-BVM7-7t9NXFwNCUZlI68iyM7O8VM10Devk",
    },
    {
      setup: "fedcba9876543210fedcba9876543210" as BoxSetup,
      token: "J40cGlSG0gN_Bw99CZFSVR1lVtOYKgclss21zN1q_E0",
      ticket: "1790000000000.MhnaR5m2CD5RkekfV0cb1V7zX9d7VF2XogHH-wJLrBk",
    },
  ],
};

describe("each box setup has its own key", () => {
  test("a setup's key and ticket match the contract's test vector, and no setup keeps the name-only key", async () => {
    expect(await boxToken(VECTOR.secret, VECTOR.name, null)).toBe(VECTOR.nameOnly);
    for (const { setup, token, ticket } of VECTOR.setups) {
      expect(await boxToken(VECTOR.secret, VECTOR.name, setup)).toBe(token);
      expect(await signinTicket(token as BoxToken, VECTOR.exp)).toBe(ticket);
    }
  });

  test("a replacement box under the same name gets its own key: Giraffe installs it, links and calls with it, and the earlier link no longer opens it", async () => {
    const user = "setup-replacement";
    const box = fakeBox();
    const c = await devChat(user, { model: scripted([]), at: at("10:00"), box: box.deps });
    const name = await box.nameOf(user);
    await c.say("/claude");
    const firstLink = linkIn(await c.received());
    const firstKey = box.keys.get(name);

    await c.say("/claude remove");
    await c.advanceTo(at("10:05"));
    expect((await c.snapshot()).box).toBeNull();
    await c.received();

    await c.say("/claude");
    const secondLink = linkIn(await c.received());
    const secondKey = box.keys.get(name);
    expect(secondKey, "the replacement holds a key").toBeDefined();
    expect(secondKey, "the replacement's key is not the first box's").not.toBe(firstKey);
    expect(new URL(secondLink).hostname, "same box name").toBe(new URL(firstLink).hostname);
    expect(c.clock.now()).toBeLessThan(Number(new URL(firstLink).hash.split(/[=.]/)[1]));
    expect(await box.signInWith(firstLink, c.clock.now()), "the first box's unexpired link does not sign the person in on the replacement").toBe(false);
    expect(await box.signInWith(secondLink, c.clock.now()), "the replacement's own link does").toBe(true);

    await c.advanceTo(at("10:06"));
    expect(await c.received()).toEqual([say("connected")]);
    box.replies.push({ kind: "reply", step: chat("Hello from your own plan.") });
    await c.say("hello");
    expect(await c.received()).toEqual(["Hello from your own plan."]);
    expect(box.parses.at(-1)?.authorization).toBe(`Bearer ${secondKey}`);

    box.replies.push({ kind: "signed_out" }, { kind: "reply", step: chat("Back.") });
    await c.say("are you there?");
    const relink = linkIn(await c.received());
    expect(await ticketOpens(relink, new Map([[name, secondKey!]]), c.clock.now()), "a fresh link after sign-out is made for the replacement").toBe(true);
    await c.advanceTo(at("10:08"));
    expect(box.parses.at(-1)?.authorization, "the turn held over the sign-out runs under the replacement's key").toBe(`Bearer ${secondKey}`);

    box.image = "registry.test/box:2";
    await c.advanceTo(at("10:10"));
    expect(box.ensuredKeys.at(-1), "an image update keeps the replacement's key").toBe(secondKey);

    await c.say("/claude remove");
    await c.advanceTo(at("10:15"));
    expect((await c.snapshot()).box).toBeNull();
    expect(box.refusedKeys, "no call ever carried a key the box did not hold").toEqual([]);
    expect(new Set(box.ensuredKeys).size, "one key per setup").toBe(2);
  });
});

async function agentStorage(c: DevChat, run: (state: DurableObjectState) => void): Promise<void> {
  await runInDurableObject<Agent, void>(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_agent, state) => run(state));
}

/** The box row and machine as a Worker from before setups left them: no setup value, and the name-only key in BOX_TOKEN. */
async function asBoxFromBeforeSetups(c: DevChat, box: FakeBox, name: BoxName): Promise<string> {
  const legacy = await boxToken(BOX_SECRET, name, null);
  await agentStorage(c, (state) => state.storage.sql.exec("UPDATE box SET setup = NULL"));
  box.keys.set(name, legacy);
  return legacy;
}

describe("a box made before setups existed", () => {
  test("keeps the name-only key for turns, links and image updates, and is wiped with it on removal, even from a retirement record saved without a setup", async () => {
    const user = "setup-legacy-live";
    const box = fakeBox({ signedIn: true });
    const c = await devChat(user, { model: scripted([]), at: at("10:00"), box: box.deps });
    await c.say("/claude");
    expect(await c.received()).toEqual([say("setting_up"), say("connected")]);
    const name = await box.nameOf(user);
    const legacy = await asBoxFromBeforeSetups(c, box, name);

    box.replies.push({ kind: "reply", step: chat("Still here.") });
    await c.say("hello");
    expect(await c.received()).toEqual(["Still here."]);
    expect(box.parses.at(-1)?.authorization).toBe(`Bearer ${legacy}`);

    box.signedIn = false;
    box.replies.push({ kind: "signed_out" }, { kind: "reply", step: chat("Back.") });
    await c.say("hello again");
    const link = linkIn(await c.received());
    expect(await box.signInWith(link, c.clock.now()), "its link opens it").toBe(true);
    await c.advanceTo(at("10:02"));
    expect((await c.received())[0]).toBe(say("connected"));
    expect(box.parses.at(-1)?.authorization).toBe(`Bearer ${legacy}`);

    box.image = "registry.test/box:2";
    await c.advanceTo(at("10:05"));
    expect(box.ensuredKeys.at(-1)).toBe(legacy);

    box.reachable = false;
    await c.say("/claude remove");
    await c.advanceTo(at("10:06"));
    await agentStorage(c, (state) => {
      const record = state.storage.kv.get<{ box: Record<string, unknown> }>("box:retirement");
      if (!record) throw new Error("the removal saved no retirement record");
      const { setup: _, ...saved } = record.box;
      state.storage.kv.put("box:retirement", { ...record, box: saved });
    });
    box.reachable = true;
    await c.advanceTo(at("12:00"));
    expect((await c.snapshot()).box).toBeNull();
    expect(box.refusedKeys).toEqual([]);
    expect(box.destroyCalls).toEqual([name]);
  });

  test("an account erase wipes it with the name-only key", async () => {
    const user = "setup-legacy-erase";
    const box = fakeBox({ signedIn: true });
    const c = await devChat(user, { model: scripted([chat("Hi.")]), at: at("10:00"), box: box.deps });
    await c.say("/claude");
    await c.received();
    const name = await box.nameOf(user);
    await asBoxFromBeforeSetups(c, box, name);

    await c.say("/erase");
    const confirm = c.channel.delivered.at(-1)?.button;
    if (!confirm) throw new Error("missing erasure confirmation");
    await c.tap(confirm.data);
    await c.advanceTo(at("10:10"));
    expect(box.refusedKeys).toEqual([]);
    expect(box.destroyCalls).toEqual([name]);
    const receipt = c.channel.delivered.find((d) => d.text.includes(ACCOUNT_COPY.en.receipt))?.text;
    expect(receipt).toBeDefined();
    expect(receipt).not.toContain(ACCOUNT_COPY.en.deletedUnwipedBox);
    expect(receipt).not.toContain(ACCOUNT_COPY.en.reclaimedBox);
  });
});

const flyConfig: FlyConfig = {
  apiToken: "fake-org-token", org: "giraffes", image: "registry.fly.io/giraffes-box:1", region: "sin", volumeGb: 5, appPrefix: "gbox-", secret: BOX_SECRET,
};

/**
 * One Fly app at a time under one name, retired through the real Fly host. `signedIn` is what the disk holds, and a
 * wipe clears it. The box answers Giraffe only under the key its latest ensure installed, and the person's link only
 * when its ticket was made under that key.
 */
function fakeFly() {
  const requests: string[] = [];
  const box = { name: "", appExists: false, volume: "destroyed", incarnation: "", key: "", reachable: true, signedIn: false };
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
      requests.push(`disk deleted holding signedIn=${box.signedIn}`);
      box.volume = "destroyed";
      return new Response(null, { status: 202 });
    }
    if (rest === "/machines/machine_1" && method === "DELETE") return new Response(null, { status: 202 });
    return new Response(null, { status: 500 });
  });
  const ensure: typeof host.ensure = async (name, token) => {
    box.name = name;
    box.key = token;
    if (!box.appExists) Object.assign(box, { appExists: true, volume: "created", incarnation: crypto.randomUUID(), signedIn: false });
    return HOST_OK;
  };
  const client = boxClient(async (url, init) => {
    const path = new URL(url).pathname;
    requests.push(`box ${path}`);
    if (!box.reachable || !box.appExists) return new Response(null, { status: 503 });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${box.key}`) {
      requests.push("box refused the key");
      return new Response(null, { status: 401 });
    }
    if (path === "/health") return Response.json({ ok: true, signedIn: box.signedIn, authMethod: box.signedIn ? "oauth" : "none", box: box.incarnation });
    const erase = path === "/erase" ? JSON.parse(String(init?.body)) : null;
    if (erase?.scope !== "account" || erase.box !== box.incarnation) return new Response(null, { status: 412 });
    requests.push("box wipe");
    box.signedIn = false;
    return Response.json({ scope: "account", box: box.incarnation, floor: erase.epoch });
  });
  const since = (mark: number) => requests.slice(mark);
  return {
    box, requests, since,
    deps: { host: { ...host, ensure }, client, secret: BOX_SECRET, onlyFor: null, maxBoxes: 10 },
    /** The person opens a link on the box's sign-in page, which answers them even while Giraffe can't reach the box. */
    async signInWith(link: string, now: EpochMs): Promise<boolean> {
      const opened = box.appExists && (await ticketOpens(link, new Map([[box.name, box.key]]), now));
      if (opened) box.signedIn = true;
      return opened;
    },
    unwipedDiskDelete: (mark = 0) => since(mark).includes("disk deleted holding signedIn=true"),
    wipedBeforeDelete: (mark = 0) => {
      const s = since(mark);
      const wipe = s.indexOf("box wipe");
      const del = s.findIndex((r) => r.startsWith("DELETE") && r.endsWith("/volumes/vol_1"));
      return wipe !== -1 && del !== -1 && wipe < del;
    },
    diskDeleted: (mark = 0) => since(mark).some((r) => r.startsWith("DELETE") && r.endsWith("/volumes/vol_1")),
  };
}

type Fly = ReturnType<typeof fakeFly>;

async function start(user: string) {
  const fly = fakeFly();
  const ledger = memoryLedger();
  const c = await devChat(user, { model: scripted([chat("Hi."), chat("Hi again.")]), at: at("10:00"), ledger, box: fly.deps });
  await c.say("hello");
  await c.received();
  return { c, fly, ledger };
}

async function firstBoxLink(c: DevChat, fly: Fly): Promise<string> {
  fly.box.reachable = true;
  await c.say("/claude");
  return linkIn(await c.received());
}

async function eraseAccount(c: DevChat) {
  await c.say("/erase");
  const confirm = c.channel.delivered.at(-1)?.button;
  if (!confirm) throw new Error("missing erasure confirmation");
  await c.tap(confirm.data);
}

async function startAgain(c: DevChat) {
  await c.say("Start again.");
  const startButton = c.channel.delivered.at(-1)?.button;
  if (startButton) await c.tap(startButton.data);
  await c.received();
}

/** A replacement box in setup that Giraffe can't reach, and the person opening the earlier box's link on it. */
async function replacementOpenedWith(c: DevChat, fly: Fly, link: string): Promise<boolean> {
  const before = fly.box.name;
  fly.box.reachable = false;
  await c.say("/claude");
  expect((await c.received()).at(-1)).toBe(say("setting_up"));
  expect((await c.snapshot()).box?.state).toBe("provisioning");
  expect(fly.box.name, "the replacement has the earlier box's name").toBe(before);
  expect(c.clock.now(), "the earlier link is still live when the person uses it").toBeLessThan(Number(new URL(link).hash.split(/[=.]/)[1]));
  return fly.signInWith(link, c.clock.now());
}

describe("an account erase and a fresh start inside a link's 30 minutes", () => {
  test("the link from before the erase can't sign the person in on the new box, so /claude remove cleans it up without waiting for a wipe", async () => {
    const { c, fly, ledger } = await start("setup-erase-remove");
    const link = await firstBoxLink(c, fly);
    await c.advanceTo(at("10:01"));
    await eraseAccount(c);
    await c.advanceTo(at("10:04"));
    expect(fly.wipedBeforeDelete(), "the erase wiped the first box").toBe(true);
    await startAgain(c);
    await c.advanceTo(at("10:05"));
    const opened = await replacementOpenedWith(c, fly, link);
    const mark = fly.requests.length;
    await c.say("/claude remove");
    await c.advanceTo(at("10:30"));
    expect({ opened, unwipedDiskDeleteHoldingSignIn: fly.unwipedDiskDelete(mark), diskDeleted: fly.diskDeleted(mark) })
      .toEqual({ opened: false, unwipedDiskDeleteHoldingSignIn: false, diskDeleted: true });
    expect((await c.snapshot()).box).toBeNull();
    expect(ledger.boxes.has(c.agent)).toBe(false);
  });

  test("the link from before the erase can't sign the person in on the new box, so a setup that fails deletes no signed-in disk", async () => {
    const { c, fly } = await start("setup-erase-failed");
    const link = await firstBoxLink(c, fly);
    await c.advanceTo(at("10:01"));
    await eraseAccount(c);
    await c.advanceTo(at("10:04"));
    await startAgain(c);
    await c.advanceTo(at("10:05"));
    const opened = await replacementOpenedWith(c, fly, link);
    const mark = fly.requests.length;
    await c.advanceTo(at("11:30"));
    expect({ opened, unwipedDiskDeleteHoldingSignIn: fly.unwipedDiskDelete(mark) }).toEqual({ opened: false, unwipedDiskDeleteHoldingSignIn: false });
    expect(fly.diskDeleted(mark), "the failed setup is still cleaned up").toBe(true);
    expect((await c.snapshot()).box).toBeNull();
  });

  test("an erase while a replacement is in setup: the earlier box's link can't sign the person in on it, so its disk is never deleted signed in", async () => {
    const { c, fly } = await start("setup-erase-during-setup");
    const link = await firstBoxLink(c, fly);
    await c.advanceTo(at("10:01"));
    await c.say("/claude remove");
    await c.advanceTo(at("10:04"));
    expect(fly.wipedBeforeDelete(), "the first box was wiped before its disk went").toBe(true);
    await c.received();
    await c.advanceTo(at("10:05"));
    const opened = await replacementOpenedWith(c, fly, link);
    const mark = fly.requests.length;
    await c.advanceTo(at("10:06"));
    await eraseAccount(c);
    await c.advanceTo(at("12:30"));
    expect({ opened, unwipedDiskDeleteHoldingSignIn: fly.unwipedDiskDelete(mark) }).toEqual({ opened: false, unwipedDiskDeleteHoldingSignIn: false });
    expect(fly.diskDeleted(mark), "the erase still removes the box").toBe(true);
  });

  test("an erase after the box row is gone still reaches the box with its setup's key and wipes it", async () => {
    const { c, fly } = await start("setup-erase-reaches");
    const link = await firstBoxLink(c, fly);
    expect(await fly.signInWith(link, c.clock.now())).toBe(true);
    await c.advanceTo(at("10:01"));
    fly.box.reachable = false;
    const mark = fly.requests.length;
    await eraseAccount(c);
    await c.advanceTo(at("10:20"));
    expect(fly.diskDeleted(mark)).toBe(false);
    fly.box.reachable = true;
    await c.advanceTo(at("10:50"));
    expect(fly.wipedBeforeDelete(mark)).toBe(true);
    expect(fly.unwipedDiskDelete(mark)).toBe(false);
    expect(fly.since(mark)).not.toContain("box refused the key");
  });
});

describe("removing a replacement box while its setup still retries", () => {
  /** The first box sends its link at 10:00 and is wiped and removed at 10:01. At 10:05 a replacement starts that Giraffe can't reach. */
  async function replacementInSetup(user: string) {
    const { c, fly, ledger } = await start(user);
    const link = await firstBoxLink(c, fly);
    await c.advanceTo(at("10:01"));
    await c.say("/claude remove");
    await c.advanceTo(at("10:04"));
    expect(fly.wipedBeforeDelete(), "the first box was wiped before its disk went").toBe(true);
    await c.received();
    await c.advanceTo(at("10:05"));
    const opened = await replacementOpenedWith(c, fly, link);
    return { c, fly, ledger, opened };
  }

  test.for(["person", "operator"] as const)(
    "removal by the %s deletes a replacement with its own setup after three tries, since the earlier box's live link can't open it",
    async (by) => {
      const { c, fly, ledger, opened } = await replacementInSetup(`setup-retry-remove-${by}`);
      const mark = fly.requests.length;
      if (by === "operator") {
        await c.remove();
      } else {
        await c.say("/claude remove");
        expect(await c.received()).toEqual([say("removing")]);
      }
      await c.advanceTo(at("10:08"));
      expect({ opened, unwipedDiskDeleteHoldingSignIn: fly.unwipedDiskDelete(mark), diskDeleted: fly.diskDeleted(mark) })
        .toEqual({ opened: false, unwipedDiskDeleteHoldingSignIn: false, diskDeleted: true });
      expect(fly.since(mark).filter((r) => r === "box /health")).toHaveLength(3);
      expect((await c.snapshot()).box).toBeNull();
      expect(ledger.boxes.has(c.agent)).toBe(false);
      expect(await c.received()).toEqual(by === "operator" ? [] : [say("removed")]);
    },
  );

  test("a replacement with its own setup that answers again while it is being removed is wiped with its own key before its disk goes", async () => {
    const { c, fly, ledger, opened } = await replacementInSetup("setup-retry-answers");
    expect(opened).toBe(false);
    const mark = fly.requests.length;
    await c.say("/claude remove");
    expect(await c.received()).toEqual([say("removing")]);
    expect(fly.since(mark).filter((r) => r === "box /health"), "the first wipe try found the box down").toHaveLength(1);
    fly.box.reachable = true;
    await c.advanceTo(at("10:08"));
    expect(fly.wipedBeforeDelete(mark)).toBe(true);
    expect(fly.since(mark)).not.toContain("box refused the key");
    expect((await c.snapshot()).box).toBeNull();
    expect(ledger.boxes.has(c.agent)).toBe(false);
  });

  test("a replacement with its own setup whose setup fails is deleted without waiting for a wipe, since the earlier box's live link can't open it", async () => {
    const { c, fly, ledger, opened } = await replacementInSetup("setup-retry-failed");
    const mark = fly.requests.length;
    await c.advanceTo(at("11:30"));
    expect({ opened, unwipedDiskDeleteHoldingSignIn: fly.unwipedDiskDelete(mark), diskDeleted: fly.diskDeleted(mark) })
      .toEqual({ opened: false, unwipedDiskDeleteHoldingSignIn: false, diskDeleted: true });
    expect((await c.snapshot()).box).toBeNull();
    expect(ledger.boxes.has(c.agent)).toBe(false);
    expect(await c.received()).toEqual([say("setup_failed")]);
  });

  test.for(["is removed", "fails its setup"] as const)(
    "a box an older Worker set up, signed in with a live link that Worker sent for an earlier box, keeps its disk until it is wiped when it %s",
    async (end) => {
      const { c, fly, ledger } = await start(`setup-retry-older-${end.replace(/ /g, "-")}`);
      fly.box.reachable = false;
      await c.say("/claude");
      expect((await c.received()).at(-1)).toBe(say("setting_up"));
      expect((await c.snapshot()).box?.state).toBe("provisioning");
      const name = fly.box.name as BoxName;
      const key = await boxToken(BOX_SECRET, name, null);
      await agentStorage(c, (state) => state.storage.sql.exec("UPDATE box SET setup = NULL"));
      fly.box.key = key;
      const olderLink = `${fly.deps.host.urlOf(name)}/signin#t=${await signinTicket(key as BoxToken, (c.clock.now() + 25 * 60_000) as EpochMs)}`;
      expect(await fly.signInWith(olderLink, c.clock.now()), "the older Worker's name-only link opens it").toBe(true);
      const mark = fly.requests.length;
      if (end === "is removed") {
        await c.say("/claude remove");
        expect(await c.received()).toEqual([say("removing")]);
      }
      await c.advanceTo(at("11:30"));
      expect(fly.diskDeleted(mark)).toBe(false);
      expect(ledger.boxes.has(c.agent)).toBe(true);

      fly.box.reachable = true;
      await c.advanceTo(at("14:00"));
      expect(fly.wipedBeforeDelete(mark)).toBe(true);
      expect(fly.unwipedDiskDelete(mark)).toBe(false);
      expect(fly.since(mark)).not.toContain("box refused the key");
      expect((await c.snapshot()).box).toBeNull();
      expect(ledger.boxes.has(c.agent)).toBe(false);
    },
  );
});
