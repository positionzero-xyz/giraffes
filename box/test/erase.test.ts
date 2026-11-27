import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createBox } from "../src/server.ts";
import { startMock, type RunningMock } from "./mock.ts";

// BOX_TEST_CLI points at the Linux CLI inside the box image; the default is the sibling npm install.
const CLI = process.env.BOX_TEST_CLI ?? fileURLToPath(new URL("../node_modules/@anthropic-ai/claude-code/bin/claude.exe", import.meta.url));
const TOKEN = "b-erase-test-token-0123456789abcdefghijklmnop";
const APPEND = "You are Giraffe, a personal assistant.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-fake", refreshToken: "sk-ant-ort01-fake", expiresAt: 4102444800000, scopes: ["user:inference"] } });
const ACCOUNT = { accountUuid: "00000000-0000-4000-8000-000000000001", emailAddress: "person@example.com", organizationUuid: "00000000-0000-4000-8000-000000000002" };
const STALE = { status: 412, body: { error: "stale" } };

const dir = mkdtempSync(join(tmpdir(), "box-erase-"));
const config = join(dir, "config");
const home = join(dir, "home");
const tmp = join(dir, "tmp");
const varTmp = join(dir, "var-tmp");
const shm = join(dir, "dev-shm");
const scratch = [tmp, varTmp, shm];
const stateFile = join(dir, "state", "erase.json");
const sessionFile = join(home, ".giraffe-session");
const script = join(dir, "script.json");
const mockLog = join(dir, "mock.log");
const dumps = join(dir, "dumps");

