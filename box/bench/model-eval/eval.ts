import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentArgs, agentTurn, authStatus, cliVersion, type SessionStore, type Usage } from "../../src/claude.ts";
import { findChrome, inspect } from "./browser.ts";
import { BUILD_SYSTEM, selectCases } from "./cases.ts";
import { grade, REPLY_CAP } from "./checks.ts";
import { ingestScores, readScores, writeJudgeBatch, type JudgeKey } from "./judge.ts";
import { agentRequest, effortOf, failedTurn, NO_OBSERVATION, readTurn, TZ } from "./product.ts";
import { render, type JudgeScores } from "./summary.ts";
import { CONTRACT, EFFORTS, HARNESSES, SHAPES, type Candidate, type Case, type Check, type Effort, type Observation, type RunFile, type RunRecord, type RunStatus, type Shape, type Tap, type Wall } from "./types.ts";
import { dateOf, parseWall, todayAt } from "./when.ts";

const USAGE = `usage:
  node bench/model-eval/eval.ts [--candidates haiku@default,haiku@low,...] [--shapes chat,reminder,draft,build]
    [--cases <id,...> | <n per shape>] [--reps 1] [--out <dir>] [--now YYYY-MM-DDTHH:mm] [--claude <cli>] [--chrome <browser>] [--dry]
  node bench/model-eval/eval.ts score --run <run dir> --judge <name> --scores <file.json>
A candidate is [harness:]model@effort; claude-code is the only harness. --dry prints every command and spends nothing.`;

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
  const m = /^(?:([a-z-]+):)?([A-Za-z0-9._-]+)@([a-z]+)$/.exec(raw.trim());
  const harness = m?.[1] ?? "claude-code";
  if (!m || !HARNESSES.includes(harness as Candidate["harness"]) || !EFFORTS.includes(m[3] as Effort)) fail(`not a candidate: ${raw}\n${USAGE}`);
  return { harness: harness as Candidate["harness"], model: m[2], effort: m[3] as Effort };
}

const label = (c: Candidate) => `${c.model}@${c.effort}`;

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
  readonly usage: Usage | null;
  readonly costUsd: number | null;
  readonly tap: Tap | null;
  readonly buildDir: string | null;
};

async function productTurn(cli: string, c: Candidate, k: Case, message: string, now: Wall, tapFile: string): Promise<Outcome> {
  let id: string | null = null;
  const sessions: SessionStore = { get: () => id, set: (v) => void (id = v) };
  const reply = await agentTurn([process.execPath, TAP, tapFile, String(TURN_TAP_MS), cli], agentRequest(c, message, now), sessions);
  const tap = readTap(tapFile);
  if (reply.status !== 200) {
    return { ...failedTurn(reply.status, tap), tap, buildDir: null };
  }
  const read = readTurn(reply.body, message, now, CONTRACT[k.shape]);
  return { ...read, costUsd: tap?.costUsd ?? read.costUsd, tap, buildDir: null };
}

