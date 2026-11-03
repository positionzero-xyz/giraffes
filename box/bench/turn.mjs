import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { watchTree } from "./proc-tree.mjs";

const [plan, runs, outFile] = [process.argv[2], Number(process.argv[3] ?? 7), process.argv[4]];
const MOCK_LOG = "/work/mock.log";
const LAUNCH_LOG = "/work/launch.log";

function startBridge(port, keepTools) {
  const proc = spawn("node", ["/opt/bridge/bridge.ts"], {
    env: { ...process.env, BRIDGE_PORT: String(port), BRIDGE_HOST: "127.0.0.1", CLAUDE_BIN: "/box/bench/claude-launch.sh", BENCH_LAUNCH_LOG: LAUNCH_LOG, BENCH_KEEP_TOOLS: keepTools ? "1" : "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve) => proc.stdout.on("data", (c) => { if (String(c).includes("claude bridge on")) resolve({ proc, port }); }));
}

const lines = (path) => { try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

function validTurn(s) {
  return s && Array.isArray(s.actions) && s.actions[0]?.type === "send" && s.actions[0].text.startsWith("mock reply to:")
    && ["chat", "reminder", "plan", "booking", "site", "group", "other"].includes(s.task?.kind);
}

async function turn(bridge, fixture, sample) {
  const mockBefore = lines(MOCK_LOG).length;
  const launchBefore = lines(LAUNCH_LOG).length;
  const stop = sample ? watchTree(bridge.proc.pid, false) : null;
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${bridge.port}/parse`, { method: "POST", headers: { "content-type": "application/json" }, body: readFileSync(fixture) });
  const reply = await res.json().catch(() => null);
  const t1 = Date.now();
  const mem = stop?.();
  const reqs = lines(MOCK_LOG).slice(mockBefore).map((l) => JSON.parse(l));
  const launch = Number(lines(LAUNCH_LOG).slice(launchBefore)[0]);
  const messages = reqs.filter((r) => r.path === "/v1/messages");
  return {
    status: res.status, ok: res.status === 200 && validTurn(reply?.structured),
    wallMs: t1 - t0, launchToFirstRequestMs: messages[0] ? messages[0].t - launch : null,
    requests: reqs.length, messageRequests: messages.length, bytes: reqs.map((r) => r.bytes), tools: messages[0]?.tools,
    ...(mem ? { peakTreePssKb: mem.pssKb, peakTreeRssKb: mem.rssKb, maxVmHwmKb: mem.maxVmHwmKb, peakPids: mem.pids, comms: mem.comms, samples: mem.samples } : {}),
  };
}

const sides = {
  mem: [["small", "/work/fx-small.json", false, true], ["large", "/work/fx-large.json", false, true]],
  time: [["small", "/work/fx-small.json", false, false], ["large", "/work/fx-large.json", false, false]],
  bytes: [["tools-none", "/work/fx-small.json", false, false], ["tools-default", "/work/fx-small.json", true, false]],
}[plan];

const bridges = { false: await startBridge(8791, false), true: await startBridge(8792, true) };
process.on("exit", () => { for (const b of Object.values(bridges)) b.proc.kill(); });
for (let i = 0; i < runs; i++) {
  for (const [label, fixture, keepTools, sample] of sides) {
    const r = await turn(bridges[keepTools], fixture, sample);
    const row = { plan, run: i + 1, side: label, ...r };
    appendFileSync(outFile, JSON.stringify(row) + "\n");
    console.log(JSON.stringify(row));
  }
}
for (const b of Object.values(bridges)) b.proc.kill();
