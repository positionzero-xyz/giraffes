import { calibrationGate, itemScore, type Gate, type JudgeKey, type Scores } from "./judge.ts";
import type { Contract, RunFile, RunRecord, RunStatus, Shape } from "./types.ts";
import { SHAPES } from "./types.ts";

export type JudgeScores = { readonly name: string; readonly scores: Scores };

/** LINE takes a reply token only strictly before 50 s from the inbound event; CLI time alone is a lower bound on that. */
const LINE_REPLY_WINDOW_MS = 50_000;

/** The model answered but the Worker would discard it, so the case failed; other non-ok statuses are inconclusive. */
export const MODEL_FAILED: ReadonlySet<RunStatus> = new Set(["invalid_output", "cut_off", "refused"]);

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const secs = (ms: number | null) => (ms === null ? "-" : (ms / 1000).toFixed(1));
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

export type Row = {
  readonly candidate: string;
  readonly shape: Shape;
  readonly contract: Contract;
  readonly runs: number;
  readonly ok: number;
  readonly graded: number;
  readonly casesPassed: number;
  readonly checksPassed: number;
  readonly checks: number;
  /** Ok product turns the Worker took with no action refused or cut; a diagnostic, not a pass. */
  readonly cleanTurns: number | null;
  readonly medianWallMs: number | null;
  readonly medianFirstTextMs: number | null;
  readonly timeouts: number;
  /** Runs whose CLI time alone reached LINE's cut-off, timeouts included; null for a page build, which no LINE reply carries. */
  readonly missedLineWindow: number | null;
  /** Null when no run reported any. */
  readonly tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } | null;
  readonly usageKnown: number;
  readonly costUsd: number | null;
  readonly costKnown: number;
  readonly judges: Readonly<Record<string, number | null>>;
};

function judgeMean(records: readonly RunRecord[], key: JudgeKey, scores: Scores): number | null {
  if (!calibrationGate(key, scores).proven) return null;
  const ids = new Set(records.map((r) => r.id));
  const got = Object.entries(key)
    .filter(([id, e]) => "record" in e && ids.has(e.record) && scores[id])
    .map(([id, e]) => itemScore(e.shape, scores[id]));
  return got.length ? sum(got) / got.length : null;
}

export function rows(run: RunFile, key: JudgeKey | null, judges: readonly JudgeScores[]): Row[] {
  const out: Row[] = [];
  const candidates = [...new Set(run.records.map((r) => r.candidate))];
  for (const candidate of candidates) {
    for (const shape of SHAPES) {
      const rs = run.records.filter((r) => r.candidate === candidate && r.shape === shape);
      if (rs.length === 0) continue;
      const ok = rs.filter((r) => r.status === "ok");
      const used = rs.flatMap((r) => (r.usage ? [r.usage] : []));
      const costs = rs.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]));
      out.push({
        candidate,
        shape,
        contract: rs[0].contract,
        runs: rs.length,
        ok: ok.length,
        graded: rs.filter((r) => r.status === "ok" || MODEL_FAILED.has(r.status)).length,
        casesPassed: ok.filter((r) => r.checks.every((c) => c.pass)).length,
        checksPassed: sum(ok.map((r) => r.checks.filter((c) => c.pass).length)),
        checks: sum(ok.map((r) => r.checks.length)),
        cleanTurns: ok.some((r) => r.contract === "product") ? ok.filter((r) => r.contract === "product" && r.rejected.length === 0).length : null,
        medianWallMs: median(ok.flatMap((r) => (r.wallMs === null ? [] : [r.wallMs]))),
        medianFirstTextMs: median(ok.flatMap((r) => (r.firstTextMs === null ? [] : [r.firstTextMs]))),
        timeouts: rs.filter((r) => r.status === "timeout").length,
        missedLineWindow: shape === "build" ? null : rs.filter((r) => r.status === "timeout" || (r.wallMs !== null && r.wallMs >= LINE_REPLY_WINDOW_MS)).length,
        tokens: used.length
          ? {
              input: sum(used.map((u) => u.input_tokens)),
              output: sum(used.map((u) => u.output_tokens)),
              cacheRead: sum(used.map((u) => u.cache_read_input_tokens ?? 0)),
              cacheWrite: sum(used.map((u) => u.cache_creation_input_tokens ?? 0)),
            }
          : null,
        usageKnown: used.length,
        costUsd: costs.length ? sum(costs) : null,
        costKnown: costs.length,
        judges: Object.fromEntries(judges.map((j) => [j.name, key ? judgeMean(ok, key, j.scores) : null])),
      });
    }
  }
  return out;
}

