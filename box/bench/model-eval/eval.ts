import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentArgs, agentTurn, authStatus, cliVersion, type AgentRequest, type SessionStore, type Usage } from "../../src/claude.ts";
import { findChrome, inspect } from "./browser.ts";
import { BUILD_SYSTEM, selectCases } from "./cases.ts";
import { grade, REPLY_CAP } from "./checks.ts";
import { CODEX_EFFORTS, codexArgs, codexEnv, giraffeMcp, homeConfig, parseCodexJsonl, PROFILE, readPool, toolInventory, writeHome, type CodexMode, type Mcp, type Pool } from "./codex.ts";
import { findOpencode, opencodeArgs, opencodeConfig, opencodeEnv, parseOpencodeJsonl, toolInventory as opencodeInventory, writeLane, type OpencodeMode } from "./opencode.ts";
import { ingestScores, readScores, writeJudgeBatch, type JudgeKey } from "./judge.ts";
import { agentRequest, effortOf, failedTurn, NO_OBSERVATION, readTurn, TZ } from "./product.ts";
import { render, type JudgeScores } from "./summary.ts";
import { CONTRACT, contractOf, EFFORTS, HARNESSES, SHAPES, type Candidate, type Case, type Check, type CodexMeta, type Effort, type Observation, type OpencodeMeta, type RunFile, type RunRecord, type RunStatus, type Shape, type Tap, type Wall } from "./types.ts";
import { dateOf, parseWall, todayAt } from "./when.ts";

const USAGE = `usage:
  node bench/model-eval/eval.ts [--candidates haiku@default,haiku@low,...] [--shapes chat,reminder,draft,build]
    [--cases <id,...> | <n per shape>] [--reps 1] [--out <dir>] [--now YYYY-MM-DDTHH:mm] [--claude <cli>] [--codex <cli>] [--opencode <cli>] [--chrome <browser>] [--dry]
  node bench/model-eval/eval.ts score --run <run dir> --judge <name> --scores <file.json>
A candidate is [harness:]model@effort. The harness is claude-code (the default), codex, as in codex:gpt-6.2-sol@low,
or opencode, as in opencode:mistral/deepseek-v4-1-flash-1017@low, whose effort is an OpenCode variant;
codex takes the efforts ${CODEX_EFFORTS.join(", ")}. --dry prints every command and spends nothing.`;

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TAP = join(HERE, "tap.ts");
const NOW_TIME = "10:00";
const TURN_TAP_MS = 119_000;
const BUILD_TIMEOUT_MS = 300_000;
const BUILD_TOOLS = "Read,Write,Edit";
const DEFAULT_CANDIDATES = "haiku@default,haiku@low,haiku@medium,haiku@high,sonnet@low,sonnet@medium,opus@low,opus@medium";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  return process.argv[at + 1] ?? fail(USAGE);
}

function parseCandidate(raw: string): Candidate {
  const m = /^(?:([a-z-]+):)?([A-Za-z0-9._/-]+)@([a-z]+)$/.exec(raw.trim());
  const harness = m?.[1] ?? "claude-code";
  const efforts: readonly string[] = harness === "codex" ? CODEX_EFFORTS : EFFORTS;
  if (!m || !HARNESSES.includes(harness as Candidate["harness"]) || !efforts.includes(m[3])) fail(`not a candidate: ${raw}\n${USAGE}`);
  return { harness: harness as Candidate["harness"], model: m[2], effort: m[3] as Effort };
}

const label = (c: Candidate) => `${c.harness === "claude-code" ? "" : `${c.harness}:`}${c.model}@${c.effort}`;

// The CLI the harness drives is the person's local login; a parent Claude Code session's own variables must not leak in.
for (const k of Object.keys(process.env)) if (k.startsWith("CLAUDE") && k !== "CLAUDE_CONFIG_DIR") delete process.env[k];

function buildArgs(c: Candidate): string[] {
  const effort = effortOf(c);
  return [
    "-p",
    "--model", c.model,
    ...(effort ? ["--effort", effort] : []),
    "--tools", BUILD_TOOLS,
    "--allowedTools", BUILD_TOOLS,
    "--permission-mode", "acceptEdits",
    "--append-system-prompt", BUILD_SYSTEM,
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources", "",
    "--strict-mcp-config",
  ];
}

