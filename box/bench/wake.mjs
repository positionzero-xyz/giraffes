import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const [name, port, runs, outFile, fixture] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4]), process.argv[5], process.argv[6]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bridgeUp() {
  try { return (await fetch(`http://127.0.0.1:${port}/parse`, { method: "POST", body: "{}" })).status === 400; } catch { return false; }
}

for (let i = 1; i <= runs; i++) {
  execFileSync("docker", ["stop", "-t", "1", name]);
  const t0 = Date.now();
  execFileSync("docker", ["start", name]);
  const started = Date.now();
  while (!(await bridgeUp())) await sleep(5);
  const listening = Date.now();
  execFileSync("docker", ["exec", "-d", "-u", "root", name, "node", "/box/mock-api.mjs", "/work/mock.log", "8788", "/work/dump"]);
  await sleep(300);
  const t1 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/parse`, { method: "POST", headers: { "content-type": "application/json" }, body: readFileSync(fixture) });
  const body = await res.json();
  const t2 = Date.now();
  const row = { plan: "wake", run: i, side: "docker-start", ok: res.status === 200 && body.structured?.actions?.[0]?.type === "send", dockerStartMs: started - t0, startToBridgeMs: listening - t0, firstTurnMs: t2 - t1 };
  appendFileSync(outFile, JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));
}
