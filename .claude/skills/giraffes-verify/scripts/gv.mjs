import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: gv <command> [args]        RUN_DIR=<scratch dir> is required for every command

  prepare [bridge|scripted] [--box]
                               write RUN_DIR config (with KEY_SECRET and PUBLIC_URL for /key),
                               load the D1 ledger schema (idempotent);
                               --box also points the Worker at one local box and writes RUN_DIR/box-token
  worker                       wrangler dev in the foreground; start it with run_in_background
  bridge                       claude -p bridge in the foreground; start it with run_in_background
  doctor [--wait sec]          read-only: is this instance ours, up, signed in, and answering? --wait polls until it is
  say <user> <text...>         send one dev-channel message as <user>; /follow and /block work
  snapshot <user> [name]       print the agent snapshot; with name, also save evidence/<name>.json
  wait <user> <js-expr> [sec]  poll the snapshot (as s) until the expression is truthy (default 120s)
  advance <user> <key> [min]   test-only: make a pending wake-up due now (or min minutes late)
  dosql <user> <sql> [params]  run SQL inside <user>'s Durable Object (reads and test-only writes)
  ledger <sql>                 query the local D1 ledger
  stop                         kill the worker and bridge trees this RUN_DIR started
  clean                        stop, then delete state and config; evidence/ survives

prepare reads WORKER_PORT (8797), BRIDGE_PORT (8799), INSPECTOR_PORT (9339), BOX_PORT (18790) and APP_DIR (repo app/).`;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const RUN = process.env.RUN_DIR ? path.resolve(process.env.RUN_DIR) : null;
const [cmd, ...args] = process.argv.slice(2);

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!cmd || cmd === "help" || cmd === "--help") die(USAGE);
if (!RUN) die("RUN_DIR is not set\n\n" + USAGE);

// From here on, exit through process.exitCode: process.exit while fetch sockets close trips a libuv assertion on Windows and exits 127.
class Fail extends Error {}
const fail = (msg) => {
  throw new Fail(msg);
};

const p = (...xs) => path.join(RUN, ...xs);
const EVIDENCE = p("evidence");
const STATE = p("state");

function run() {
  if (!existsSync(p("run.json"))) fail(`no ${p("run.json")}: run "gv prepare" first`);
  return JSON.parse(readFileSync(p("run.json"), "utf8"));
}

const wranglerJs = (app) => path.join(app, "node_modules", "wrangler", "bin", "wrangler.js");
const wranglerEnv = () => ({ ...process.env, WRANGLER_CACHE_DIR: p("wrangler-cache"), WRANGLER_SEND_METRICS: "false" });
const base = (r) => `http://127.0.0.1:${r.workerPort}`;

function portFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const STATIC_BOX = "gbox-static";
const boxToken = (secret) => createHmac("sha256", secret).update(`box:${STATIC_BOX}`).digest("base64url");
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const slash = (x) => x.replaceAll("\\", "/");

const pidOf = (name) => (existsSync(p(`${name}.pid`)) ? Number(readFileSync(p(`${name}.pid`), "utf8")) : null);

function killTree(name) {
  const pid = pidOf(name);
  if (pid === null) return;
  if (alive(pid)) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
    console.log(`stopped ${name} (pid ${pid})`);
  }
  rmSync(p(`${name}.pid`), { force: true });
}

/** Runs a child in the foreground, tees its output to evidence/<name>.log, and records this process as the tree root. */
function foreground(name, command, argv, opts) {
  const pid = pidOf(name);
  if (pid !== null && alive(pid)) fail(`${name} already running as pid ${pid}; run "gv stop" first`);
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(p(`${name}.pid`), String(process.pid));
  const log = createWriteStream(path.join(EVIDENCE, `${name}.log`), { flags: "a" });
  const child = spawn(command, argv, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (c) => {
      process.stdout.write(c);
      log.write(c);
    });
  }
  const forward = () => child.kill("SIGTERM");
  process.on("SIGTERM", forward);
  process.on("SIGINT", forward);
  child.on("exit", (code) => {
    rmSync(p(`${name}.pid`), { force: true });
    log.end(() => {
      process.exitCode = code ?? 0;
    });
  });
}