function readTap(file: string): Tap | null {
  if (!existsSync(file)) return null;
  const first = readFileSync(file, "utf8").split("\n")[0];
  return first ? (JSON.parse(first) as Tap) : null;
}

type Outcome = {
  readonly status: RunStatus;
  readonly observation: Observation;
  readonly calls: readonly unknown[];
  readonly refusedCalls: readonly unknown[];
  readonly otherTools: readonly string[];
  readonly usage: Usage | null;
  readonly costUsd: number | null;
  readonly tap: Tap | null;
  readonly buildDir: string | null;
  readonly servedModels?: readonly string[];
};

const outcome = (status: RunStatus, tap: Tap | null, rest: Partial<Outcome> = {}): Outcome => ({
  status,
  observation: NO_OBSERVATION,
  calls: [],
  refusedCalls: [],
  otherTools: [],
  usage: tap?.usage ?? null,
  costUsd: tap?.costUsd ?? null,
  tap,
  buildDir: null,
  ...rest,
});

async function productTurn(cli: string, c: Candidate, k: Case, message: string, now: Wall, tapFile: string): Promise<Outcome> {
  let id: string | null = null;
  const sessions: SessionStore = { get: () => id, set: (v) => void (id = v) };
  const reply = await agentTurn([process.execPath, TAP, tapFile, String(TURN_TAP_MS), cli], agentRequest(c, message, now), sessions);
  const tap = readTap(tapFile);
  if (reply.status !== 200) return { ...failedTurn(reply.status, tap), otherTools: [], tap, buildDir: null };
  const read = readTurn(reply.body, message, now, CONTRACT[k.shape]);
  return { ...read, otherTools: [], costUsd: tap?.costUsd ?? read.costUsd, tap, buildDir: null };
}

function run(cmd: readonly string[], cwd: string, stdin: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((done) => {
    const [bin, ...args] = cmd;
    const proc = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c: string) => (out += c));
    proc.on("close", () => done(out));
    proc.stdin.on("error", () => {});
    proc.stdin.end(stdin);
  });
}

const PAGE_FILES = /\.(html?|css|js|json)$/i;

function readFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (PAGE_FILES.test(name) && statSync(path).isFile() && statSync(path).size < 1_000_000) files[name] = readFileSync(path, "utf8");
  }
  return files;
}

async function buildTurn(cli: string, chrome: string | null, c: Candidate, message: string, checks: readonly Check[], tapFile: string, keep: string): Promise<Outcome> {
  const work = mkdtempSync(join(tmpdir(), "giraffe-build-"));
  const stdout = await run([process.execPath, TAP, tapFile, String(BUILD_TIMEOUT_MS), cli, ...buildArgs(c)], work, message);
  const tap = readTap(tapFile);
  const result = stdout
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .findLast((e) => e?.type === "result");
  keepBuild(work, keep);
  const rest = { usage: (result?.usage ?? tap?.usage ?? null) as Usage | null, buildDir: keep };
  if (tap?.killed) return outcome("timeout", tap, rest);
  if (!result || result.is_error !== false) {
    const auth = await authStatus([cli]);
    return outcome(auth?.loggedIn === false ? "signed_out" : "claude_failed", tap, rest);
  }
  return outcome("ok", tap, { ...rest, observation: await observeBuild(chrome, keep, checks, String(result.result ?? "")) });
}

function keepBuild(work: string, keep: string) {
  mkdirSync(keep, { recursive: true });
  cpSync(work, keep, { recursive: true });
  rmSync(work, { recursive: true, force: true });
}

async function observeBuild(chrome: string | null, keep: string, checks: readonly Check[], text: string): Promise<Observation> {
  const files = readFiles(keep);
  const drive = checks.some((k) => k.kind === "persists");
  const page = chrome && files["index.html"] ? await inspect(chrome, join(keep, "index.html"), drive) : null;
  return { text, raw: text, answered: text.trim() !== "", wakeups: [], rejected: [], files, page };
}

type Codex = {
  readonly cli: string;
  readonly pool: Pool;
  readonly root: string;
  readonly mcp: Mcp;
  readonly turn: Pick<AgentRequest, "append" | "tools">;
  readonly homes: Readonly<Record<CodexMode, string>>;
  readonly user: string;
};

