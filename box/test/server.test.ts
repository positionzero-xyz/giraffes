import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type RequestOptions } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createBox } from "../src/server.ts";

const TOKEN = "b-UiaAiUIgin1zs4CJbKAY68m8rphXVQwWrWHSMO2U4";
const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const TEN_MINUTES = 10 * 60_000;

const dir = mkdtempSync(join(tmpdir(), "box-test-"));
let clockOffset = 0;
const now = () => Date.now() + clockOffset;
const stateDir = join(dir, "state");
mkdirSync(stateDir, { recursive: true });
const server = createBox({ token: TOKEN, cli: [process.execPath, FAKE, dir], sessionFile: join(dir, ".giraffe-session"), home: join(dir, "home"), configDir: join(dir, "config"), scratchDirs: [join(dir, "tmp")], stateFile: join(stateDir, "erase.json"), now });
let base = "";

const ticket = (exp = Date.now() + 30 * 60_000) => `${exp}.${createHmac("sha256", TOKEN).update(`signin:${exp}`).digest("base64url")}`;
const events = (): string[] => (existsSync(join(dir, "events.log")) ? readFileSync(join(dir, "events.log"), "utf8").trim().split("\n") : []);
const signIn = (state: boolean) => (state ? writeFileSync(join(dir, "logged-in"), "") : rmSync(join(dir, "logged-in"), { force: true }));

async function call(method: string, path: string, opts: { auth?: string; body?: unknown } = {}): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text, headers: res.headers };
}

function responseTo(options: RequestOptions, incompleteBody?: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(base, { ...options, agent: false }, (res) => {
      res.resume();
      res.on("error", reject);
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.setTimeout(12_000, () => req.destroy(new Error("no response")));
    if (incompleteBody !== undefined) req.write(incompleteBody);
    else req.end();
  });
}
const bearer = `Bearer ${TOKEN}`;

async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const turn = (user = "hello") => ({ model: "claude-haiku-5-5", system: "be brief", user, jsonSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" } });

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clockOffset = 0;
  signIn(false);
  rmSync(join(dir, "events.log"), { force: true });
});

it("logs only typed diagnostics when the CLI puts private text in stderr or the result subtype", async (t) => {
  signIn(true);
  const info = t.mock.method(console, "info", () => {});
  const error = t.mock.method(console, "error", () => {});
  const log = t.mock.method(console, "log", () => {});
  const model = "private fixture model name";
  const system = "private fixture system prompt";

  assert.equal((await call("POST", "/parse", { auth: bearer, body: { ...turn("crash"), model, system } })).status, 502);
  assert.equal((await call("POST", "/parse", { auth: bearer, body: { ...turn(), model, system } })).status, 200);

  const messages = [info, error, log].flatMap((mock) => mock.mock.calls.map((entry) => entry.arguments));
  assert.deepEqual(messages[0], [{ code: "parse_failed", exit: 2 }]);
  assert(!JSON.stringify(messages).includes("private fixture"));
});