const REMEMBER = { name: "remember", description: "Remember a fact.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } };

let mock: RunningMock | undefined;
const boxes: Server[] = [];

async function listen(opts: { scratchDirs?: readonly string[]; stateFile?: string; requireEpoch?: boolean } = {}): Promise<string> {
  const server = createBox({ token: TOKEN, cli: [CLI], sessionFile, home, configDir: config, scratchDirs: scratch, stateFile, ...opts });
  boxes.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(base: string, path: string, body?: object, auth = `Bearer ${TOKEN}`): Promise<{ status: number; body: any }> {
  const init = body === undefined ? { headers: { authorization: auth } } : { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: await res.json() };
}

const legacy = (text: string) => ({ model: "claude-haiku-5-5", append: APPEND, turn: `New\nPerson: ${text}`, tools: [REMEMBER] });
const turn = (text: string, at: object) => ({ ...legacy(text), session: null, fresh: `New\nPerson: ${text}`, ...at });
const parse = (text: string, at: object = {}) => ({ model: "claude-haiku-5-5", system: "be brief", user: text, jsonSchema: { type: "object" }, ...at });

// A running CLI renames its temp files, so a file listed a moment ago may be gone.
function whileThere<T>(read: () => T, gone: T): T {
  try {
    return read();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return gone;
    throw err;
  }
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((name) => join(root, name))
    .filter((path) => whileThere(() => statSync(path).isFile(), false));
}

const trees = () => [config, home, ...scratch].flatMap(files);
const holding = (marker: string) => trees().filter((path) => whileThere(() => readFileSync(path).includes(marker), false)).map((path) => relative(dir, path));
const listing = () => trees().map((path) => relative(dir, path)).sort();
const outsideSignIn = () => readdirSync(config).filter((name) => name !== ".credentials.json" && name !== ".claude.json");
const sentToMock = (marker: string) => readdirSync(dumps).some((f) => readFileSync(join(dumps, f), "utf8").includes(marker));

function seed(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

async function until(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("erasing the person's words from the box", { skip: existsSync(CLI) ? false : "the pinned CLI is not installed (npm ci in box/)" }, () => {
  let base = "";
  let box = "";
  const at = (epoch: number) => ({ box, epoch });

  before(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC")) delete process.env[k];
    for (const d of [config, home, ...scratch, join(dir, "state"), dumps]) mkdirSync(d, { recursive: true });
    Object.assign(process.env, {
      CLAUDE_CONFIG_DIR: config,
      HOME: home,
      USERPROFILE: home,
      TEMP: tmp,
      TMP: tmp,
      TMPDIR: tmp,
      ANTHROPIC_API_KEY: "sk-ant-api03-mock-not-a-key",
    });
    writeFileSync(join(config, ".credentials.json"), CREDENTIALS);
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ oauthAccount: ACCOUNT, tipsHistory: { "MARKER-ZERO-6020": 1 } }));
    writeFileSync(script, JSON.stringify({ calls: [], text: "Noted." }));
    mock = await startMock(mockLog, dumps, script);
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.port}`;
    base = await listen();
  });
  after(() => {
    for (const server of boxes) server.close();
    mock?.proc.kill();
  });

  it("keeps the person's words from a turn in Claude Code's files (the control)", async () => {
    const r = await call(base, "/agent", legacy("my locker code is MARKER-ONE-4417"));
    assert.equal(r.status, 200);
    assert.ok(holding("MARKER-ONE-4417").some((path) => path.startsWith("config")), `no copy under the config dir: ${listing().join(", ")}`);
    assert.ok(existsSync(sessionFile));
  });

  it("names this volume in /health", async () => {
    const health = await call(base, "/health");
    assert.equal(health.status, 200);
    assert.match(health.body.box, UUID);
    box = health.body.box;
  });

  it("refuses, before any erase, a request meant for another volume under the same box name", async () => {
    assert.deepEqual(await call(base, "/parse", parse("MARKER-SEVEN-1290", { box: "11111111-2222-3333-4444-555555555555", epoch: 0 })), STALE);
    assert.equal(sentToMock("MARKER-SEVEN-1290"), false);
  });

  it("erases every copy, from every folder Claude Code and the box write, and keeps only the sign-in", async () => {
    for (const path of [join(config, "todos", "t.json"), join(config, "backups", ".claude.json.backup.1"), join(home, ".cache", "c"), join(tmp, "claude-cwd-old", "x"), join(tmp, "giraffe-tools-old", "tools.json"), join(tmp, "anything", "y"), join(varTmp, "v"), join(shm, "s")]) seed(path, "MARKER-ONE-4417");
    const credentials = readFileSync(join(config, ".credentials.json"));
    assert.deepEqual(await call(base, "/erase", { epoch: 1 }), { status: 200, body: { box, floor: 1 } });
    assert.deepEqual(holding("MARKER-ONE-4417"), []);
    assert.deepEqual(holding("MARKER-ZERO-6020"), []);
    assert.deepEqual(readFileSync(join(config, ".credentials.json")), credentials);
    assert.deepEqual(outsideSignIn(), []);
    assert.deepEqual(JSON.parse(readFileSync(join(config, ".claude.json"), "utf8")), { oauthAccount: ACCOUNT });
    assert.deepEqual(readdirSync(home), []);
    for (const d of scratch) assert.deepEqual(readdirSync(d), [], d);
  });

  it("removes the old Worker's session pointer", () => {
    assert.equal(existsSync(sessionFile), false);
  });

  it("serves a turn at the erase's own epoch right after it, starting fresh", async () => {
    const r = await call(base, "/agent", turn("what did I tell you?", at(1)));
    assert.equal(r.status, 200);
    assert.equal(r.body.session.resumed, false);
    assert.equal((await call(base, "/parse", parse("hello", at(1)))).status, 200);
    assert.deepEqual(holding("MARKER-ONE-4417"), []);
  });

  it("refuses, once the box has been erased, a request with no epoch, an older epoch or another volume's name, and writes nothing for it", async () => {
    const before = listing();
    assert.deepEqual(await call(base, "/agent", legacy("MARKER-FOUR-3008")), STALE);
    assert.deepEqual(await call(base, "/agent", turn("MARKER-FOUR-3008", at(0))), STALE);
    assert.deepEqual(await call(base, "/agent", turn("MARKER-FOUR-3008", { box: "11111111-2222-3333-4444-555555555555", epoch: 1 })), STALE);
    assert.deepEqual(await call(base, "/parse", parse("MARKER-FOUR-3008")), STALE);
    assert.deepEqual(await call(base, "/parse", parse("MARKER-FOUR-3008", at(0))), STALE);
    assert.deepEqual(listing(), before);
    assert.equal(sentToMock("MARKER-FOUR-3008"), false);
  });

  it("stops a running turn, which answers 502, refuses the turn queued behind it, and erases what both wrote", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Late.", holdMs: 30_000 }));
    const held = call(base, "/agent", turn("my passport number is MARKER-TWO-9921", at(1)));
    await until(() => sentToMock("MARKER-TWO-9921") && holding("MARKER-TWO-9921").length > 0, 60_000);
    const queued = call(base, "/agent", turn("MARKER-THREE-5150 too", at(1)));
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    const erased = await call(base, "/erase", { epoch: 2 });
    writeFileSync(script, JSON.stringify({ calls: [], text: "Noted." }));
    assert.deepEqual(erased, { status: 200, body: { box, floor: 2 } });
    assert.ok(Date.now() - started < 20_000, "the erase waited for the held answer instead of stopping the turn");
    assert.deepEqual(await held, { status: 502, body: { error: "claude_failed" } });
    assert.deepEqual(await queued, STALE);
    assert.deepEqual(holding("MARKER-TWO-9921"), []);
    assert.equal(sentToMock("MARKER-THREE-5150"), false);
  });

  it("refuses a turn that was queued before an erase even at the erase's own epoch, and serves the next one at that epoch", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Late.", holdMs: 30_000 }));
    const held = call(base, "/agent", turn("MARKER-EIGHT-4471 is my pin", at(2)));
    await until(() => sentToMock("MARKER-EIGHT-4471"), 60_000);
    const queued = call(base, "/agent", turn("MARKER-NINE-8302 as well", at(2)));
    await new Promise((r) => setTimeout(r, 200));
    const erased = await call(base, "/erase", { epoch: 2 });
    writeFileSync(script, JSON.stringify({ calls: [], text: "Noted." }));
    assert.deepEqual(erased, { status: 200, body: { box, floor: 2 } });
    assert.equal((await held).status, 502);
    assert.deepEqual(await queued, STALE);
    assert.equal(sentToMock("MARKER-NINE-8302"), false);
    assert.deepEqual(holding("MARKER-EIGHT-4471"), []);
    assert.equal((await call(base, "/agent", turn("next turn", at(2)))).status, 200);
  });

  it("answers a repeated or older erase with the same floor, and leaves only the sign-in", async () => {
    assert.deepEqual(await call(base, "/erase", { epoch: 2 }), { status: 200, body: { box, floor: 2 } });
    assert.deepEqual(await call(base, "/erase", { epoch: 1 }), { status: 200, body: { box, floor: 2 } });
    assert.deepEqual(outsideSignIn(), []);
    assert.deepEqual(readdirSync(home), []);
  });

  it("keeps the floor and the volume's name across a restart", async () => {
    const restarted = await listen();
    assert.equal((await call(restarted, "/health")).body.box, box);
    assert.deepEqual(await call(restarted, "/agent", turn("MARKER-FIVE-7781", at(1))), STALE);
    assert.equal(sentToMock("MARKER-FIVE-7781"), false);
  });

  it("refuses an erase without the token or with a bad epoch, and a turn with half of its epoch", async () => {
    assert.equal((await call(base, "/erase", { epoch: 3 }, "Bearer wrong")).status, 401);
    for (const epoch of [0, -1, 1.5, "3", null]) assert.equal((await call(base, "/erase", { epoch })).status, 400, `erase epoch ${epoch}`);
    for (const half of [{ epoch: 2 }, { box }, { box: "not-a-volume", epoch: 2 }, { box, epoch: -1 }, { box, epoch: 1.5 }]) {
      assert.equal((await call(base, "/agent", turn("hi", half))).status, 400, JSON.stringify(half));
    }
  });

  it("answers 500 to an erase it can't finish, refuses every turn until one does, and finishes it after a restart", async () => {
    const broken = join(dir, "not-a-folder");
    writeFileSync(broken, "");
    seed(join(shm, "left", "z"), "MARKER-SIX-2266");
    const failing = await listen({ scratchDirs: [tmp, varTmp, broken] });
    assert.deepEqual(await call(failing, "/erase", { epoch: 3 }), { status: 500, body: { error: "erase_incomplete" } });
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).erasing, true);
    assert.deepEqual(await call(failing, "/agent", turn("hi", at(3))), STALE);
    assert.deepEqual(await call(failing, "/parse", parse("hi", at(3))), STALE);

    const restarted = await listen();
    assert.equal((await call(restarted, "/health")).status, 200);
    assert.deepEqual(holding("MARKER-SIX-2266"), []);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { box, floor: 3, erasing: false, epochs: true });
    assert.equal((await call(restarted, "/agent", turn("hello again", at(3)))).status, 200);
  });
  it("keeps a sign-in name only as a regular file, and erases a folder planted under that name", async () => {
    const credentials = readFileSync(join(config, ".credentials.json"));
    rmSync(join(config, ".credentials.json"));
    seed(join(config, ".credentials.json", "inside"), "MARKER-TEN-6614");
    assert.deepEqual(await call(base, "/erase", { epoch: 3 }), { status: 200, body: { box, floor: 3 } });
    assert.deepEqual(holding("MARKER-TEN-6614"), []);
    assert.equal(existsSync(join(config, ".credentials.json")), false);
    writeFileSync(join(config, ".credentials.json"), credentials);
  });

  it("empties the folder that holds the erase record, keeping only the record itself as a regular file", async () => {
    const stateDir = join(dir, "state");
    seed(join(stateDir, "left.txt"), "MARKER-TWELVE-4410");
    seed(join(stateDir, "nested", "deep.txt"), "MARKER-TWELVE-4410");
    seed(join(stateDir, "erase.json.next"), "MARKER-TWELVE-4410");
    assert.deepEqual(await call(base, "/erase", { epoch: 3 }), { status: 200, body: { box, floor: 3 } });
    assert.deepEqual(readdirSync(stateDir), ["erase.json"]);
    assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { box, floor: 3, erasing: false, epochs: true });
  });

  it("refuses a request without an epoch on a fresh volume once a request named the volume and an epoch, and after a restart", async () => {
    const freshState = join(dir, "fresh-state", "erase.json");
    mkdirSync(join(dir, "fresh-state"), { recursive: true });
    const fresh = await listen({ stateFile: freshState });
    const volume = (await call(fresh, "/health")).body.box;
    assert.notEqual(volume, box);
    assert.equal((await call(fresh, "/parse", parse("before any epoch"))).status, 200);
    assert.equal((await call(fresh, "/parse", parse("with an epoch", { box: volume, epoch: 0 }))).status, 200);
    assert.deepEqual(await call(fresh, "/parse", parse("MARKER-ELEVEN-0937")), STALE);
    assert.deepEqual(await call(await listen({ stateFile: freshState }), "/parse", parse("MARKER-ELEVEN-0937")), STALE);
    assert.equal(sentToMock("MARKER-ELEVEN-0937"), false);
  });

  it("refuses every request without an epoch on a fresh volume the Worker set up to require one", async () => {
    mkdirSync(join(dir, "required-state"), { recursive: true });
    const required = await listen({ stateFile: join(dir, "required-state", "erase.json"), requireEpoch: true });
    const volume = (await call(required, "/health")).body.box;
    assert.deepEqual(await call(required, "/parse", parse("MARKER-TWELVE-5528")), STALE);
    assert.equal(sentToMock("MARKER-TWELVE-5528"), false);
    assert.equal((await call(required, "/parse", parse("hello", { box: volume, epoch: 0 }))).status, 200);
  });
});
