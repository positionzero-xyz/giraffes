import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Usage } from "../../src/claude.ts";
import type { Mcp } from "./codex.ts";

export const AGENT = "giraffe";
export const INVENTORY_PROVIDER = "inventory";

export type OpencodeMode = "turn" | "build";
export type OpencodeCall = { readonly name: string; readonly input: Record<string, unknown> };
export type OpencodeFailure = { readonly kind: "usage_limit" | "signed_out" | "failed"; readonly message: string };
export type OpencodeTurn = {
  readonly text: string;
  readonly calls: readonly OpencodeCall[];
  readonly refusedCalls: readonly (OpencodeCall & { readonly problems: readonly string[] })[];
  readonly otherTools: readonly string[];
  readonly usage: Usage | null;
  readonly costUsd: number | null;
  readonly stop: "end" | "max_tokens";
  readonly session: string | null;
  readonly failure: OpencodeFailure | null;
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

type Rule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" };
export type OpencodeConfig = {
  readonly model?: { readonly providerID: string; readonly model: string };
  readonly default_agent: string;
  readonly share: "disabled";
  readonly update: "disable";
  readonly snapshots: false;
  readonly lsp: false;
  readonly formatter: false;
  readonly compaction: { readonly auto: false };
  readonly warming: false;
  readonly plugins: readonly string[];
  readonly providers?: Readonly<Record<string, { readonly package: string; readonly settings: { readonly baseURL: string; readonly apiKey: string }; readonly models: Readonly<Record<string, object>> }>>;
  readonly mcp?: { readonly servers: Readonly<Record<string, { readonly type: "local"; readonly command: readonly string[] }>> };
  readonly agents: Readonly<Record<string, { readonly mode: "primary"; readonly system: string; readonly permissions: readonly Rule[] }>>;
};

/** "-*" turns off every built-in plugin, so the only tools are the ones listed here. */
const BASE_PLUGINS = ["-*", "opencode.models.dev", "opencode.provider.*", "opencode.config.agent", "opencode.config.provider", "opencode.prompt.*"];
const PLUGINS: Readonly<Record<OpencodeMode, readonly string[]>> = {
  turn: [...BASE_PLUGINS, "opencode.config.mcp", "opencode.tools"],
  build: [...BASE_PLUGINS, "opencode.tool.read", "opencode.tool.write", "opencode.tool.edit"],
};
const DENY_ALL: Rule = { action: "*", resource: "*", effect: "deny" };
/** OpenCode's prompt offers a temp folder "approved for external access"; the last rule takes that away too. */
const PERMISSIONS: Readonly<Record<OpencodeMode, readonly Rule[]>> = {
  turn: [DENY_ALL, { action: `${AGENT}_*`, resource: "*", effect: "allow" }],
  build: [DENY_ALL, { action: "read", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "allow" }, { action: "external_directory", resource: "*", effect: "deny" }],
};

export function opencodeConfig(mode: OpencodeMode, system: string, mcp: Mcp | null, inventoryServer?: string): OpencodeConfig {
  return {
    ...(inventoryServer
      ? {
          model: { providerID: INVENTORY_PROVIDER, model: "probe" },
          providers: { [INVENTORY_PROVIDER]: { package: "@ai-sdk/openai-compatible", settings: { baseURL: inventoryServer, apiKey: "inventory" }, models: { probe: {} } } },
        }
      : {}),
    default_agent: AGENT,
    share: "disabled",
    update: "disable",
    snapshots: false,
    lsp: false,
    formatter: false,
    compaction: { auto: false },
    warming: false,
    plugins: PLUGINS[mode],
    ...(mcp ? { mcp: { servers: { [AGENT]: { type: "local", command: [mcp.command, ...mcp.args] } } } } : {}),
    agents: { [AGENT]: { mode: "primary", system, permissions: PERMISSIONS[mode] } },
  };
}

export function writeLane(dir: string, config: OpencodeConfig): string {
  for (const sub of ["config", "xdg", "home"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "config", "opencode.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(dir, "config", "service.json"), JSON.stringify({ disabled: true }));
  return dir;
}

/** OpenCode's data folder holds the stored provider login, so it stays; config, home and the project's own config don't. */
export function opencodeEnv(lane: string, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith("OPENCODE_") && k !== "EXA_API_KEY") env[k] = v;
  return {
    ...env,
    PWD: cwd,
    XDG_CONFIG_HOME: join(lane, "xdg"),
    OPENCODE_TEST_HOME: join(lane, "home"),
    OPENCODE_CONFIG_DIR: join(lane, "config"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
  };
}

export function opencodeArgs(model: string, effort: string): string[] {
  return ["run", "--standalone", "--format", "json", "--model", effort === "default" ? model : `${model}#${effort}`, "--agent", AGENT, "--archived", "--title", "giraffe-eval"];
}

/** npm installs OpenCode behind sh and .cmd shims, which Node can't spawn without a shell on Windows (ENOENT, EINVAL). */
export function findOpencode(explicit: string | null, path = process.env.PATH ?? ""): string {
  if (explicit) return explicit;
  const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const candidate of [join(dir, "node_modules", "@opencode", "cli", "bin", exe), join(dir, exe)]) if (existsSync(candidate)) return candidate;
  }
  return "opencode";
}

const LIMITS = new Set(["provider.rate-limit", "provider.quota", "provider.budget-limit", "provider.model-budget-limit", "provider.free-limit", "provider.go-limit"]);

function failureOf(error: unknown): OpencodeFailure {
  const type = isObject(error) && typeof error.type === "string" ? error.type : "";
  const message = isObject(error) && typeof error.message === "string" ? error.message : "turn failed";
  return { kind: LIMITS.has(type) ? "usage_limit" : type === "provider.auth" ? "signed_out" : "failed", message };
}

function problemsOf(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) && Array.isArray(parsed.problems)) return parsed.problems.map(String);
  } catch {}
  return null;
}

