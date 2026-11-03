import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Cli = readonly [string, ...string[]];

export type ParseRequest = { readonly model: string; readonly system: string; readonly user: string; readonly jsonSchema: Record<string, unknown> };

export type Usage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number | null;
  readonly cache_read_input_tokens: number | null;
};

export type TurnReply =
  | { readonly status: 200; readonly body: { structured: unknown; usage: Usage | null; stop: "end" | "refusal" | "max_tokens"; costUsd: number | null } }
  | { readonly status: 409; readonly body: { error: "signed_out" } }
  | { readonly status: 502; readonly body: { error: "claude_failed" } };

export type AuthStatus = { readonly loggedIn: boolean; readonly authMethod: string };

const ALIAS: Readonly<Record<string, string>> = { "claude-haiku-5-5": "haiku", "claude-sonnet-5-5": "sonnet" };
const TURN_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 30_000;
// An empty working directory, so the CLI picks up no project files or settings.
const EMPTY_DIR = mkdtempSync(join(tmpdir(), "claude-cwd-"));

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function spawnClaude(cli: Cli, args: readonly string[], env: NodeJS.ProcessEnv = process.env): ChildProcessWithoutNullStreams {
  const [bin, ...prefix] = cli;
  const proc = spawn(bin, [...prefix, ...args], { cwd: EMPTY_DIR, env, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.on("error", () => {});
  return proc;
}

function runClaude(
  cli: Cli,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: null, stdout: "", stderr: "abandoned" });
    const proc = spawnClaude(cli, args);
    const kill = () => proc.kill("SIGKILL");
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    proc.on("error", (err) => (stderr += String(err)));
    proc.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({ code, stdout, stderr });
    });
    proc.stdin.end(stdin);
  });
}

export function readParseRequest(body: unknown): ParseRequest | null {
  if (!isObject(body) || !isObject(body.jsonSchema)) return null;
  const { model, system, user, jsonSchema } = body;
  if (typeof model !== "string" || typeof system !== "string" || typeof user !== "string") return null;
  return { model, system, user, jsonSchema };
}

export async function authStatus(cli: Cli): Promise<AuthStatus | null> {
  const run = await runClaude(cli, ["auth", "status", "--json"], "", STATUS_TIMEOUT_MS);
  const status = parseJson(run.stdout);
  if (!isObject(status) || typeof status.loggedIn !== "boolean") return null;
  return { loggedIn: status.loggedIn, authMethod: typeof status.authMethod === "string" ? status.authMethod : "unknown" };
}

export async function cliVersion(cli: Cli): Promise<string | null> {
  const run = await runClaude(cli, ["--version"], "", STATUS_TIMEOUT_MS);
  return run.code === 0 ? (run.stdout.trim().split(/\s+/)[0] ?? null) : null;
}

function usageOf(v: unknown): Usage | null {
  if (!isObject(v) || typeof v.input_tokens !== "number" || typeof v.output_tokens !== "number") return null;
  return {
    input_tokens: v.input_tokens,
    output_tokens: v.output_tokens,
    cache_creation_input_tokens: numOrNull(v.cache_creation_input_tokens),
    cache_read_input_tokens: numOrNull(v.cache_read_input_tokens),
  };
}

export async function parseTurn(cli: Cli, req: ParseRequest, signal?: AbortSignal): Promise<TurnReply> {
  // The CLI's validator doesn't load zod's draft 2020-12 meta-schema; the keywords zod emits validate without it.
  const { $schema: _, ...schema } = req.jsonSchema;
  const args = [
    "-p",
    "--model", ALIAS[req.model] ?? req.model,
    "--tools", "",
    "--system-prompt", req.system,
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--no-session-persistence",
    "--setting-sources", "",
    "--strict-mcp-config",
  ];
  const started = Date.now();
  const run = await runClaude(cli, args, req.user, TURN_TIMEOUT_MS, signal);
  if (signal?.aborted) {
    console.log(`${req.model} abandoned by the caller after ${Date.now() - started}ms`);
    return { status: 502, body: { error: "claude_failed" } };
  }
  const result = run.code === 0 ? parseJson(run.stdout) : undefined;
  if (!isObject(result) || result.is_error !== false) {
    const failed = parseJson(run.stdout);
    const subtype = isObject(failed) && typeof failed.subtype === "string" ? failed.subtype : "none";
    console.error(`claude -p failed (exit ${run.code}, subtype ${subtype}): ${run.stderr.slice(0, 300)}`);
    const status = await authStatus(cli);
    return status?.loggedIn === false ? { status: 409, body: { error: "signed_out" } } : { status: 502, body: { error: "claude_failed" } };
  }
  const costUsd = numOrNull(result.total_cost_usd);
  console.log(`${req.model} ${Date.now() - started}ms $${(costUsd ?? 0).toFixed(5)}`);
  return {
    status: 200,
    body: {
      structured: result.structured_output ?? null,
      usage: usageOf(result.usage),
      stop: result.stop_reason === "refusal" ? "refusal" : result.stop_reason === "max_tokens" ? "max_tokens" : "end",
      costUsd,
    },
  };
}