describe("auth", () => {
  it("refuses /health and /parse without the exact bearer token", async () => {
    for (const auth of [undefined, "", `Bearer ${TOKEN}x`, TOKEN]) {
      assert.equal((await call("GET", "/health", { auth })).status, 401, `health with ${auth}`);
      assert.equal((await call("POST", "/parse", { auth, body: turn() })).status, 401, `parse with ${auth}`);
    }
    assert.equal(events().filter((e) => e.startsWith("turn")).length, 0, "no turn ran");
  });

  it("refuses sign-in calls with a missing, forged or expired ticket", async () => {
    const forged = ticket().replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    for (const t of [undefined, "nope", forged, ticket(Date.now() - 1)]) {
      assert.equal((await call("POST", "/signin/start", { body: { ticket: t } })).status, 401, `start with ${t}`);
      assert.equal((await call("POST", "/signin/code", { body: { ticket: t, code: "good-code#state" } })).status, 401, `code with ${t}`);
    }
    assert.deepEqual(events(), [], "no login process started");
  });

  it("answers 404 for anything else", async () => {
    assert.equal((await call("GET", "/parse", { auth: bearer })).status, 404);
    assert.equal((await call("POST", "/health", { auth: bearer })).status, 404);
    assert.equal((await call("GET", "/", { auth: bearer })).status, 404);
  });

  it("answers 400 for an invalid request target and still serves the next request", async () => {
    assert.equal(await responseTo({ path: "//[" }), 400);
    assert.equal((await call("GET", "/signin")).status, 200);
  });

  it("refuses oversized bodies on both sign-in routes", async () => {
    for (const path of ["/signin/start", "/signin/code"]) {
      assert.equal((await call("POST", path, { body: { padding: "é".repeat(2048) } })).status, 413);
      assert.equal(await responseTo({ method: "POST", path }, "é".repeat(2049)), 413);
    }
    assert.deepEqual(events(), []);
  });

  it("times out an unfinished sign-in request", { timeout: 14_000 }, async () => {
    assert.equal(await responseTo({ method: "POST", path: "/signin/start" }, "{"), 408);
    assert.deepEqual(events(), []);
  });

  it("serves the sign-in page without auth", async () => {
    const page = await call("GET", "/signin?x=1");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(page.text, /location\.hash/);
    assert.doesNotMatch(page.text, /<script[^>]+src=/, "no external scripts");
  });

  it("refuses to start without BOX_TOKEN", () => {
    const { BOX_TOKEN: _, ...env } = process.env;
    const run = spawnSync(process.execPath, [MAIN], { env: { ...env, BOX_PORT: "0" }, encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /BOX_TOKEN is required/);
  });
});

describe("health and parse", () => {
  it("reports signedIn from the CLI's auth status, and names the volume", async () => {
    const out = (await call("GET", "/health", { auth: bearer })).body;
    assert.match(out.box, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(out, { ok: true, signedIn: false, authMethod: "none", version: "2.1.316", box: out.box });
    signIn(true);
    assert.deepEqual((await call("GET", "/health", { auth: bearer })).body, { ok: true, signedIn: true, authMethod: "claude.ai", version: "2.1.316", box: out.box });
  });

  it("keeps what the CLI printed to stderr out of the box's log", async () => {
    signIn(true);
    const logged: string[] = [];
    const { log, info, error, warn } = console;
    console.log = console.info = console.error = console.warn = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    try {
      assert.equal((await call("POST", "/parse", { auth: bearer, body: turn("crash") })).status, 502);
    } finally {
      Object.assign(console, { log, info, error, warn });
    }
    assert.ok(logged.length > 0);
    assert.deepEqual(logged.filter((line) => line.includes("boom")), []);
  });

  it("answers 409 signed_out when the CLI has no login", async () => {
    const res = await call("POST", "/parse", { auth: bearer, body: turn() });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: "signed_out" });
  });

  it("returns the structured reply when signed in", async () => {
    signIn(true);
    const res = await call("POST", "/parse", { auth: bearer, body: turn("hi there") });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      structured: { ok: true, model: "haiku", system: "be brief", schema: { type: "object" }, user: "hi there" },
      usage: { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 4 },
      stop: "end",
      costUsd: 0.001,
    });
  });

  it("answers 502 claude_failed when the CLI fails while signed in, and 400 for a bad body", async () => {
    signIn(true);
    assert.deepEqual((await call("POST", "/parse", { auth: bearer, body: turn("crash") })).body, { error: "claude_failed" });
    assert.equal((await call("POST", "/parse", { auth: bearer, body: {} })).status, 400);
  });

  it("runs one turn at a time", async () => {
    signIn(true);
    const replies = await Promise.all([1, 2, 3].map((n) => call("POST", "/parse", { auth: bearer, body: turn(`turn ${n}`) })));
    assert.deepEqual(replies.map((r) => r.status), [200, 200, 200]);
    const marks = events().map((e) => e.split(" ")[1]);
    assert.deepEqual(marks, ["start", "end", "start", "end", "start", "end"]);
  });

  it("kills a turn's CLI when the caller hangs up, so the next turn doesn't wait behind it", async () => {
    signIn(true);
    const hangUp = new AbortController();
    const abandoned = fetch(`${base}/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: bearer },
      body: JSON.stringify(turn("hang")),
      signal: hangUp.signal,
    }).catch(() => null);
    await waitFor(() => events().some((e) => e.startsWith("turn start")));
    hangUp.abort();
    await abandoned;

    const started = Date.now();
    assert.equal((await call("POST", "/parse", { auth: bearer, body: turn("next") })).status, 200);
    assert.ok(Date.now() - started < 3000, `the next turn waited ${Date.now() - started}ms`);
    assert.deepEqual(events().map((e) => e.split(" ").slice(0, 2).join(" ")), ["turn start", "turn start", "turn end"]);
  });
});

describe("sign-in", () => {
  it("returns the CLI's link, writes the code once and reports the login", async () => {
    const t = ticket();
    const start = await call("POST", "/signin/start", { body: { ticket: t } });
    assert.equal(start.status, 200);
    assert.deepEqual(start.body, { url: "https://claude.com/cai/oauth/authorize?code=true&state=s3cret" });
    assert.deepEqual(events(), ["login started BROWSER=true"]);

    const code = await call("POST", "/signin/code", { body: { ticket: t, code: "  good-code#state\n" } });
    assert.deepEqual([code.status, code.body], [200, { signedIn: true }]);
    assert.deepEqual(events(), ["login started BROWSER=true", "login read good-code#state"]);
    assert.equal((await call("GET", "/health", { auth: bearer })).body.signedIn, true);

    const again = await call("POST", "/signin/code", { body: { ticket: t, code: "good-code#state" } });
    assert.deepEqual([again.status, again.body], [409, { error: "no_signin" }]);
    assert.equal(events().length, 2, "the code went to the CLI once");
  });

  it("reports signedIn false soon after the CLI rejects the code", async () => {
    const t = ticket();
    await call("POST", "/signin/start", { body: { ticket: t } });
    const started = Date.now();
    const code = await call("POST", "/signin/code", { body: { ticket: t, code: "garbled" } });
    assert.deepEqual([code.status, code.body], [200, { signedIn: false }]);
    assert.ok(Date.now() - started < 10_000, "did not wait out the 60 s exit window");
    assert.deepEqual((await call("POST", "/signin/code", { body: { ticket: t, code: "good-code#state" } })).body, { error: "no_signin" });
  });

  it("refuses a code with no sign-in started, or an empty one", async () => {
    const t = ticket();
    assert.deepEqual((await call("POST", "/signin/code", { body: { ticket: t, code: "good-code#state" } })).body, { error: "no_signin" });
    await call("POST", "/signin/start", { body: { ticket: t } });
    assert.equal((await call("POST", "/signin/code", { body: { ticket: t, code: "  " } })).status, 400);
    assert.equal((await call("POST", "/signin/code", { body: { ticket: t, code: "a\nb" } })).status, 400);
  });

  it("still takes the code just under 10 minutes after start", async () => {
    const t = ticket();
    await call("POST", "/signin/start", { body: { ticket: t } });
    clockOffset = TEN_MINUTES - 1000;
    assert.deepEqual((await call("POST", "/signin/code", { body: { ticket: t, code: "good-code#state" } })).body, { signedIn: true });
  });

  it("drops the sign-in 10 minutes after start without writing the code", async () => {
    const t = ticket();
    await call("POST", "/signin/start", { body: { ticket: t } });
    clockOffset = TEN_MINUTES;
    const code = await call("POST", "/signin/code", { body: { ticket: t, code: "good-code#state" } });
    assert.deepEqual([code.status, code.body], [409, { error: "no_signin" }]);
    assert.deepEqual(events(), ["login started BROWSER=true"], "the code never reached the CLI");
    assert.equal((await call("GET", "/health", { auth: bearer })).body.signedIn, false);
  });

  it("answers 409 busy to a start or a code while a code is completing, and keeps the one login process", async () => {
    const t = ticket();
    await call("POST", "/signin/start", { body: { ticket: t } });
    const completing = call("POST", "/signin/code", { body: { ticket: t, code: "slow-code#state" } });
    await new Promise((r) => setTimeout(r, 200));

    const start = await call("POST", "/signin/start", { body: { ticket: t } });
    const code = await call("POST", "/signin/code", { body: { ticket: t, code: "good-code#state" } });
    assert.deepEqual([start.status, start.body], [409, { error: "busy" }]);
    assert.deepEqual([code.status, code.body], [409, { error: "busy" }]);

    assert.deepEqual((await completing).body, { signedIn: true });
    assert.deepEqual(events(), ["login started BROWSER=true", "login read slow-code#state"]);
    assert.deepEqual((await call("POST", "/signin/code", { body: { ticket: t, code: "good-code#state" } })).body, { error: "no_signin" });
  });

  it("starts once per ticket and accepts a code only with that ticket", async () => {
    const t = ticket();
    const other = ticket(Number(t.split(".")[0]) + 1);
    assert.equal((await call("POST", "/signin/start", { body: { ticket: t } })).status, 200);
    const reuse = await call("POST", "/signin/start", { body: { ticket: t } });
    assert.deepEqual([reuse.status, reuse.body], [409, { error: "used_ticket" }]);
    const mismatch = await call("POST", "/signin/code", { body: { ticket: other, code: "good-code#state" } });
    assert.deepEqual([mismatch.status, mismatch.body], [409, { error: "no_signin" }]);
    assert.deepEqual(events(), ["login started BROWSER=true"]);
    assert.deepEqual((await call("POST", "/signin/code", { body: { ticket: t, code: "good-code#state" } })).body, { signedIn: true });
    assert.equal((await call("POST", "/signin/start", { body: { ticket: t } })).status, 409);
  });

  it("allows a new ticket to replace an unfinished sign-in", async () => {
    const t = ticket();
    const next = ticket(Number(t.split(".")[0]) + 1);
    assert.equal((await call("POST", "/signin/start", { body: { ticket: t } })).status, 200);
    assert.equal((await call("POST", "/signin/start", { body: { ticket: next } })).status, 200);
    assert.deepEqual((await call("POST", "/signin/code", { body: { ticket: next, code: "good-code#state" } })).body, { signedIn: true });
    assert.deepEqual(events(), ["login started BROWSER=true", "login started BROWSER=true", "login read good-code#state"]);
  });
});

describe("erase, with the fake CLI", () => {
  it("stops a sign-in in progress, so its code reaches no CLI", async () => {
    const t = ticket();
    assert.equal((await call("POST", "/signin/start", { body: { ticket: t } })).status, 200);
    assert.equal((await call("POST", "/erase", { auth: bearer, body: { epoch: 1 } })).status, 200);
    assert.deepEqual((await call("POST", "/signin/code", { body: { ticket: t, code: "good-code#state" } })).body, { error: "no_signin" });
    assert.deepEqual(events(), ["login started BROWSER=true"]);
  });

  it("kills a running turn's CLI before it erases, and the turn answers 502", async () => {
    signIn(true);
    const box = (await call("GET", "/health", { auth: bearer })).body.box;
    const held = call("POST", "/parse", { auth: bearer, body: { ...turn("hang"), box, epoch: 1 } });
    await waitFor(() => events().some((e) => e.startsWith("turn start")));
    const erased = await call("POST", "/erase", { auth: bearer, body: { epoch: 2 } });
    assert.deepEqual([erased.status, erased.body], [200, { box, floor: 2 }]);
    assert.deepEqual((await held).body, { error: "claude_failed" });
    assert.deepEqual(events().map((e) => e.split(" ").slice(0, 2).join(" ")), ["turn start"]);
  });
});
