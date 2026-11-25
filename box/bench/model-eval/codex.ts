import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "../../src/claude.ts";

export const PROFILE = "pool";
export const KEY_ENV = "GIRAFFE_EVAL_CODEX_KEY";
export const CODEX_EFFORTS = ["default", "low", "medium", "high", "xhigh"] as const;

export type CodexMode = "turn" | "build";
export type Pool = { readonly profile: string; readonly provider: string; readonly table: string; readonly secretToken: string | null };
export type Mcp = { readonly command: string; readonly args: readonly string[] };
export type CodexCall = { readonly name: string; readonly input: Record<string, unknown> };
export type CodexFailure = { readonly kind: "usage_limit" | "failed"; readonly message: string };
export type CodexTurn = {
  readonly text: string;
  readonly calls: readonly CodexCall[];
  readonly refusedCalls: readonly (CodexCall & { readonly problems: readonly string[] })[];
  readonly otherTools: readonly string[];
  readonly usage: Usage | null;
  readonly failure: CodexFailure | null;
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const toml = (s: string) => JSON.stringify(s);

export function readPool(codexHome: string): Pool {
  const profile = readFileSync(join(codexHome, `${PROFILE}.config.toml`), "utf8");
  const provider = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(profile)?.[1];
  if (!provider) throw new Error(`${PROFILE}.config.toml names no model_provider`);
  const lines = readFileSync(join(codexHome, "config.toml"), "utf8").split(/\r?\n/);
  const own = (header: string) => header === `[model_providers.${provider}]` || header.startsWith(`[model_providers.${provider}.`);
  const table: string[] = [];
  let secretToken: string | null = null;
  let inside = false;
  for (const line of lines) {
    const header = /^\s*\[/.test(line) ? line.trim() : null;
    if (header !== null) inside = own(header);
    if (!inside) continue;
    const token = /^\s*experimental_bearer_token\s*=\s*"([^"]*)"/.exec(line);
    if (token) secretToken = token[1];
    else table.push(line);
  }
  if (table.length === 0) throw new Error(`config.toml has no [model_providers.${provider}]`);
  if (secretToken !== null) table.splice(1, 0, `env_key = ${toml(KEY_ENV)}`);
  return { profile, provider, table: table.join("\n").trim(), secretToken };
}

const ISOLATION = `include_permissions_instructions = false
include_collaboration_mode_instructions = false
include_apps_instructions = false
web_search = "disabled"

[skills]
include_instructions = false

[skills.bundled]
enabled = false

[agents]
enabled = false

[features]
shell_tool = false
sleep_tool = false
goals = false
apps = false
plugins = false
image_generation = false
tool_suggest = false
browser_use = false
computer_use = false
hooks = false`;

const MCP_SERVER = fileURLToPath(new URL("../../src/giraffe-mcp.ts", import.meta.url));

export const giraffeMcp = (toolsFile: string): Mcp => ({ command: process.execPath, args: [MCP_SERVER, toolsFile] });

/**
 * Without a Windows sandbox mode Codex runs workspace-write as read-only. The person's own "elevated" mode keeps its
 * setup and sandbox-user secrets in their Codex home, so a fresh home uses the mode that needs no setup.
 */
const WINDOWS_SANDBOX = `[windows]
sandbox = "unelevated"`;

const onPlainHttp = (table: string, url: string) =>
  table.replace(/^\s*base_url\s*=.*$/m, `base_url = ${toml(url)}`).replace(/^\s*supports_websockets\s*=.*$/m, "supports_websockets = false");

export function homeConfig(pool: Pool, instructions: string, mcp: Mcp | null, plainHttpServer?: string): string {
  const table = plainHttpServer ? onPlainHttp(pool.table, plainHttpServer) : pool.table;
  const parts = [`developer_instructions = ${toml(instructions)}`, ISOLATION, table];
  if (mcp) {
    parts.push(`[mcp_servers.giraffe]
command = ${toml(mcp.command)}
args = [${mcp.args.map(toml).join(", ")}]
omit_tools_from = ["code_mode", "deferred"]
default_tools_approval_mode = "approve"`);
  } else {
    parts.push(`[sandbox_workspace_write]
network_access = false`);
    if (process.platform === "win32") parts.push(WINDOWS_SANDBOX);
  }
  return `${parts.join("\n\n")}\n`;
}

export function writeHome(dir: string, pool: Pool, config: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), config);
  writeFileSync(join(dir, `${PROFILE}.config.toml`), pool.profile);
  return dir;
}

/** Codex also reads skills from the person's own home folder (~/.agents/skills), so the child gets an empty one. */
export function codexEnv(home: string, user: string, secretToken: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CODEX_") && k !== "OPENAI_API_KEY" && k !== KEY_ENV) env[k] = v;
  mkdirSync(user, { recursive: true });
  return { ...env, CODEX_HOME: home, USERPROFILE: user, HOME: user, ...(secretToken === null ? {} : { [KEY_ENV]: secretToken }) };
}

export function codexArgs(model: string, effort: string, mode: CodexMode, cwd: string): string[] {
  return [
    "--profile", PROFILE,
    "exec",
    "-m", model,
    ...(effort === "default" ? [] : ["-c", `model_reasoning_effort="${effort}"`]),
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-rules",
    "-s", mode === "build" ? "workspace-write" : "read-only",
    "-C", cwd,
    "-",
  ];
}