/** The turn home carries one request's system text and tools; every turn's request must match them. */
function codexSetup(cli: string, personHome: string, sample: AgentRequest): Codex {
  const pool = readPool(personHome);
  const root = mkdtempSync(join(tmpdir(), "giraffe-codex-"));
  const toolsFile = join(root, "tools.json");
  writeFileSync(toolsFile, JSON.stringify(sample.tools));
  const mcp = giraffeMcp(toolsFile);
  return {
    cli,
    pool,
    root,
    mcp,
    turn: { append: sample.append, tools: sample.tools },
    homes: {
      turn: writeHome(join(root, "turn"), pool, homeConfig(pool, sample.append, mcp)),
      build: writeHome(join(root, "build"), pool, homeConfig(pool, BUILD_SYSTEM, null)),
    },
    user: join(root, "user"),
  };
}

async function codexRun(codex: Codex, c: Candidate, mode: CodexMode, cwd: string, stdin: string, tapFile: string) {
  const timeout = mode === "build" ? BUILD_TIMEOUT_MS : TURN_TAP_MS;
  const cmd = [process.execPath, TAP, tapFile, String(timeout), codex.cli, ...codexArgs(c.model, c.effort, mode, cwd)];
  const stdout = await run(cmd, cwd, stdin, codexEnv(codex.homes[mode], codex.user, codex.pool.secretToken));
  writeFileSync(tapFile.replace(/\.jsonl$/, ".codex.jsonl"), stdout);
  const turn = parseCodexJsonl(stdout);
  const tap = readTap(tapFile);
  const status: RunStatus | null = tap?.killed ? "timeout" : turn.failure ? (turn.failure.kind === "usage_limit" ? "usage_limit" : "codex_failed") : null;
  return { turn, tap, status };
}

async function codexTurn(codex: Codex, c: Candidate, k: Case, message: string, now: Wall, tapFile: string): Promise<Outcome> {
  const req = agentRequest(c, message, now);
  if (req.append !== codex.turn.append || JSON.stringify(req.tools) !== JSON.stringify(codex.turn.tools)) throw new Error("this turn's system text or tools differ from the Codex home's");
  const cwd = mkdtempSync(join(tmpdir(), "giraffe-codex-turn-"));
  const { turn, tap, status } = await codexRun(codex, c, "turn", cwd, req.turn, tapFile);
  rmSync(cwd, { recursive: true, force: true });
  if (status) return outcome(status, tap, { usage: turn.usage, otherTools: turn.otherTools });
  const body = { text: turn.text, calls: [...turn.calls], refusedCalls: turn.refusedCalls.map((r) => ({ ...r, problems: [...r.problems] })), usage: turn.usage, stop: "end" as const, costUsd: null };
  return { ...readTurn(body, message, now, CONTRACT[k.shape]), otherTools: turn.otherTools, tap, buildDir: null };
}

async function codexBuild(codex: Codex, chrome: string | null, c: Candidate, message: string, checks: readonly Check[], tapFile: string, keep: string): Promise<Outcome> {
  const work = mkdtempSync(join(tmpdir(), "giraffe-build-"));
  const { turn, tap, status } = await codexRun(codex, c, "build", work, message, tapFile);
  keepBuild(work, keep);
  const rest = { usage: turn.usage, otherTools: turn.otherTools, buildDir: keep };
  if (status) return outcome(status, tap, rest);
  return outcome("ok", tap, { ...rest, observation: await observeBuild(chrome, keep, checks, turn.text) });
}

type Opencode = {
  readonly cli: string;
  readonly root: string;
  readonly mcp: Mcp;
  readonly turn: Pick<AgentRequest, "append" | "tools">;
  readonly lanes: Readonly<Record<OpencodeMode, string>>;
};

function opencodeSetup(cli: string, sample: AgentRequest): Opencode {
  const root = mkdtempSync(join(tmpdir(), "giraffe-opencode-"));
  const toolsFile = join(root, "tools.json");
  writeFileSync(toolsFile, JSON.stringify(sample.tools));
  const mcp = giraffeMcp(toolsFile);
  return {
    cli,
    root,
    mcp,
    turn: { append: sample.append, tools: sample.tools },
    lanes: {
      turn: writeLane(join(root, "turn"), opencodeConfig("turn", sample.append, mcp)),
      build: writeLane(join(root, "build"), opencodeConfig("build", BUILD_SYSTEM, null)),
    },
  };
}

