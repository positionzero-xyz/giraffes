/** A Worker can't spawn processes, so the Worker's `bridgeModel` POSTs here. */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { z } from "zod";

const PORT = Number(process.env.BRIDGE_PORT ?? 8789);
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const ALIAS: Readonly<Record<string, string>> = { "claude-haiku-5-5": "haiku", "claude-sonnet-5-5": "sonnet" };

const ParseRequest = z.object({ model: z.string(), system: z.string(), user: z.string(), jsonSchema: z.record(z.string(), z.unknown()) });
const CliResult = z.object({
  is_error: z.boolean(),
  structured_output: z.unknown().optional(),
  stop_reason: z.string().nullish(),
  total_cost_usd: z.number().nullish(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
    })
    .nullish(),
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function runClaude(args: readonly string[], stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // An empty working directory, so the CLI picks up no project files or settings.
    const proc = spawn(CLAUDE, args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end(stdin);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST" || req.url !== "/parse") return json(res, 404, { error: "POST /parse only" });
  const parsed = ParseRequest.safeParse(JSON.parse(await readBody(req)));
  if (!parsed.success) return json(res, 400, { error: parsed.error.message });
  const { model, system, user, jsonSchema } = parsed.data;
  // The CLI's validator doesn't load zod's draft 2020-12 meta-schema; the keywords zod emits validate without it.
  const { $schema: _, ...schema } = jsonSchema;

  const args = [
    "-p",
    "--model", ALIAS[model] ?? model,
    "--tools", "",
    "--system-prompt", system,
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--no-session-persistence",
    "--setting-sources", "",
    "--strict-mcp-config",
  ];
  const started = Date.now();
  const run = await runClaude(args, user);
  const result = run.code === 0 ? CliResult.safeParse(JSON.parse(run.stdout)) : null;
  if (!result?.success || result.data.is_error) {
    console.error(`claude -p failed (exit ${run.code}): ${run.stderr || run.stdout}`.slice(0, 2000));
    return json(res, 502, { error: "claude -p failed" });
  }
  const d = result.data;
  console.log(`${model} ${Date.now() - started}ms $${(d.total_cost_usd ?? 0).toFixed(5)}`);
  json(res, 200, {
    structured: d.structured_output ?? null,
    usage: d.usage ?? null,
    stop: d.stop_reason === "refusal" ? "refusal" : d.stop_reason === "max_tokens" ? "max_tokens" : "end",
    costUsd: d.total_cost_usd ?? null,
  });
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: String(err) });
  });
}).listen(PORT, HOST, () => console.log(`claude bridge on http://${HOST}:${PORT}`));
