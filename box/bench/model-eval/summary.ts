import { calibrationGate, itemScore, MAIN_JUDGE, sameFamily, type Gate, type JudgeKey, type Scores } from "./judge.ts";
import type { RunFile, RunRecord, RunStatus, Shape } from "./types.ts";
import { SHAPES } from "./types.ts";

export type JudgeScores = { readonly name: string; readonly scores: Scores };
const LINE_REPLY_WINDOW_MS = 50_000;
export const MODEL_FAILED: ReadonlySet<RunStatus> = new Set(["invalid_output", "cut_off", "refused"]);

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const secs = (ms: number | null) => ms === null ? "-" : (ms / 1000).toFixed(1);
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (n: number) => (n * 100).toFixed(1) + "%";

type Tally = { readonly mean: number | null; readonly count: number };
type JudgeTallies = { readonly independent: Tally; readonly sameFamily: Tally };
type Row = {
  readonly candidate: string;
  readonly shape: Shape;
  readonly runs: number;
  readonly ok: number;
  readonly graded: number;
  readonly casesPassed: number;
  readonly qualityPassed: number;
  readonly qualityGraded: number;
  readonly judgeEligible: number;
  readonly checksPassed: number;
  readonly checks: number;
  readonly cleanTurns: number | null;
  readonly medianWallMs: number | null;
  readonly medianFirstTextMs: number | null;
  readonly timeouts: number;
  readonly missedLineWindow: number | null;
  readonly tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } | null;
  readonly usageKnown: number;
  readonly costUsd: number | null;
  readonly costKnown: number;
  readonly judges: Readonly<Record<string, JudgeTallies>>;
};

type Verdict = "pass" | "fail" | "pending";

function deterministic(r: RunRecord): Verdict {
  if (MODEL_FAILED.has(r.status)) return "fail";
  if (r.status !== "ok") return "pending";
  if (r.checks.some((c) => c.available !== false && !c.pass)) return "fail";
  return r.checks.length && r.checks.every((c) => c.pass && c.available !== false) ? "pass" : "pending";
}

function gradebook(key: JudgeKey | null, judges: readonly JudgeScores[]) {
  const entries = Object.entries(key ?? {});
  const batch = new Map(entries.flatMap(([id, entry]) => "record" in entry ? [[entry.record, { id, entry }] as const] : []));
  const gates = new Map<string, Gate>(key ? judges.map((j) => [j.name, calibrationGate(key, j.scores)]) : []);
  const item = (r: RunRecord, judge: JudgeScores) => {
    if (!gates.get(judge.name)?.proven) return null;
    const found = batch.get(r.id);
    const answers = found ? judge.scores[found.id] : undefined;
    return found && answers ? itemScore(found.entry, answers) : null;
  };
  const primary = judges.find((j) => j.name.toLowerCase() === MAIN_JUDGE);
  const quality = (r: RunRecord): Verdict => {
    const facts = deterministic(r);
    if (facts !== "pass") return facts;
    if (!primary || sameFamily(r, primary.name)) return "pending";
    const meaning = item(r, primary);
    return meaning === null ? "pending" : meaning === 1 ? "pass" : "fail";
  };
  return { gates, batch, item, quality };
}

function tally(scores: readonly number[]): Tally {
  return { mean: scores.length ? sum(scores) / scores.length : null, count: scores.length };
}