const PREFIX = `${AGENT}_`;
const num = (v: unknown) => (typeof v === "number" ? v : 0);

export function parseOpencodeJsonl(stdout: string): OpencodeTurn {
  let text = "";
  const calls: OpencodeCall[] = [];
  const refusedCalls: (OpencodeCall & { problems: string[] })[] = [];
  const otherTools: string[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let costUsd = 0;
  let steps = 0;
  let reason: unknown = null;
  let session: string | null = null;
  let failure: OpencodeFailure | null = null;
  for (const raw of stdout.split("\n")) {
    let e: unknown;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(e)) continue;
    if (typeof e.sessionID === "string") session ??= e.sessionID;
    const part = isObject(e.part) ? e.part : {};
    if (e.type === "error") failure ??= failureOf(e.error);
    else if (e.type === "text" && typeof part.text === "string" && part.text.trim()) text = part.text;
    else if (e.type === "tool_use" && typeof part.tool === "string") {
      const state = isObject(part.state) ? part.state : {};
      const call = { name: part.tool.slice(PREFIX.length), input: isObject(state.input) ? state.input : {} };
      if (!part.tool.startsWith(PREFIX)) otherTools.push(part.tool);
      else if (state.status === "completed") {
        const problems = typeof state.output === "string" ? problemsOf(state.output) : null;
        if (problems) refusedCalls.push({ ...call, problems });
        else calls.push(call);
      } else {
        const error = typeof state.error === "string" ? state.error : "Tool call failed";
        refusedCalls.push({ ...call, problems: problemsOf(error) ?? [error] });
      }
    } else if (e.type === "step_finish") {
      steps++;
      reason = part.reason;
      const t = isObject(part.tokens) ? part.tokens : {};
      const cache = isObject(t.cache) ? t.cache : {};
      usage.input_tokens += num(t.input);
      usage.output_tokens += num(t.output) + num(t.reasoning);
      usage.cache_read_input_tokens += num(cache.read);
      usage.cache_creation_input_tokens += num(cache.write);
      costUsd += num(part.cost);
    }
  }
  if (!failure && steps === 0) failure = { kind: "failed", message: "no step_finish event" };
  if (!failure && reason !== "stop" && reason !== "length") failure = { kind: "failed", message: `the last step ended with ${String(reason)}` };
  return { text, calls, refusedCalls, otherTools, usage: steps ? usage : null, costUsd: steps ? costUsd : null, stop: reason === "length" ? "max_tokens" : "end", session, failure };
}

export type Inventory = { readonly tools: readonly string[]; readonly system: string };

export function inventoryOf(body: unknown): Inventory {
  const tools = isObject(body) && Array.isArray(body.tools) ? body.tools : [];
  const messages = isObject(body) && Array.isArray(body.messages) ? body.messages : [];
  const system = messages.find((m) => isObject(m) && m.role === "system");
  return {
    tools: tools.flatMap((t) => (isObject(t) && isObject(t.function) && typeof t.function.name === "string" ? [t.function.name] : [])),
    system: isObject(system) && typeof system.content === "string" ? system.content : "",
  };
}

export async function toolInventory(opencode: string, mode: OpencodeMode, system: string, mcp: Mcp | null): Promise<Inventory> {
  let body: unknown = null;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      if (req.method === "POST" && body === null) body = JSON.parse(raw);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "tool inventory only" } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const root = mkdtempSync(join(tmpdir(), "giraffe-opencode-inventory-"));
  const lane = writeLane(join(root, "lane"), opencodeConfig(mode, system, mcp, `http://127.0.0.1:${port}/v1`));
  const cwd = mkdtempSync(join(root, "cwd-"));
  await new Promise<void>((done) => {
    const proc = spawn(opencode, opencodeArgs(`${INVENTORY_PROVIDER}/probe`, "default"), { cwd, env: opencodeEnv(lane, cwd), stdio: ["pipe", "ignore", "ignore"] });
    proc.on("close", () => done());
    proc.on("error", () => done());
    proc.stdin.end("hello");
  });
  server.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  if (body === null) throw new Error(`opencode sent no request to the local server, so its ${mode} tools are unknown`);
  return inventoryOf(body);
}