const OPENCODE_STATUS: Readonly<Record<"usage_limit" | "signed_out" | "failed", RunStatus>> = { usage_limit: "usage_limit", signed_out: "signed_out", failed: "opencode_failed" };

async function servedModel(opencode: Opencode, mode: OpencodeMode, cwd: string, session: string | null): Promise<string[]> {
  if (!session) return [];
  const raw = await run([opencode.cli, "session", "export", "--standalone", session], cwd, "", opencodeEnv(opencode.lanes[mode], cwd));
  try {
    const m = JSON.parse(raw).info.model;
    return [`${m.providerID}/${m.id}${m.variant && m.variant !== "default" ? `#${m.variant}` : ""}`];
  } catch {
    return [];
  }
}

async function opencodeRun(opencode: Opencode, c: Candidate, mode: OpencodeMode, cwd: string, stdin: string, tapFile: string) {
  const timeout = mode === "build" ? BUILD_TIMEOUT_MS : TURN_TAP_MS;
  const cmd = [process.execPath, TAP, tapFile, String(timeout), opencode.cli, ...opencodeArgs(c.model, c.effort)];
  const stdout = await run(cmd, cwd, stdin, opencodeEnv(opencode.lanes[mode], cwd));
  writeFileSync(tapFile.replace(/\.jsonl$/, ".opencode.jsonl"), stdout);
  const turn = parseOpencodeJsonl(stdout);
  const tap = readTap(tapFile);
  const servedModels = await servedModel(opencode, mode, cwd, turn.session);
  const status: RunStatus | null = tap?.killed ? "timeout" : turn.failure ? OPENCODE_STATUS[turn.failure.kind] : null;
  return { turn, tap, status, servedModels };
}

async function opencodeTurn(opencode: Opencode, c: Candidate, k: Case, message: string, now: Wall, tapFile: string): Promise<Outcome> {
  const req = agentRequest(c, message, now);
  if (req.append !== opencode.turn.append || JSON.stringify(req.tools) !== JSON.stringify(opencode.turn.tools)) throw new Error("this turn's system text or tools differ from the OpenCode lane's");
  const cwd = mkdtempSync(join(tmpdir(), "giraffe-opencode-turn-"));
  const { turn, tap, status, servedModels } = await opencodeRun(opencode, c, "turn", cwd, req.turn, tapFile);
  rmSync(cwd, { recursive: true, force: true });
  const rest = { usage: turn.usage, costUsd: turn.costUsd, otherTools: turn.otherTools, servedModels };
  if (status) return outcome(status, tap, rest);
  const body = { text: turn.text, calls: [...turn.calls], refusedCalls: turn.refusedCalls.map((r) => ({ ...r, problems: [...r.problems] })), usage: turn.usage, stop: turn.stop, costUsd: turn.costUsd };
  return { ...readTurn(body, message, now, CONTRACT[k.shape]), otherTools: turn.otherTools, tap, buildDir: null, servedModels };
}

async function opencodeBuild(opencode: Opencode, chrome: string | null, c: Candidate, message: string, checks: readonly Check[], tapFile: string, keep: string): Promise<Outcome> {
  const work = mkdtempSync(join(tmpdir(), "giraffe-build-"));
  const { turn, tap, status, servedModels } = await opencodeRun(opencode, c, "build", work, message, tapFile);
  keepBuild(work, keep);
  const rest = { usage: turn.usage, costUsd: turn.costUsd, otherTools: turn.otherTools, buildDir: keep, servedModels };
  if (status) return outcome(status, tap, rest);
  return outcome("ok", tap, { ...rest, observation: await observeBuild(chrome, keep, checks, turn.text) });
}

function expectInventory(mode: OpencodeMode, seen: { tools: readonly string[]; system: string }, system: string, tools: readonly string[]) {
  const want = [...tools].sort().join(", ");
  const got = [...seen.tools].sort().join(", ");
  if (got !== want) fail(`opencode's ${mode} tools are ${got || "none"}, not ${want}`);
  if (!seen.system.startsWith(system)) fail(`opencode's ${mode} system text doesn't start with the harness's own`);
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`);

function printDry(cli: string, codex: Codex | null, opencode: Opencode | null, candidates: readonly Candidate[], cases: readonly Case[], reps: number, now: Wall) {
  if (codex) {
    for (const mode of ["turn", "build"] as const) {
      console.log(`# codex ${mode} home: CODEX_HOME=${codex.homes[mode]} with ${PROFILE}.config.toml naming ${codex.pool.provider}, USERPROFILE and HOME an empty folder, the key only in the environment`);
      console.log(readFileSync(join(codex.homes[mode], "config.toml"), "utf8"));
    }
  }
  if (opencode) {
    for (const mode of ["turn", "build"] as const) {
      console.log(`# opencode ${mode} lane: OPENCODE_CONFIG_DIR=${join(opencode.lanes[mode], "config")}, its own XDG config and home folders, project config off`);
      console.log(readFileSync(join(opencode.lanes[mode], "config", "opencode.json"), "utf8"));
    }
  }
  for (const c of candidates) {
    for (const k of cases) {
      const { message } = k.make(now);
      const req = agentRequest(c, message, now);
      const build = k.shape === "build";
      const where = build || c.harness !== "claude-code" ? "a fresh empty temp folder" : "the box's empty folder";
      console.log(`# ${label(c)} ${k.id} x${reps} (${contractOf(c.harness, k.shape)}, cwd ${where})`);
      if (c.harness === "codex") {
        console.log([codex?.cli ?? "codex", ...codexArgs(c.model, c.effort, build ? "build" : "turn", "<temp folder>")].map(quote).join(" "));
        console.log(`# stdin: ${build ? message : req.turn}\n`);
        continue;
      }
      if (c.harness === "opencode") {
        console.log([opencode?.cli ?? "opencode", ...opencodeArgs(c.model, c.effort)].map(quote).join(" "));
        console.log(`# stdin: ${build ? message : req.turn}\n`);
        continue;
      }
      const args = build ? buildArgs(c) : agentArgs(req, "<tools.json>", { id: "<new session id>", resume: false });
      const stdin = build ? message : JSON.stringify({ type: "user", message: { role: "user", content: req.turn } });
      console.log([cli, ...args].map(quote).join(" "));
      console.log(`# stdin: ${stdin}\n`);
    }
  }
}

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: HERE, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function judgesOf(runDir: string): { key: JudgeKey | null; judges: JudgeScores[] } {
  const keyFile = join(runDir, "judge-key.json");
  const key = existsSync(keyFile) ? (JSON.parse(readFileSync(keyFile, "utf8")) as JudgeKey) : null;
  const dir = join(runDir, "scores");
  const judges = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => ({ name: f.slice(0, -5), scores: key ? readScores(key, JSON.parse(readFileSync(join(dir, f), "utf8"))) : {} }))
    : [];
  return { key, judges };
}

