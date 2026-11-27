import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const UP = fileURLToPath(new URL("../up.sh", import.meta.url));
const shPath = (path: string) => path.replaceAll("\\", "/");

test("up.sh --script creates the dump folder and passes the script", (t) => {
  const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (bash.error) {
    t.skip("bash is not installed");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "box-up-"));
  const bin = join(dir, "bin");
  const data = join(dir, "data");
  const log = join(dir, "docker.log");
  const script = join(dir, "script.json");
  const scriptText = JSON.stringify({ calls: [], text: "Noted." });
  mkdirSync(bin);
  writeFileSync(script, scriptText);
  const docker = join(bin, "docker");
  writeFileSync(docker, `#!/usr/bin/env bash
cmd=$1
shift || true
{
  printf '%s' "$cmd"
  for arg in "$@"; do printf '\\t%s' "$arg"; done
  printf '\\n'
} >> "$FAKE_DOCKER_LOG"
if [ "$cmd" = logs ]; then echo "box on"; fi
`);
  chmodSync(docker, 0o755);

  let hostDump: string | null = null;
  t.after(() => {
    if (hostDump !== null) rmSync(hostDump, { recursive: true, force: true });
  });
  const run = spawnSync("bash", [shPath(UP), "gbox-test", "18791", shPath(data), "--mock", "--script", shPath(script)], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      BOX_TOKEN: "box-test-token",
      FAKE_DOCKER_LOG: shPath(log),
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => line.split("\t"));
  const dockerRun = calls.find((call) => call[0] === "run");
  assert.ok(dockerRun, `no docker run in ${readFileSync(log, "utf8")}`);
  const mount = dockerRun.findIndex((arg, i) => arg === "-v" && dockerRun[i + 1]?.endsWith(":/dumps"));
  assert.notEqual(mount, -1, `no /dumps mount in ${dockerRun.join(" ")}`);
  hostDump = dockerRun[mount + 1].slice(0, -":/dumps".length);
  assert.equal(readFileSync(join(hostDump, "mock-script.json"), "utf8"), scriptText);

  const dockerExec = calls.find((call) => call[0] === "exec");
  assert.ok(dockerExec, `no docker exec in ${readFileSync(log, "utf8")}`);
  const nodeAt = dockerExec.indexOf("node");
  assert.deepEqual(dockerExec.slice(nodeAt, nodeAt + 6), ["node", "/box/mock-api.mjs", "/dumps/mock.log", "8788", "/dumps", "/dumps/mock-script.json"]);
});
