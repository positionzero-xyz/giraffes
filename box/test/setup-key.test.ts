import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createBox } from "../src/server.ts";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

const VECTOR = {
  secret: "test-secret-0123456789abcdef",
  name: "gbox-0123456789ab",
  exp: 1790000000000,
  nameOnly: {
    token: "b-UiaAiUIgin1zs4CJbKAY68m8rphXVQwWrWHSMO2U4",
    ticket: "1790000000000.AA1PzFmYf_4obmGHsfd0634YPiMbVDnmjYWbmYI62kM",
  },
  setupA: {
    setup: "0123456789abcdef0123456789abcdef",
    token: "bR54N2ECmvOaNzfY-MAjNxSljEJGcUg37IULiGJPpi8",
    ticket: "1790000000000.T6Ty05be-BVM7-7t9NXFwNCUZlI68iyM7O8VM10Devk",
  },
  setupB: {
    setup: "fedcba9876543210fedcba9876543210",
    token: "J40cGlSG0gN_Bw99CZFSVR1lVtOYKgclss21zN1q_E0",
    ticket: "1790000000000.MhnaR5m2CD5RkekfV0cb1V7zX9d7VF2XogHH-wJLrBk",
  },
};

async function boxWith(token: string) {
  const root = mkdtempSync(join(tmpdir(), "box-setup-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const server = createBox({
    token, cli: [process.execPath, FAKE, root], home: join(root, "home"), configDir: join(root, "config"), scratchDirs: [],
    sessionFile: join(root, ".giraffe-session"), stateFile: join(stateDir, "erase.json"), requireEpoch: true, now: () => VECTOR.exp - 60_000,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const signedIn = async () => {
    const res = await fetch(url + "/health", { headers: { authorization: `Bearer ${token}`, connection: "close" } });
    return ((await res.json()) as { signedIn: boolean }).signedIn;
  };
  const signIn = async (ticket: string) => {
    const start = await post("/signin/start", { ticket });
    if (start.status !== 200) return start;
    return post("/signin/code", { ticket, code: "good-code#state" });
  };
  const close = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
  };
  return { signIn, signedIn, close };
}

const key = (setup: string | null) =>
  createHmac("sha256", VECTOR.secret).update(setup === null ? `box:${VECTOR.name}` : `box:${VECTOR.name}:${setup}`).digest("base64url");
const ticketUnder = (token: string) => `${VECTOR.exp}.${createHmac("sha256", token).update(`signin:${VECTOR.exp}`).digest("base64url")}`;

describe("each box setup has its own key", () => {
  it("derives the vector's keys and tickets: name only for a box from before setups, name and setup otherwise", () => {
    assert.equal(key(null), VECTOR.nameOnly.token);
    assert.equal(ticketUnder(VECTOR.nameOnly.token), VECTOR.nameOnly.ticket);
    for (const s of [VECTOR.setupA, VECTOR.setupB]) {
      assert.equal(key(s.setup), s.token);
      assert.equal(ticketUnder(s.token), s.ticket);
    }
  });

  it("a link made for one setup cannot sign the person in on a later setup with the same name, and each setup's own link can", async () => {
    const first = await boxWith(VECTOR.setupA.token);
    assert.deepEqual(await first.signIn(VECTOR.setupA.ticket), { status: 200, body: { signedIn: true } });
    assert.equal(await first.signedIn(), true);
    await first.close();

    const replacement = await boxWith(VECTOR.setupB.token);
    assert.deepEqual(await replacement.signIn(VECTOR.setupA.ticket), { status: 401, body: { error: "unauthorized" } });
    assert.deepEqual(await replacement.signIn(VECTOR.nameOnly.ticket), { status: 401, body: { error: "unauthorized" } });
    assert.equal(await replacement.signedIn(), false, "the earlier setup's link left the replacement signed out");
    assert.deepEqual(await replacement.signIn(VECTOR.setupB.ticket), { status: 200, body: { signedIn: true } });
    await replacement.close();
  });

  it("a box from before setups keeps taking its name-only link, and refuses a link made for a setup", async () => {
    const legacy = await boxWith(VECTOR.nameOnly.token);
    assert.deepEqual(await legacy.signIn(VECTOR.setupA.ticket), { status: 401, body: { error: "unauthorized" } });
    assert.deepEqual(await legacy.signIn(VECTOR.nameOnly.ticket), { status: 200, body: { signedIn: true } });
    await legacy.close();
  });
});
