import { calibrationGate, itemScore, type Gate, type JudgeKey, type Scores } from "./judge.ts";
import type { RunFile, RunRecord, Shape } from "./types.ts";
import { SHAPES } from "./types.ts";

export type JudgeScores = { readonly name: string; readonly scores: Scores };

const LINE_REPLY_WINDOW_MS = 50_000;

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
  readonly runs: number;
  readonly ok: number;
  readonly casesPassed: number;
  readonly checksPassed: number;
  readonly checks: number;
  readonly medianWallMs: number | null;
  readonly medianFirstTextMs: number | null;
  readonly overWindow: number;
  readonly tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly costUsd: number;
  readonly judges: Readonly<Record<string, number | null>>;
};

function judgeMean(records: readonly RunRecord[], key: JudgeKey, scores: Scores): number | null {
  const ids = new Set(records.map((r) => r.id));
  const got = Object.entries(key)
    .filter(([id, e]) => "record" in e && ids.has(e.record) && scores[id])
    .map(([id]) => itemScore(scores[id]));
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
      const walls = ok.map((r) => r.wallMs);
      out.push({
        candidate,
        shape,
        runs: rs.length,
        ok: ok.length,
        casesPassed: ok.filter((r) => r.checks.every((c) => c.pass)).length,
        checksPassed: sum(ok.map((r) => r.checks.filter((c) => c.pass).length)),
        checks: sum(ok.map((r) => r.checks.length)),
        medianWallMs: median(walls),
        medianFirstTextMs: median(ok.flatMap((r) => (r.firstTextMs === null ? [] : [r.firstTextMs]))),
        overWindow: walls.filter((w) => w > LINE_REPLY_WINDOW_MS).length,
        tokens: {
          input: sum(rs.map((r) => r.usage?.input_tokens ?? 0)),
          output: sum(rs.map((r) => r.usage?.output_tokens ?? 0)),
          cacheRead: sum(rs.map((r) => r.usage?.cache_read_input_tokens ?? 0)),
          cacheWrite: sum(rs.map((r) => r.usage?.cache_creation_input_tokens ?? 0)),
        },
        costUsd: sum(rs.map((r) => r.costUsd ?? 0)),
        judges: Object.fromEntries(judges.map((j) => [j.name, key ? judgeMean(ok, key, j.scores) : null])),
      });
    }
  }
  return out;
}

export function render(run: RunFile, key: JudgeKey | null, judges: readonly JudgeScores[]): string {
  const table = rows(run, key, judges);
  const gates = new Map<string, Gate>(key ? judges.map((j) => [j.name, calibrationGate(key, j.scores)]) : []);
  const judgeCols = judges.map((j) => `judge ${j.name}${gates.get(j.name)?.proven ? "" : " (unproven)"}`);
  const head = ["candidate", "shape", "ok/runs", "cases passed", "checks passed", "median wall s", "median first text s", "over 50 s", "tokens in/out/cache read/cache write", "cost USD", ...judgeCols];
  const lines = [
    `# Model eval ${run.meta.startedAt}`,
    "",
    `Commit ${run.meta.gitSha}. CLI ${run.meta.cliVersion ?? "unknown"} (${run.meta.cli}). Login ${run.meta.auth ? `${run.meta.auth.authMethod}, signed ${run.meta.auth.loggedIn ? "in" : "out"}` : "unknown"}. Now ${run.meta.now}${run.meta.nowPinned ? " (pinned)" : " (today)"} Asia/Bangkok.`,
    "",
    "Cost is the CLI's total_cost_usd, an API-price equivalent, not plan usage. Only runs with status ok count toward checks and cases; the rest are inconclusive. Chat and reminder run on the product path; draft and build run on the planned contract.",
    "",
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...table.map((r) =>
      `| ${[
        r.candidate,
        r.shape,
        `${r.ok}/${r.runs}`,
        `${r.casesPassed}/${r.ok}`,
        `${r.checksPassed}/${r.checks}`,
        secs(r.medianWallMs),
        secs(r.medianFirstTextMs),
        String(r.overWindow),
        `${r.tokens.input}/${r.tokens.output}/${r.tokens.cacheRead}/${r.tokens.cacheWrite}`,
        r.costUsd.toFixed(4),
        ...judges.map((j) => (r.judges[j.name] == null ? "-" : (r.judges[j.name] as number).toFixed(2))),
      ].join(" | ")} |`,
    ),
    "",
    `Total cost USD ${sum(run.records.map((r) => r.costUsd ?? 0)).toFixed(4)} over ${run.records.length} runs.`,
  ];
  const notes: string[] = [];
  const mismatched = run.records.filter((r) => r.dateMismatch && r.shape === "reminder").length;
  if (mismatched) notes.push(`${mismatched} reminder runs saw a "now" on another date than the machine's, which the CLI also puts in its prompt. Read those reminder numbers with that in mind.`);
  const failed = run.records.filter((r) => r.status !== "ok");
  if (failed.length) notes.push(`Inconclusive runs: ${failed.map((r) => `${r.id} ${r.status}`).join(", ")}.`);
  const long = run.records.filter((r) => r.shape === "draft" && r.status === "ok" && r.overReplyCap).length;
  if (run.records.some((r) => r.shape === "draft")) notes.push(`Drafts over the Worker's 600-character cut: ${long}.`);
  const friday = run.records.filter((r) => r.caseId === "reminder-next-friday" && r.status === "ok").map((r) => r.checks.find((c) => c.check === "due_at")?.detail ?? "");
  const read = (label: string) => friday.filter((d) => d.startsWith(label)).length;
  if (friday.length) notes.push(`"Next Friday" readings: coming ${read("coming")}, next week ${read("next week")}, neither ${friday.length - read("coming") - read("next week")}.`);
  for (const [name, g] of gates) notes.push(`Judge ${name} calibration good ${g.good.toFixed(2)}, flat ${g.flat.toFixed(2)}, bad ${g.bad.toFixed(2)}: ${g.proven ? "proven" : "unproven, so its scores don't count"}.`);
  if (judges.length === 0) notes.push("No judge scores yet. The judge batch is in judge/.");
  return `${[...lines, "", ...notes.map((n) => `- ${n}`)].join("\n")}\n`;
}
