// Regression: gv say must refuse to post when the bridge login cannot be checked,
// even when the worker and bridge fixtures answer healthy on loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GV = join(dirname(fileURLToPath(import.meta.url)), "gv.mjs");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function fixture(backend) {
  const run = mkdtempSync(join(tmpdir(), "gv-say-gate-"));
  let posts = 0;
  const worker = createServer((req, res) => {
    if (req.url === "/dev") {
      res.writeHead(200, { "content-type": "text/html" }).end("<html><head><title>Agent dev chat</title></head></html>");
    } else if (req.url === "/webhook/dev") {
      posts++;
      res.writeHead(200).end("posted");
    } else {
      res.writeHead(404).end();
    }
  });
  const bridge = createServer((req, res) => {
    res.writeHead(req.url === "/parse" ? 400 : 404).end();
  });
  const workerPort = await listen(worker);
  const bridgePort = await listen(bridge);
  writeFileSync(join(run, "run.json"), JSON.stringify({ appDir: run, backend, workerPort, bridgePort, inspectorPort: 1 }));
  writeFileSync(join(run, "worker.pid"), String(process.pid));
  writeFileSync(join(run, "bridge.pid"), String(process.pid));
  return { run, posts: () => posts, close: () => { worker.close(); bridge.close(); rmSync(run, { recursive: true, force: true }); } };
}

// Async on purpose: the fixture servers live in this process, and a synchronous spawn
// would freeze the loop that has to answer gv's health probes.
function say(run, extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [GV, "say", "review", "test"], {
      env: { ...process.env, RUN_DIR: run, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", reject);
    proc.on("close", (status) => resolve({ status, stdout, stderr }));
    setTimeout(() => { proc.kill(); reject(new Error(`gv say timed out: ${stdout} ${stderr}`)); }, 25_000).unref();
  });
}

test("say posts nothing and exits nonzero when the bridge login cannot be checked", async () => {
  const f = await fixture("bridge");
  try {
    const missing = join(f.run, "no-such-claude-binary");
    const r = await say(f.run, { CLAUDE_BIN: missing });
    assert.notEqual(r.status, 0, `expected nonzero exit, got ${r.status}: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /refusing to drive an unhealthy run/);
    assert.equal(f.posts(), 0, "the webhook counted a post it should never have received");
  } finally {
    f.close();
  }
});

test("say still posts on a healthy scripted run, which needs no claude login", async () => {
  const f = await fixture("scripted");
  try {
    const r = await say(f.run, { CLAUDE_BIN: join(f.run, "no-such-claude-binary") });
    assert.equal(r.status, 0, `expected exit 0: ${r.stdout}\n${r.stderr}`);
    assert.equal(f.posts(), 1);
  } finally {
    f.close();
  }
});