function writeSummary(runDir: string, file: RunFile): string {
  const { key, judges } = judgesOf(runDir);
  const md = render(file, key, judges);
  writeFileSync(join(runDir, "summary.md"), md);
  return md;
}

async function main() {
  if (process.argv[2] === "score") {
    const runDir = resolve(flag("run", "") || fail(USAGE));
    const gate = ingestScores(runDir, flag("judge", "") || fail(USAGE), resolve(flag("scores", "") || fail(USAGE)));
    console.log(`calibration good ${gate.good.toFixed(2)} flat ${gate.flat.toFixed(2)} bad ${gate.bad.toFixed(2)}: ${gate.proven ? "proven" : "unproven"}`);
    console.log(writeSummary(runDir, JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"))));
    return;
  }

  const candidates = flag("candidates", DEFAULT_CANDIDATES).split(",").map(parseCandidate);
  const shapes = flag("shapes", SHAPES.join(",")).split(",") as Shape[];
  if (shapes.some((s) => !SHAPES.includes(s))) fail(`shapes are ${SHAPES.join(", ")}`);
  const casesArg = flag("cases", "");
  const cases = selectCases(shapes, casesArg === "" ? null : /^\d+$/.test(casesArg) ? Number(casesArg) : casesArg.split(","));
  const reps = Number(flag("reps", "1"));
  if (!Number.isInteger(reps) || reps < 1) fail(USAGE);
  const pinned = flag("now", "");
  const now = pinned ? (parseWall(pinned) ?? fail(`--now must be YYYY-MM-DDTHH:mm`)) : todayAt(new Date(), TZ, NOW_TIME);
  const pinnedCli = join(HERE, "../../node_modules/@anthropic-ai/claude-code/bin/claude.exe");
  const cli = flag("claude", existsSync(pinnedCli) ? pinnedCli : "claude");

  const usesClaude = candidates.some((c) => c.harness === "claude-code");
  const codexCandidates = candidates.filter((c) => c.harness === "codex");
  const sample = codexCandidates.length && cases.length ? agentRequest(codexCandidates[0], cases[0].make(now).message, now) : null;
  const codex = sample ? codexSetup(flag("codex", "codex"), process.env.CODEX_HOME ?? join(homedir(), ".codex"), sample) : null;
  const opencodeCandidates = candidates.filter((c) => c.harness === "opencode");
  const opencodeSample = opencodeCandidates.length && cases.length ? agentRequest(opencodeCandidates[0], cases[0].make(now).message, now) : null;
  const opencode = opencodeSample ? opencodeSetup(findOpencode(flag("opencode", "") || null), opencodeSample) : null;

  if (process.argv.includes("--dry")) {
    printDry(cli, codex, opencode, candidates, cases, reps, now);
    if (codex) rmSync(codex.root, { recursive: true, force: true });
    if (opencode) rmSync(opencode.root, { recursive: true, force: true });
    return;
  }

  const chrome = shapes.includes("build") ? findChrome(flag("chrome", "") || process.env.CHROME) : null;
  if (shapes.includes("build") && !chrome) fail("build checks need Chrome or Edge: pass --chrome <path>");
  const auth = usesClaude ? await authStatus([cli]) : null;
  if (usesClaude && !auth?.loggedIn) fail(`the CLI at ${cli} is not signed in`);

  let codexMeta: CodexMeta | null = null;
  if (codex) {
    const version = spawnSync(codex.cli, ["--version"], { encoding: "utf8" }).stdout?.trim().split(/\s+/).at(-1) ?? null;
    const modes = [...new Set(cases.map((k) => (k.shape === "build" ? "build" : "turn") as CodexMode))];
    const tools: Partial<Record<CodexMode, readonly string[]>> = {};
    for (const mode of modes) {
      const turn = mode === "turn";
      const seen = await toolInventory(codex.cli, codex.pool, turn ? codex.turn.append : BUILD_SYSTEM, turn ? codex.mcp : null, codexCandidates[0].model, mode).catch((err: Error) => fail(err.message));
      if (mode === "build" && !seen.writesWorkspace) fail("codex's build sandbox can't write its folder, so a build would fail for the harness, not the model");
      tools[mode] = seen.tools;
      console.log(`codex ${mode} tools: ${seen.tools.join(", ")}`);
    }
    codexMeta = { cli: codex.cli, version, profile: PROFILE, provider: codex.pool.provider, tools };
  }

  let opencodeMeta: OpencodeMeta | null = null;
  if (opencode) {
    const version = spawnSync(opencode.cli, ["--version"], { encoding: "utf8" }).stdout?.trim().split(/\s+/).at(-1)?.replace(/^v/, "") ?? null;
    const modes = [...new Set(cases.map((k) => (k.shape === "build" ? "build" : "turn") as OpencodeMode))];
    const tools: Partial<Record<OpencodeMode, readonly string[]>> = {};
    for (const mode of modes) {
      const turn = mode === "turn";
      const system = turn ? opencode.turn.append : BUILD_SYSTEM;
      const seen = await opencodeInventory(opencode.cli, mode, system, turn ? opencode.mcp : null).catch((err: Error) => fail(err.message));
      expectInventory(mode, seen, system, turn ? opencode.turn.tools.map((t) => `giraffe_${t.name}`) : ["edit", "read", "write"]);
      tools[mode] = seen.tools;
      console.log(`opencode ${mode} tools: ${seen.tools.join(", ")}`);
    }
    opencodeMeta = { cli: opencode.cli, version, tools };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const runDir = resolve(flag("out", join(HERE, "out")), `${stamp}-${randomBytes(2).toString("hex")}`);
  mkdirSync(join(runDir, "taps"), { recursive: true });
  const file: RunFile = {
    meta: {
      startedAt: new Date().toISOString(),
      gitSha: gitSha(),
      cliVersion: usesClaude ? await cliVersion([cli]) : null,
      cli,
      auth: auth ? { loggedIn: auth.loggedIn, authMethod: auth.authMethod } : null,
      now,
      nowPinned: pinned !== "",
      argv: process.argv.slice(2),
      codex: codexMeta,
      opencode: opencodeMeta,
    },
    records: [],
  };
  console.log(`run ${runDir}: ${candidates.length} candidates x ${cases.length} cases x ${reps} reps, now ${now}`);

  const attempt = (c: Candidate, k: Case, message: string, checks: readonly Check[], tapFile: string, keep: string): Promise<Outcome> => {
    if (c.harness === "opencode" && opencode) return k.shape === "build" ? opencodeBuild(opencode, chrome, c, message, checks, tapFile, keep) : opencodeTurn(opencode, c, k, message, now, tapFile);
    if (c.harness === "codex" && codex) return k.shape === "build" ? codexBuild(codex, chrome, c, message, checks, tapFile, keep) : codexTurn(codex, c, k, message, now, tapFile);
    return k.shape === "build" ? buildTurn(cli, chrome, c, message, checks, tapFile, keep) : productTurn(cli, c, k, message, now, tapFile);
  };

  for (let rep = 1; rep <= reps; rep++) {
    for (const k of cases) {
      for (const c of candidates) {
        const id = `${label(c)}:${k.id}:${rep}`;
        const safe = id.replace(/[^\w.-]+/g, "_");
        const tapFile = join(runDir, "taps", `${safe}.jsonl`);
        const { message, checks } = k.make(now);
        const machineDate = new Date().toLocaleDateString("en-CA");
        const out = await attempt(c, k, message, checks, tapFile, join(runDir, "builds", safe)).catch((err: unknown): Outcome => {
          console.error(`${id} harness error: ${String(err)}`);
          return outcome("harness_error", readTap(tapFile));
        });
        const record: RunRecord = {
          id,
          candidate: label(c),
          harness: c.harness,
          model: c.model,
          effort: c.effort,
          shape: k.shape,
          caseId: k.id,
          rep,
          contract: contractOf(c.harness, k.shape),
          now,
          machineDate,
          dateMismatch: machineDate !== dateOf(now),
          status: out.status,
          message,
          reply: out.observation.raw,
          delivered: out.status === "ok" && CONTRACT[k.shape] === "product" ? out.observation.text : null,
          overReplyCap: out.observation.raw.length > REPLY_CAP,
          calls: out.calls,
          refusedCalls: out.refusedCalls,
          otherTools: out.otherTools,
          rejected: out.observation.rejected,
          wakeups: out.observation.wakeups,
          checks: out.status === "ok" ? checks.map((ch) => grade(ch, out.observation)) : [],
          wallMs: out.tap?.wallMs ?? null,
          firstTextMs: out.tap?.firstTextMs ?? null,
          usage: out.usage,
          costUsd: out.costUsd,
          models: out.servedModels ?? out.tap?.models ?? [],
          buildDir: out.buildDir,
        };
        file.records.push(record);
        writeFileSync(join(runDir, "run.json"), `${JSON.stringify(file, null, 2)}\n`);
        const passed = record.checks.filter((r) => r.pass).length;
        const wall = record.wallMs === null ? "no time" : `${(record.wallMs / 1000).toFixed(1)}s`;
        console.log(`${id} ${record.status} ${passed}/${record.checks.length} checks ${wall} ${record.costUsd === null ? "cost unknown" : `$${record.costUsd.toFixed(4)}`}`);
      }
    }
  }
  if (codex) rmSync(codex.root, { recursive: true, force: true, maxRetries: 3 });
  if (opencode) rmSync(opencode.root, { recursive: true, force: true, maxRetries: 3 });
  const judged = writeJudgeBatch(runDir, file.records);
  console.log(`judge batch: ${judged.items} items in ${join(runDir, "judge")}`);
  console.log(writeSummary(runDir, file));
}

await main();
