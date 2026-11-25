import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: null, stdout: "", stderr: "abandoned" });
    const proc = spawnClaude(cli, args, env);
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

export type AgentTool = { readonly name: string; readonly description: string; readonly inputSchema: Json };
export type AgentRequest = {
  readonly model: string;
  readonly append: string;
  readonly session: string | null | undefined;
  readonly turn: string;
  readonly fresh: string | null;
  readonly tools: readonly AgentTool[];
};
export type SessionUsed = { readonly id: string; readonly resumed: boolean };
export type AgentCall = { readonly name: string; readonly input: Json };
type ToolCalls = { readonly calls: AgentCall[]; readonly refusedCalls: (AgentCall & { readonly problems: string[] })[] };
export type AgentReply =
  | { readonly status: 200; readonly body: ToolCalls & { text: string; session: SessionUsed; usage: Usage | null; stop: "end" | "refusal" | "max_tokens"; costUsd: number | null } }
  | { readonly status: 409; readonly body: { error: "signed_out" } }
  | { readonly status: 502; readonly body: { error: "claude_failed" } };

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TOOL_PREFIX = "mcp__giraffe__";
const MCP_SERVER = fileURLToPath(new URL("./giraffe-mcp.ts", import.meta.url).href);

export function readAgentRequest(body: unknown): AgentRequest | null {
  if (!isObject(body) || !Array.isArray(body.tools)) return null;
  const { model, append, turn } = body;
  if (typeof model !== "string" || typeof append !== "string" || typeof turn !== "string" || !turn.trim()) return null;
  const session = body.session;
  if (session !== undefined && session !== null && (typeof session !== "string" || !SESSION_ID.test(session))) return null;
  const fresh = body.fresh ?? null;
  if (fresh !== null && (typeof fresh !== "string" || !fresh.trim())) return null;
  const tools: AgentTool[] = [];
  for (const t of body.tools) {
    if (!isObject(t) || typeof t.name !== "string" || !/^[a-z_]{1,40}$/.test(t.name) || typeof t.description !== "string" || !isObject(t.inputSchema)) return null;
    tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
  }
  return { model, append, session, turn, fresh, tools };
}

function toolProblems(content: unknown): string[] {
  if (typeof content !== "string") return ["Tool call failed"];
  const result = parseJson(content);
  if (isObject(result) && Array.isArray(result.problems) && result.problems.every((problem) => typeof problem === "string")) return result.problems;
  return [content];
}

function toolCalls(events: readonly Json[]): ToolCalls {
  const byId = new Map<string, AgentCall>();
  const results = new Map<string, Json>();
  for (const e of events) {
    const message = isObject(e.message) ? e.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (!isObject(block)) continue;
      if (e.type === "assistant" && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && block.name.startsWith(TOOL_PREFIX)) {
        byId.set(block.id, { name: block.name.slice(TOOL_PREFIX.length), input: isObject(block.input) ? block.input : {} });
      }
      if (e.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") results.set(block.tool_use_id, block);
    }
  }
  const out: ToolCalls = { calls: [], refusedCalls: [] };
  for (const [id, call] of byId) {
    const result = results.get(id);
    if (!result) continue;
    if (result.is_error === true) out.refusedCalls.push({ ...call, problems: toolProblems(result.content) });
    else out.calls.push(call);
  }
  return out;
}

function agentArgs(req: AgentRequest, toolsFile: string, session: { readonly id: string; readonly resume: boolean }): string[] {
  const mcp = { mcpServers: { giraffe: { type: "stdio", command: process.execPath, args: [MCP_SERVER, toolsFile] } } };
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", ALIAS[req.model] ?? req.model,
    "--tools", "",
    "--append-system-prompt", req.append,
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify(mcp),
    "--allowedTools", req.tools.map((t) => `${TOOL_PREFIX}${t.name}`).join(","),
    "--setting-sources", "",
    ...(session.resume ? ["--resume", session.id] : ["--session-id", session.id]),
  ];
}

/** Read per turn, after main.ts has removed BOX_TOKEN from the environment. */
const agentEnv = (): NodeJS.ProcessEnv => ({ ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_CRON: "1", DISABLE_AUTOUPDATER: "1" });

/**
 * One turn of the person's own Claude Code session: Claude Code keeps its system prompt and gets ours appended, has no
 * built-in tools, and acts only through Giraffe's tools, which answer "noted". The Worker applies the calls.
 */
export async function agentTurn(cli: Cli, req: AgentRequest, signal?: AbortSignal): Promise<AgentReply> {
  const toolsFile = join(mkdtempSync(join(tmpdir(), "giraffe-tools-")), "tools.json");
  writeFileSync(toolsFile, JSON.stringify(req.tools));
  const started = Date.now();
  const startNew = () => ({ id: randomUUID(), resume: false });
  let session = req.session ? { id: req.session, resume: true } : startNew();
  const input = () => `${JSON.stringify({ type: "user", message: { role: "user", content: session.resume ? req.turn : (req.fresh ?? req.turn) } })}\n`;
  let run = await runClaude(cli, agentArgs(req, toolsFile, session), input(), TURN_TIMEOUT_MS, signal, agentEnv());
  if (session.resume && /No conversation found with session ID/.test(run.stdout + run.stderr)) {
    console.log("session not found on this box, starting a new one");
    session = startNew();
    run = await runClaude(cli, agentArgs(req, toolsFile, session), input(), TURN_TIMEOUT_MS, signal, agentEnv());
  }
  rmSync(dirname(toolsFile), { recursive: true, force: true });
  if (signal?.aborted) return { status: 502, body: { error: "claude_failed" } };
  const events = run.stdout.split("\n").map(parseJson).filter(isObject);
  const result = events.findLast((e) => e.type === "result");
  if (run.code !== 0 || !result || result.is_error !== false) {
    const subtype = typeof result?.subtype === "string" ? result.subtype : "none";
    console.error(`agent turn failed (exit ${run.code}, subtype ${subtype}): ${run.stderr.slice(0, 300)}`);
    const status = await authStatus(cli);
    return status?.loggedIn === false ? { status: 409, body: { error: "signed_out" } } : { status: 502, body: { error: "claude_failed" } };
  }
  const costUsd = numOrNull(result.total_cost_usd);
  console.log(`${req.model} agent ${Date.now() - started}ms $${(costUsd ?? 0).toFixed(5)}`);
  return {
    status: 200,
    body: {
      text: typeof result.result === "string" ? result.result : "",
      ...toolCalls(events),
      session: { id: session.id, resumed: session.resume },
      usage: usageOf(result.usage),
      stop: result.stop_reason === "refusal" ? "refusal" : result.stop_reason === "max_tokens" ? "max_tokens" : "end",
      costUsd,
    },
  };
}