async function health(r) {
  const results = [];
  const probe = async (label, f) => {
    try {
      results.push(await f());
    } catch (err) {
      results.push([false, `${label}: ${err.cause?.code ?? err.message}`]);
    }
  };
  const wpid = pidOf("worker");
  results.push([wpid !== null && alive(wpid), `worker process ${wpid ?? "(no pidfile)"} alive`]);
  await probe(`GET ${base(r)}/dev`, async () => {
    const res = await fetch(`${base(r)}/dev`);
    const body = await res.text();
    return [res.ok && body.includes("<title>Agent dev chat</title>"), `GET ${base(r)}/dev -> ${res.status}`];
  });
  if (r.backend === "bridge") {
    const bpid = pidOf("bridge");
    results.push([bpid !== null && alive(bpid), `bridge process ${bpid ?? "(no pidfile)"} alive`]);
    await probe(`bridge on ${r.bridgePort}`, async () => {
      const res = await fetch(`http://127.0.0.1:${r.bridgePort}/parse`, { method: "POST", body: "{}" });
      return [res.status === 400, `POST bridge /parse with an empty body -> ${res.status} (want 400, no model call)`];
    });
  }
  if (r.boxPort) {
    await probe(`box on ${r.boxPort}`, async () => {
      const res = await fetch(`http://127.0.0.1:${r.boxPort}/health`, { headers: { authorization: `Bearer ${readFileSync(p("box-token"), "utf8").trim()}` } });
      const body = res.ok ? await res.json() : {};
      return [res.ok, `GET box /health -> ${res.status}${res.ok ? `, signedIn ${body.signedIn}` : ""}`];
    });
  }
  return results;
}

/** An expired login still lets `claude -p` exit 0, so ask the CLI itself. Prints no account details. */
function claudeSignedIn() {
  const res = spawnSync(CLAUDE, ["auth", "status", "--json"], { encoding: "utf8", timeout: 30_000 });
  if (res.error) return [false, `${CLAUDE} auth status: ${res.error.code ?? res.error.message}`];
  let loggedIn = false;
  try {
    loggedIn = JSON.parse(res.stdout).loggedIn === true;
  } catch {}
  return [res.status === 0 && loggedIn, `${CLAUDE} auth status -> exit ${res.status}, loggedIn ${loggedIn} (the bridge spends this login)`];
}

async function fetchSnapshot(r, user) {
  const res = await fetch(`${base(r)}/dev/transcript?user=${encodeURIComponent(user)}`);
  if (!res.ok) throw new Error(`GET /dev/transcript -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** Runs SQL inside the person's Durable Object through wrangler's local explorer API. */
async function doSql(r, user, sql, params) {
  const res = await fetch(`${base(r)}/cdn-cgi/local/explorer/api/workers/durable_objects/namespaces/giraffes-Agent/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ durable_object_name: `p:dev:${user}`, queries: [{ sql, params }] }),
  });
  const body = await res.json();
  if (!body.success) fail(`DO query failed: ${JSON.stringify(body.errors)}`);
  return body.result[0];
}

function d1(r, extra) {
  const res = spawnSync(
    process.execPath,
    [wranglerJs(r.appDir), "d1", "execute", "giraffes-ledger", "--local", "--persist-to", STATE, "-c", p("wrangler.jsonc"), ...extra],
    { cwd: RUN, env: wranglerEnv(), encoding: "utf8" },
  );
  if (res.status !== 0) fail(`wrangler d1 execute failed (exit ${res.status})\n${res.stdout}\n${res.stderr}`);
  return res.stdout;
}