export function rows(run: RunFile, key: JudgeKey | null, judges: readonly JudgeScores[]): Row[] {
  const book = gradebook(key, judges);
  const out: Row[] = [];
  const candidates = [...new Set(run.records.map((r) => r.candidate))];
  for (const candidate of candidates) {
    for (const shape of SHAPES) {
      const rs = run.records.filter((r) => r.candidate === candidate && r.shape === shape);
      if (!rs.length) continue;
      const ok = rs.filter((r) => r.status === "ok");
      const used = rs.flatMap((r) => r.usage ? [r.usage] : []);
      const costs = rs.flatMap((r) => r.costUsd === null ? [] : [r.costUsd]);
      const checks = ok.flatMap((r) => r.checks.filter((c) => c.available !== false));
      const facts = rs.map(deterministic);
      const quality = rs.map(book.quality);
      const judgements = judges.map((judge) => {
        const independent: number[] = [];
        const own: number[] = [];
        for (const r of ok) {
          const score = book.item(r, judge);
          if (score !== null) (sameFamily(r, judge.name) ? own : independent).push(score);
        }
        return [judge.name, { independent: tally(independent), sameFamily: tally(own) }];
      });
      const hasProduct = rs.some((r) => r.contract === "product");
      out.push({
        candidate, shape,
        runs: rs.length,
        ok: ok.length,
        graded: facts.filter((v) => v !== "pending").length,
        casesPassed: facts.filter((v) => v === "pass").length,
        qualityGraded: quality.filter((v) => v !== "pending").length,
        qualityPassed: quality.filter((v) => v === "pass").length,
        judgeEligible: ok.filter((r) => book.batch.has(r.id)).length,
        checksPassed: checks.filter((c) => c.pass).length,
        checks: checks.length,
        cleanTurns: hasProduct ? ok.filter((r) => r.contract === "product" && r.rejected.length === 0).length : null,
        medianWallMs: median(ok.flatMap((r) => r.wallMs === null ? [] : [r.wallMs])),
        medianFirstTextMs: median(ok.flatMap((r) => r.firstTextMs === null ? [] : [r.firstTextMs])),
        timeouts: rs.filter((r) => r.status === "timeout").length,
        missedLineWindow: shape === "build" ? null : rs.filter((r) => r.status === "timeout" || (r.wallMs !== null && r.wallMs >= LINE_REPLY_WINDOW_MS)).length,
        tokens: used.length ? {
          input: sum(used.map((u) => u.input_tokens)),
          output: sum(used.map((u) => u.output_tokens)),
          cacheRead: sum(used.map((u) => u.cache_read_input_tokens ?? 0)),
          cacheWrite: sum(used.map((u) => u.cache_creation_input_tokens ?? 0)),
        } : null,
        usageKnown: used.length,
        costUsd: costs.length ? sum(costs) : null,
        costKnown: costs.length,
        judges: Object.fromEntries(judgements),
      });
    }
  }
  return out;
}

const showTally = ({ mean, count }: Tally) => `${mean === null ? "-" : pct(mean)} (n=${count})`;