function problemsOf(item: Json): string[] {
  if (isObject(item.error) && typeof item.error.message === "string") return [item.error.message];
  const content = isObject(item.result) && Array.isArray(item.result.content) ? item.result.content : [];
  const text = content.flatMap((c) => (isObject(c) && typeof c.text === "string" ? [c.text] : [])).join("\n");
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) && Array.isArray(parsed.problems)) return parsed.problems.map(String);
  } catch {}
  return [text || "Tool call failed"];
}

const USAGE_LIMIT = /usage limit/i;

/** Codex's input_tokens includes the cached part; Claude's Usage excludes it. */
function usageOf(u: unknown): Usage | null {
  if (!isObject(u) || typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") return null;
  const cached = typeof u.cached_input_tokens === "number" ? u.cached_input_tokens : 0;
  return {
    input_tokens: u.input_tokens - cached,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: typeof u.cache_write_input_tokens === "number" ? u.cache_write_input_tokens : null,
    cache_read_input_tokens: cached,
  };
}

export function parseCodexJsonl(stdout: string): CodexTurn {
  const texts: string[] = [];
  const calls: CodexCall[] = [];
  const refusedCalls: (CodexCall & { problems: string[] })[] = [];
  const otherTools: string[] = [];
  let usage: Usage | null = null;
  let failure: CodexFailure | null = null;
  let completed = false;
  for (const line of stdout.split("\n")) {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(e)) continue;
    if (e.type === "turn.completed") {
      completed = true;
      usage = usageOf(e.usage);
    }
    if (e.type === "turn.failed" || e.type === "error") {
      const message = isObject(e.error) && typeof e.error.message === "string" ? e.error.message : typeof e.message === "string" ? e.message : "turn failed";
      failure ??= { kind: USAGE_LIMIT.test(message) ? "usage_limit" : "failed", message };
    }
    if (e.type !== "item.completed" || !isObject(e.item)) continue;
    const item = e.item;
    if (item.type === "agent_message" && typeof item.text === "string") texts.push(item.text);
    else if (item.type === "mcp_tool_call" && item.server === "giraffe" && typeof item.tool === "string") {
      const call = { name: item.tool, input: isObject(item.arguments) ? item.arguments : {} };
      if (item.status === "completed") calls.push(call);
      else refusedCalls.push({ ...call, problems: problemsOf(item) });
    } else if (item.type === "mcp_tool_call") otherTools.push(`${String(item.server)}/${String(item.tool)}`);
    else if (item.type !== "reasoning" && item.type !== "error") otherTools.push(String(item.type));
  }
  if (!completed && !failure) failure = { kind: "failed", message: "no turn.completed event" };
  return { text: texts.at(-1) ?? "", calls, refusedCalls, otherTools, usage, failure };
}

export function toolsOfRequest(body: unknown): string[] {
  if (!isObject(body)) return [];
  const names: string[] = [];
  const add = (tools: unknown, prefix: string) => {
    for (const t of Array.isArray(tools) ? tools : []) {
      if (!isObject(t)) continue;
      const name = `${prefix}${String(t.name ?? t.type)}`;
      if (t.type === "namespace") add(t.tools, name === "functions" ? "" : `${name}/`);
      else names.push(name);
      if (t.name === "exec" && typeof t.description === "string") for (const m of t.description.matchAll(/^### `([^`]+)`/gm)) names.push(`exec/${m[1]}`);
    }
  };
  add(body.tools, "");
  for (const item of Array.isArray(body.input) ? body.input : []) if (isObject(item) && item.type === "additional_tools") add(item.tools, "");
  return names;
}

export type Inventory = { readonly tools: readonly string[]; readonly writesWorkspace: boolean };

const sameDir = (a: string, b: string) => a.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() === b.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

export function inventoryOf(body: unknown, cwd: string): Inventory {
  const input = isObject(body) && Array.isArray(body.input) ? body.input : [];
  const context = input.flatMap((i) => (isObject(i) && Array.isArray(i.content) ? i.content : [])).map((c) => (isObject(c) && typeof c.text === "string" ? c.text : "")).find((t) => t.includes("<environment_context>")) ?? "";
  const writes = [...context.matchAll(/<entry access="write"><path>([^<]+)<\/path><\/entry>/g)].some((m) => sameDir(m[1], cwd));
  return { tools: toolsOfRequest(body), writesWorkspace: writes };
}

export async function toolInventory(codex: string, pool: Pool, instructions: string, mcp: Mcp | null, model: string, mode: CodexMode): Promise<Inventory> {
  let body: unknown = null;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      if (req.method === "POST" && body === null) body = JSON.parse(raw);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "tool inventory only", type: "invalid_request_error" } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const root = mkdtempSync(join(tmpdir(), "giraffe-codex-inventory-"));
  const home = writeHome(join(root, "home"), pool, homeConfig(pool, instructions, mcp, `http://127.0.0.1:${port}/v1`));
  const cwd = mkdtempSync(join(root, "cwd-"));
  await new Promise<void>((done) => {
    const proc = spawn(codex, codexArgs(model, "default", mode, cwd), { env: codexEnv(home, join(root, "user"), "inventory"), stdio: ["pipe", "ignore", "ignore"] });
    proc.on("close", () => done());
    proc.on("error", () => done());
    proc.stdin.end("hello");
  });
  server.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  if (body === null) throw new Error(`codex sent no request to the local server, so its ${mode} tools are unknown`);
  return inventoryOf(body, cwd);
}
