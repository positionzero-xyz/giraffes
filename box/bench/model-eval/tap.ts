import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const [record, timeout, bin, ...args] = process.argv.slice(2);
const started = Date.now();
const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"] });
let firstTextMs: number | null = null;
let costUsd: number | null = null;
let models: string[] = [];
let killed = false;
let partial = "";

// A kill of this process doesn't reach the CLI on Windows, so the tap owns the timeout and kills the whole tree.
const timer = setTimeout(() => {
  killed = true;
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
  else child.kill("SIGKILL");
}, Number(timeout));

function read(line: string) {
  let e: unknown;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof e !== "object" || e === null) return;
  const event = e as { type?: string; message?: { content?: { type?: string; text?: string }[] }; total_cost_usd?: number; modelUsage?: Record<string, unknown> };
  if (firstTextMs === null && event.type === "assistant" && event.message?.content?.some((b) => b.type === "text" && b.text?.trim())) firstTextMs = Date.now() - started;
  if (event.type === "result") {
    costUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : null;
    models = Object.keys(event.modelUsage ?? {});
  }
}

child.stdout.on("data", (chunk: Buffer) => {
  process.stdout.write(chunk);
  const lines = (partial + chunk.toString("utf8")).split("\n");
  partial = lines.pop() ?? "";
  lines.forEach(read);
});
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
child.on("close", (code) => {
  clearTimeout(timer);
  read(partial);
  appendFileSync(record, `${JSON.stringify({ args: args.slice(0, 2), firstTextMs, wallMs: Date.now() - started, killed, costUsd, models })}\n`);
  process.exitCode = killed ? 124 : (code ?? 1);
});