export function render(run: RunFile, key: JudgeKey | null, judges: readonly JudgeScores[]): string {
  const table = rows(run, key, judges);
  const claude = run.records.some((r) => r.harness === "claude-code");
  const codex = run.meta.codex ?? null;
  const gates = new Map<string, Gate>(key ? judges.map((j) => [j.name, calibrationGate(key, j.scores)]) : []);
  const judgeCols = judges.map((j) => `judge ${j.name}${gates.get(j.name)?.proven ? "" : " (unproven)"}`);
  const head = ["candidate", "shape", "contract", "ok/runs", "cases passed", "checks passed", "clean turns", "median CLI wall s", "median first internal text s", "timeouts", "CLI wall ≥ 50 s", "tokens in/out/cache read/cache write (runs reporting)", "cost USD (runs reporting)", ...judgeCols];
  const lines = [
    `# Model eval ${run.meta.startedAt}`,
    "",
    [
      `Commit ${run.meta.gitSha}.`,
      claude ? `Claude CLI ${run.meta.cliVersion ?? "unknown"} (${run.meta.cli}), login ${run.meta.auth ? `${run.meta.auth.authMethod}, signed ${run.meta.auth.loggedIn ? "in" : "out"}` : "unknown"}.` : "",
      codex ? `Codex ${codex.version ?? "unknown"} (${codex.cli}) on profile ${codex.profile}, provider ${codex.provider}, in an isolated Codex home.` : "",
      `Now ${run.meta.now}${run.meta.nowPinned ? " (pinned)" : " (today)"} Asia/Bangkok.`,
    ].filter(Boolean).join(" "),
    "",
    `Cost is the Claude CLI's total_cost_usd, an API-price equivalent, not plan usage; Codex reports no cost. A case passes only when its run is ok and every check passes. A reply the Worker would discard (${[...MODEL_FAILED].join(", ")}) counts as a failed case; other statuses are inconclusive and left out. For Claude, chat and reminder run on the product path and draft and build on the planned contract. Giraffe has no Codex path, so every Codex row is planned, but each shape is graded the same way as Claude's. Wall time is the CLI subprocess alone, not inbound to delivery, so "CLI wall ≥ 50 s" (timeouts included) is a lower bound on replies that miss LINE's 50-second window. The first internal text is the CLI's first assistant text, which the Worker never sends; the person gets only the final reply.`,
    "",
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...table.map((r) =>
      `| ${[
        r.candidate,
        r.shape,
        r.contract,
        `${r.ok}/${r.runs}`,
        `${r.casesPassed}/${r.graded}`,
        `${r.checksPassed}/${r.checks}`,
        r.cleanTurns === null ? "-" : `${r.cleanTurns}/${r.ok}`,
        secs(r.medianWallMs),
        secs(r.medianFirstTextMs),
        String(r.timeouts),
        r.missedLineWindow === null ? "n/a" : String(r.missedLineWindow),
        r.tokens === null ? `unknown (0/${r.runs})` : `${r.tokens.input}/${r.tokens.output}/${r.tokens.cacheRead}/${r.tokens.cacheWrite} (${r.usageKnown}/${r.runs})`,
        r.costUsd === null ? `unknown (0/${r.runs})` : `${r.costUsd.toFixed(4)} (${r.costKnown}/${r.runs})`,
        ...judges.map((j) => (r.judges[j.name] == null ? "-" : (r.judges[j.name] as number).toFixed(2))),
      ].join(" | ")} |`,
    ),
    "",
    `Known cost USD ${sum(run.records.map((r) => r.costUsd ?? 0)).toFixed(4)} over ${run.records.filter((r) => r.costUsd !== null).length} of ${run.records.length} runs; the rest reported none.`,
  ];
  const notes: string[] = [];
  if (codex) {
    for (const [mode, tools] of Object.entries(codex.tools)) notes.push(`Tools Codex offered on a ${mode === "turn" ? "chat, reminder or draft turn" : "build"} (read from its first request to a local server, which also refused its model catalog): ${tools?.join(", ") || "none"}.`);
    notes.push("Codex token counts use Claude's meaning: in is the uncached input, cache read is Codex's cached input, and out includes reasoning. Codex doesn't report which model served a turn, and a Code Mode call shows in its events only through what it did.");
  }
  const strays = run.records.filter((r) => (r.otherTools ?? []).length > 0);
  if (strays.length) notes.push(`Runs that used tools other than Giraffe's: ${strays.map((r) => `${r.id} (${r.otherTools.join(", ")})`).join(", ")}.`);
  const mismatched = run.records.filter((r) => r.dateMismatch && r.shape === "reminder").length;
  if (mismatched) notes.push(`${mismatched} reminder runs saw a "now" on another date than the machine's, which the CLI also puts in its prompt. Read those reminder numbers with that in mind.`);
  const discarded = run.records.filter((r) => MODEL_FAILED.has(r.status));
  if (discarded.length) notes.push(`Replies the Worker would discard: ${discarded.map((r) => `${r.id} ${r.status}`).join(", ")}.`);
  const failed = run.records.filter((r) => r.status !== "ok" && !MODEL_FAILED.has(r.status));
  if (failed.length) notes.push(`Inconclusive runs: ${failed.map((r) => `${r.id} ${r.status}`).join(", ")}.`);
  const long = run.records.filter((r) => r.shape === "draft" && r.status === "ok" && r.overReplyCap).length;
  if (run.records.some((r) => r.shape === "draft")) notes.push(`Drafts over the Worker's 600-character cut: ${long}.`);
  const friday = run.records.filter((r) => r.caseId === "reminder-next-friday" && r.status === "ok").map((r) => r.checks.find((c) => c.check === "due_at")?.detail ?? "");
  const read = (label: string) => friday.filter((d) => d.startsWith(label)).length;
  if (friday.length) notes.push(`"Next Friday" readings: coming ${read("coming")}, next week ${read("next week")}, neither ${friday.length - read("coming") - read("next week")}.`);
  for (const [name, g] of gates) notes.push(`Judge ${name} calibration good ${g.good.toFixed(2)}, flat ${g.flat.toFixed(2)}, bad ${g.bad.toFixed(2)}: ${g.proven ? "proven" : "unproven, so the table shows none of its scores"}.`);
  if (judges.length === 0) notes.push("No judge scores yet. The judge batch is in judge/.");
  return `${[...lines, "", ...notes.map((n) => `- ${n}`)].join("\n")}\n`;
}
