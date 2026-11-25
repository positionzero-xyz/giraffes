import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const [record, timeout, bin, ...args] = process.argv.slice(2);
const started = Date.now();
const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"] });
let firstTextMs: number | null = null;
let costUsd: number | null = null;
let usage: unknown = null;
let models: string[] = [];
let killed = false;
let partial = "";

// A kill of this process doesn't reach the CLI on Windows, so the tap owns the timeout and kills the whole tree.
const timer = setTimeout(() => {
  killed = true;
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)]);
  else child.kill("SIGKILL");
}, Number(timeout));

type Event = {
  type?: string;
  message?: { content?: { type?: string; text?: string }[] };
  item?: { type?: string; text?: string };
  total_cost_usd?: number;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  modelUsage?: Record<string, unknown>;
};

function read(line: string) {
  let e: unknown;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof e !== "object" || e === null) return;
  const event = e as Event;
  const claudeText = event.type === "assistant" && event.message?.content?.some((b) => b.type === "text" && b.text?.trim());
  const codexText = event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text?.trim();
  if (firstTextMs === null && (claudeText || codexText)) firstTextMs = Date.now() - started;
  if (event.type === "result") {
    costUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : null;
    usage = typeof event.usage?.input_tokens === "number" && typeof event.usage.output_tokens === "number" ? event.usage : null;
    models = Object.keys(event.modelUsage ?? {});
  }
}

const decoder = new StringDecoder("utf8");
child.stdout.on("data", (chunk: Buffer) => {
  process.stdout.write(chunk);
  const lines = (partial + decoder.write(chunk)).split("\n");
  partial = lines.pop() ?? "";
  lines.forEach(read);
});
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
child.on("close", (code) => {
  clearTimeout(timer);
  read(partial + decoder.end());
  appendFileSync(record, `${JSON.stringify({ args: args.slice(0, 2), firstTextMs, wallMs: Date.now() - started, killed, costUsd, usage, models })}\n`);
  process.exitCode = killed ? 124 : (code ?? 1);
});