export function render(run: RunFile, key: JudgeKey | null, judges: readonly JudgeScores[], quarantined = 0): string {
  const book = gradebook(key, judges);
  const head = [
    "candidate", "shape", "ok/runs", "deterministic passes/graded", "quality passes/graded", "checks passed", "clean turns",
    "median CLI wall s", "median first internal text s", "timeouts", "CLI wall ≥ 50 s",
    "tokens in/out/cache read/cache write (runs reporting)", "cost USD (runs reporting)", "judge batch samples",
    ...judges.flatMap((j) => [`${j.name} independent`, `${j.name} same family`]),
  ];
  const lines = [
    `# Model eval ${run.meta.startedAt}`, "",
    `Commit ${run.meta.gitSha}. CLI ${run.meta.cliVersion ?? "unknown"} (${run.meta.cli}). Login ${run.meta.auth ? `${run.meta.auth.authMethod}, signed ${run.meta.auth.loggedIn ? "in" : "out"}` : "unknown"}. Now ${run.meta.now}${run.meta.nowPinned ? " (pinned)" : " (today)"} Asia/Bangkok.`, "",
    `Quality passes require all deterministic checks and yes on every question from a calibrated ${MAIN_JUDGE}. Pending items are left out of the quality denominator. Other judges show the mean share of yes answers and scored samples, with their own family's outputs shown separately.`,
    "Chat and reminders use the product contract. Drafts and builds use the planned contract. Cost is the CLI's API-price equivalent. CLI wall time gives a lower bound on missed LINE reply windows, with timeouts included. First internal text is not sent to the person.", "",
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows(run, key, judges).map((r) => `| ${[
      r.candidate, r.shape, `${r.ok}/${r.runs}`,
      `${r.casesPassed}/${r.graded}`, `${r.qualityPassed}/${r.qualityGraded}`,
      `${r.checksPassed}/${r.checks}`, r.cleanTurns === null ? "-" : `${r.cleanTurns}/${r.ok}`,
      secs(r.medianWallMs), secs(r.medianFirstTextMs), String(r.timeouts),
      r.missedLineWindow === null ? "n/a" : String(r.missedLineWindow),
      r.tokens === null ? `unknown (0/${r.runs})` : `${r.tokens.input}/${r.tokens.output}/${r.tokens.cacheRead}/${r.tokens.cacheWrite} (${r.usageKnown}/${r.runs})`,
      r.costUsd === null ? `unknown (0/${r.runs})` : `${r.costUsd.toFixed(4)} (${r.costKnown}/${r.runs})`,
      String(r.judgeEligible),
      ...judges.flatMap((j) => [showTally(r.judges[j.name].independent), showTally(r.judges[j.name].sameFamily)]),
    ].join(" | ")} |`),
    "",
    `Known cost USD ${sum(run.records.map((r) => r.costUsd ?? 0)).toFixed(4)} over ${run.records.filter((r) => r.costUsd !== null).length} of ${run.records.length} runs; the rest reported none. Session seeds are recorded separately.`,
  ];
  const notes: string[] = [];
  const mismatched = run.records.filter((r) => r.dateMismatch && r.shape === "reminder").length;
  if (mismatched) notes.push(`${mismatched} reminder runs used a pinned date different from the machine date, which the CLI may include in its prompt.`);
  const discarded = run.records.filter((r) => MODEL_FAILED.has(r.status));
  if (discarded.length) notes.push(`Replies the Worker would discard: ${discarded.map((r) => `${r.id} ${r.status}`).join(", ")}.`);
  const failed = run.records.filter((r) => r.status !== "ok" && !MODEL_FAILED.has(r.status));
  if (failed.length) notes.push(`Inconclusive runs: ${failed.map((r) => `${r.id} ${r.status}${r.error ? ` (${r.error})` : ""}`).join(", ")}.`);
  const drafts = run.records.filter((r) => r.shape === "draft");
  if (drafts.length) notes.push(`Drafts over the Worker's 600-character cut: ${drafts.filter((r) => r.status === "ok" && r.overReplyCap).length}.`);
  const friday = run.records.filter((r) => r.caseId === "reminder-next-friday" && r.status === "ok").map((r) => r.checks.find((c) => c.check === "due_at")?.detail ?? "");
  const read = (label: string) => friday.filter((d) => d.startsWith(label)).length;
  if (friday.length) notes.push(`Next Friday readings: coming ${read("coming")}, next week ${read("next week")}, neither ${friday.length - read("coming") - read("next week")}.`);
  for (const [name, g] of book.gates) {
    notes.push(`Judge ${name} calibration ${g.checked - g.mismatches.length}/${g.checked} planted answers and trio ${[g.good, g.flat, g.bad].map((n) => Number.isFinite(n) ? pct(n) : "-").join(" / ")}. ${g.proven ? "Proven." : "Unproven. Candidate scores omitted."}`);
    if (g.mismatches.length) notes.push(`Judge ${name} mismatches: ${g.mismatches.join(", ")}.`);
  }
  if (quarantined) notes.push(`${quarantined} items were quarantined for model identification. See judge-quarantine.json.`);
  if (!judges.length) notes.push("No judge scores yet. The judge batch is in judge/.");
  const replay = new Map<string, number>();
  for (const r of run.records) for (const gap of r.replay ?? []) replay.set(gap, (replay.get(gap) ?? 0) + 1);
  for (const [gap, count] of replay) notes.push(`Replay: ${count} records, ${gap}.`);
  const failures = run.records.filter((r) => book.quality(r) === "fail");
  if (failures.length) notes.push(
    "Structural signals on failed cases:",
    ...failures.map((r) => `${r.id}: ${r.structuralSignals ? r.structuralSignals.join(", ") || "none" : "unavailable"}.`),
  );
  for (const r of run.records.filter((r) => r.sessionStages?.length)) {
    const stages = r.sessionStages ?? [];
    const details = stages.map(({ requestedModel, resumed, tap }) =>
      `${tap?.reportedModel ?? requestedModel} ${resumed ? "resumed" : "new/unconfirmed"}: ${secs(tap?.wallMs ?? null)} s, cache ${tap?.usage?.cache_read_input_tokens ?? "?"}/${tap?.usage?.cache_creation_input_tokens ?? "?"}`,
    );
    notes.push(`${r.id} CLI wall and cache read/write per turn: ${details.join("; ")}.`);
  }
  return `${[...lines, "", ...notes.map((n) => `- ${n}`)].join("\n")}\n`;
}