function run(cmd: readonly string[], cwd: string, stdin: string): Promise<string> {
  return new Promise((done) => {
    const [bin, ...args] = cmd;
    const proc = spawn(bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
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
  mkdirSync(keep, { recursive: true });
  cpSync(work, keep, { recursive: true });
  rmSync(work, { recursive: true, force: true });
  const usage: Usage | null = result?.usage ?? tap?.usage ?? null;
  const base = { calls: [], refusedCalls: [], usage, costUsd: tap?.costUsd ?? null, tap, buildDir: keep };
  if (tap?.killed) return { status: "timeout", observation: NO_OBSERVATION, ...base };
  if (!result || result.is_error !== false) {
    const auth = await authStatus([cli]);
    return { status: auth?.loggedIn === false ? "signed_out" : "claude_failed", observation: NO_OBSERVATION, ...base };
  }
  const files = readFiles(keep);
  const drive = checks.some((k) => k.kind === "persists");
  const page = chrome && files["index.html"] ? await inspect(chrome, join(keep, "index.html"), drive) : null;
  const text = String(result.result ?? "");
  return { status: "ok", observation: { text, raw: text, answered: text.trim() !== "", wakeups: [], rejected: [], files, page }, ...base };
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`);

function printDry(cli: string, candidates: readonly Candidate[], cases: readonly Case[], reps: number, now: Wall) {
  for (const c of candidates) {
    for (const k of cases) {
      const { message } = k.make(now);
      const req = agentRequest(c, message, now);
      const args = k.shape === "build" ? buildArgs(c) : agentArgs(req, "<tools.json>", { id: "<new session id>", resume: false });
      const stdin = k.shape === "build" ? message : JSON.stringify({ type: "user", message: { role: "user", content: req.turn } });
      console.log(`# ${label(c)} ${k.id} x${reps} (${CONTRACT[k.shape]}, cwd ${k.shape === "build" ? "a fresh empty temp folder" : "the box's empty folder"})`);
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

  if (process.argv.includes("--dry")) return printDry(cli, candidates, cases, reps, now);

  const chrome = shapes.includes("build") ? findChrome(flag("chrome", "") || process.env.CHROME) : null;
  if (shapes.includes("build") && !chrome) fail("build checks need Chrome or Edge: pass --chrome <path>");
  const auth = await authStatus([cli]);
  if (!auth?.loggedIn) fail(`the CLI at ${cli} is not signed in`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const runDir = resolve(flag("out", join(HERE, "out")), `${stamp}-${randomBytes(2).toString("hex")}`);
  mkdirSync(join(runDir, "taps"), { recursive: true });
  const file: RunFile = {
    meta: { startedAt: new Date().toISOString(), gitSha: gitSha(), cliVersion: await cliVersion([cli]), cli, auth: { loggedIn: auth.loggedIn, authMethod: auth.authMethod }, now, nowPinned: pinned !== "", argv: process.argv.slice(2) },
    records: [],
  };
  console.log(`run ${runDir}: ${candidates.length} candidates x ${cases.length} cases x ${reps} reps, now ${now}`);

  for (let rep = 1; rep <= reps; rep++) {
    for (const k of cases) {
      for (const c of candidates) {
        const id = `${label(c)}:${k.id}:${rep}`;
        const safe = id.replace(/[^\w.-]+/g, "_");
        const tapFile = join(runDir, "taps", `${safe}.jsonl`);
        const { message, checks } = k.make(now);
        const machineDate = new Date().toLocaleDateString("en-CA");
        const out = await (k.shape === "build" ? buildTurn(cli, chrome, c, message, checks, tapFile, join(runDir, "builds", safe)) : productTurn(cli, c, k, message, now, tapFile)).catch(
          (err: unknown): Outcome => {
            console.error(`${id} harness error: ${String(err)}`);
            const tap = readTap(tapFile);
            return { status: "harness_error", observation: NO_OBSERVATION, calls: [], refusedCalls: [], usage: tap?.usage ?? null, costUsd: tap?.costUsd ?? null, tap, buildDir: null };
          },
        );
        const record: RunRecord = {
          id,
          candidate: label(c),
          harness: c.harness,
          model: c.model,
          effort: c.effort,
          shape: k.shape,
          caseId: k.id,
          rep,
          contract: CONTRACT[k.shape],
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
          rejected: out.observation.rejected,
          wakeups: out.observation.wakeups,
          checks: out.status === "ok" ? checks.map((ch) => grade(ch, out.observation)) : [],
          wallMs: out.tap?.wallMs ?? null,
          firstTextMs: out.tap?.firstTextMs ?? null,
          usage: out.usage,
          costUsd: out.costUsd,
          models: out.tap?.models ?? [],
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
  const judged = writeJudgeBatch(runDir, file.records);
  console.log(`judge batch: ${judged.items} items in ${join(runDir, "judge")}`);
  console.log(writeSummary(runDir, file));
}

await main();