const commands = {
  async prepare(...opts) {
    const box = opts.includes("--box");
    const backend = opts.find((o) => o !== "--box") ?? "bridge";
    if (backend !== "bridge" && backend !== "scripted") fail(`backend must be bridge or scripted, got ${backend}`);
    const appDir = path.resolve(process.env.APP_DIR ?? path.join(REPO, "app"));
    if (!existsSync(wranglerJs(appDir))) fail(`${wranglerJs(appDir)} missing: run "npm install" in ${appDir}`);
    const r = {
      appDir,
      backend,
      workerPort: Number(process.env.WORKER_PORT ?? 8797),
      bridgePort: Number(process.env.BRIDGE_PORT ?? 8799),
      inspectorPort: Number(process.env.INSPECTOR_PORT ?? 9339),
      ...(box ? { boxPort: Number(process.env.BOX_PORT ?? 18790) } : {}),
    };
    const boxDir = path.resolve(appDir, "..", "box");
    if (box && !existsSync(path.join(boxDir, "up.sh"))) fail(`${boxDir}/up.sh missing: point APP_DIR at a checkout that has box/`);
    for (const name of ["worker", "bridge"]) {
      const pid = pidOf(name);
      if (pid !== null && alive(pid)) fail(`${name} from this RUN_DIR is running (pid ${pid}); run "gv stop" before prepare`);
    }
    for (const port of [r.workerPort, r.bridgePort, r.inspectorPort]) {
      if (!(await portFree(port))) fail(`port ${port} is taken by another process; pick other WORKER_PORT/BRIDGE_PORT/INSPECTOR_PORT`);
    }
    mkdirSync(EVIDENCE, { recursive: true });
    const previous = existsSync(p(".dev.vars")) ? readFileSync(p(".dev.vars"), "utf8") : "";
    const keptVar = (name) => previous.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1];
    // A re-prepare keeps KEY_SECRET so keys sealed into this RUN_DIR's state still open.
    const vars = [
      `DEV_MODE=1`,
      `MODEL_BACKEND=${backend}`,
      ...(backend === "bridge" ? [`MODEL_BRIDGE_URL=http://127.0.0.1:${r.bridgePort}`] : []),
      `KEY_SECRET=${keptVar("KEY_SECRET") ?? randomBytes(32).toString("base64url")}`,
      `PUBLIC_URL=${base(r)}`,
    ];
    if (box) {
      const kept = keptVar("BOX_SECRET");
      if (!kept && !(await portFree(r.boxPort))) fail(`port ${r.boxPort} is taken by another process; pick another BOX_PORT`);
      const secret = kept ?? randomBytes(24).toString("base64url");
      vars.push("BOX_HOST=static", `BOX_SECRET=${secret}`, `BOX_STATIC_URL=http://127.0.0.1:${r.boxPort}`);
      writeFileSync(p("box-token"), boxToken(secret) + "\n", { mode: 0o600 });
    }
    writeFileSync(p("run.json"), JSON.stringify(r, null, 2));

    // A config outside app/ keeps wrangler's .wrangler/ tmp and state out of the checkout.
    let mains = 0;
    const config = readFileSync(path.join(appDir, "wrangler.jsonc"), "utf8").replace(/("main"\s*:\s*")([^"]+)(")/, (_, a, rel, b) => {
      mains++;
      return a + path.resolve(appDir, rel).replaceAll("\\", "/") + b;
    });
    if (mains !== 1) fail(`expected one "main" in ${appDir}/wrangler.jsonc`);
    writeFileSync(p("wrangler.jsonc"), config);
    writeFileSync(p(".dev.vars"), vars.join("\n") + "\n");
    d1(r, ["--file", path.join(appDir, "src", "ledger", "d1-schema.sql")]);
    console.log(`prepared ${RUN}\n${JSON.stringify(r, null, 2)}`);
    if (box) {
      console.log(`start the box with Docker before the worker:
  docker build -t giraffes-box:mvp ${slash(boxDir)}
  BOX_TOKEN=$(cat ${slash(p("box-token"))}) bash ${slash(path.join(boxDir, "up.sh"))} gbox-e2e ${r.boxPort} ${slash(p("boxdata"))} --mock`);
    }
  },

  async worker() {
    const r = run();
    foreground(
      "worker",
      process.execPath,
      [
        wranglerJs(r.appDir), "dev",
        "-c", p("wrangler.jsonc"),
        "--persist-to", STATE,
        "--ip", "127.0.0.1",
        "--port", String(r.workerPort),
        "--inspector-port", String(r.inspectorPort),
        "--show-interactive-dev-session=false",
      ],
      { cwd: RUN, env: wranglerEnv() },
    );
  },

  async bridge() {
    const r = run();
    if (r.backend !== "bridge") fail(`this RUN_DIR was prepared with backend ${r.backend}; the worker will not call a bridge`);
    foreground("bridge", process.execPath, [path.join(r.appDir, "dev", "bridge.ts")], {
      cwd: RUN,
      env: { ...process.env, BRIDGE_PORT: String(r.bridgePort) },
    });
  },

  async doctor(flag, seconds = "60") {
    const r = run();
    const deadline = Date.now() + (flag === "--wait" ? Number(seconds) * 1000 : 0);
    const login = r.backend === "bridge" ? [claudeSignedIn()] : [];
    let results;
    for (;;) {
      results = [...(await health(r)), ...login];
      if (results.every(([pass]) => pass) || Date.now() > deadline) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    console.log(`run ${RUN} app ${r.appDir} backend ${r.backend}${r.boxPort ? ` box ${r.boxPort}` : ""}`);
    for (const [pass, msg] of results) console.log(`${pass ? "ok  " : "FAIL"} ${msg}`);
    process.exitCode = results.every(([pass]) => pass) ? 0 : 1;
  },

  async say(user, ...words) {
    const r = run();
    const text = words.join(" ");
    if (!user || !text) fail("usage: gv say <user> <text...>");
    const id = `gv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${base(r)}/webhook/dev`, { method: "POST", body: JSON.stringify({ user, text, id }) });
    const body = await res.text();
    console.log(`${res.status} ${body} id=${id} user=${user} text=${JSON.stringify(text)}`);
    if (!res.ok) process.exitCode = 1;
  },

  async snapshot(user, name) {
    if (!user) fail("usage: gv snapshot <user> [name]");
    const s = JSON.stringify(await fetchSnapshot(run(), user), null, 2);
    if (name) {
      mkdirSync(EVIDENCE, { recursive: true });
      writeFileSync(path.join(EVIDENCE, `${name}.json`), s + "\n");
    }
    console.log(s);
  },

  async wait(user, expr, seconds = "120") {
    if (!user || !expr) fail("usage: gv wait <user> <js-expr over s> [seconds]");
    const r = run();
    const pred = new Function("s", `return (${expr});`);
    const deadline = Date.now() + Number(seconds) * 1000;
    let s = null;
    for (;;) {
      s = await fetchSnapshot(r, user);
      if (pred(s)) break;
      if (Date.now() > deadline) {
        console.log(JSON.stringify(s, null, 2));
        fail(`timed out after ${seconds}s waiting for: ${expr}`);
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    console.log(JSON.stringify(s, null, 2));
  },

  async dosql(user, sql, params = "[]") {
    if (!user || !sql) fail("usage: gv dosql <user> <sql> [params-json]");
    console.log(JSON.stringify(await doSql(run(), user, sql, JSON.parse(params)), null, 2));
  },

  async advance(user, key, minutesLate = "0") {
    if (!user || !key) fail("usage: gv advance <user> <wakeup-key> [minutes-late]");
    const due = Date.now() - 1000 - Number(minutesLate) * 60_000;
    const r = await doSql(run(), user, "UPDATE wakeup SET due_at = ? WHERE key = ? AND status = 'pending'", [due, key]);
    if (r.meta.rows_written === 0) fail(`no pending wake-up "${key}" for ${user}`);
    console.log(`wake-up "${key}" for ${user} now due ${new Date(due).toISOString()}; it fires on the agent's next drain (send any message)`);
  },

  async ledger(sql) {
    if (!sql) fail("usage: gv ledger <sql>");
    process.stdout.write(d1(run(), ["--json", "--command", sql]));
  },

  async stop() {
    killTree("worker");
    killTree("bridge");
    if (!existsSync(p("run.json"))) return;
    const r = run();
    for (const port of [r.workerPort, r.bridgePort, r.inspectorPort]) {
      if (!(await portFree(port))) fail(`port ${port} is still taken after stop`);
    }
    console.log(`ports ${r.workerPort} ${r.bridgePort} ${r.inspectorPort} free`);
  },

  async clean() {
    await commands.stop();
    for (const f of ["state", "wrangler-cache", ".wrangler", "wrangler.jsonc", ".dev.vars", "run.json", "box-token"]) rmSync(p(f), { recursive: true, force: true });
    console.log(`cleaned ${RUN}; evidence kept in ${EVIDENCE}`);
  },
};

try {
  if (!(cmd in commands)) fail(`unknown command ${cmd}\n\n${USAGE}`);
  await commands[cmd](...args);
} catch (err) {
  if (!(err instanceof Fail)) throw err;
  console.error(err.message);
  process.exitCode = 1;
}
