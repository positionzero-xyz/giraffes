import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentReply } from "../../src/claude.ts";
import { CASES } from "./cases.ts";
import { grade, REPLY_CAP, structuralSignals } from "./checks.ts";
import { buildEvidence, readTap } from "./evidence.ts";
import { NO_OBSERVATION, observationOfCommit, readTurn } from "./product.ts";
import { CONTRACT, type CheckResult, type Observation, type RunFile, type RunRecord, type Stop } from "./types.ts";
import { parseWall } from "./when.ts";

const byId = new Map(CASES.map((c) => [c.id, c]));
const unavailable = (check: string, detail: string): CheckResult => ({ check, pass: false, detail, available: false });

function workerStop(reason: string | null | undefined): Stop | undefined {
  if (reason === undefined) return undefined;
  return reason === "max_tokens" || reason === "refusal" ? reason : "end";
}

export async function regradeRecord(r: RunRecord, source: string, chrome: string | null): Promise<RunRecord> {
  const c = byId.get(r.caseId);
  const now = parseWall(r.now);
  if (!c || !now || r.shape !== c.shape) {
    return { ...r, checks: [unavailable("case", "case or pinned time unavailable")], replay: ["case or pinned time unavailable"] };
  }
  if (r.status !== "ok") return { ...r, structuralSignals: structuralSignals(r) };
  const contract = CONTRACT[c.shape];
  const { checks } = c.make(now);
  const replay: string[] = [];
  const key = r.id.replace(/[^\w.-]+/g, "_");
  const tap = readTap(join(source, "taps", key + ".jsonl"));
  const stopReason = r.stopReason === undefined ? tap?.stopReason : r.stopReason;
  const raw = r.rawOutput ?? tap?.rawOutput ?? r.reply;
  const stop = workerStop(stopReason);
  let o: Observation = { ...NO_OBSERVATION, raw, text: raw.trim(), stop };
  let status = r.status;
  let buildDir = r.buildDir;
  if (c.shape === "build") {
    buildDir = r.buildDir ? join(source, "builds", basename(r.buildDir)) : null;
    if (buildDir && existsSync(buildDir) && chrome) {
      o = { ...o, ...await buildEvidence(chrome, buildDir, checks) };
    } else {
      replay.push("build files or browser unavailable");
    }
  } else if (r.workerCommit) {
    o = observationOfCommit(r.workerCommit, raw, stop, contract);
  } else if (typeof r.message === "string" && typeof raw === "string" && Array.isArray(r.calls) && Array.isArray(r.refusedCalls)) {
    if (stop === undefined) replay.push("original stop reason absent");
    replay.push("Worker commit reconstructed from saved reply and calls");
    const body = {
      text: raw, calls: r.calls, refusedCalls: r.refusedCalls,
      usage: r.usage, stop: stop ?? "end", costUsd: r.costUsd,
    } as Extract<AgentReply, { status: 200 }>["body"];
    const rebuilt = readTurn(body, r.message, now, contract, c.setup);
    o = { ...rebuilt.observation, stop };
    if (stop !== undefined && rebuilt.status !== "ok") status = rebuilt.status;
  } else {
    replay.push("Worker commit and replay inputs absent");
  }
  if (c.shape !== "build" && r.rawOutput === undefined && tap?.rawOutput === undefined) replay.push("only the legacy reply string survives");
  const checked = checks.map((ch) => {
    if (c.shape === "build" && replay.length) return unavailable(ch.kind, replay[0]);
    if (c.shape !== "build" && !o.workerCommit && ch.kind === "replies") return unavailable(ch.kind, "Worker delivery unavailable");
    return grade(ch, o);
  });
  if (c.shape === "draft" && stop === undefined) checked.push(unavailable("stops_clean", "original stop reason absent"));
  const record = {
    ...r, status, buildDir, reply: raw.trim(), delivered: contract === "product" && o.workerCommit ? o.text : (r.delivered ?? null),
    overReplyCap: c.shape !== "build" && raw.trim().length > REPLY_CAP, wakeups: o.wakeups, rejected: o.rejected,
    ...(stopReason === undefined ? {} : { stopReason }), workerCommit: o.workerCommit ?? null,
    pageReport: o.page, checks: checked, replay,
  };
  return { ...record, structuralSignals: structuralSignals(record) };
}

export async function regradeRun(run: RunFile, source: string, chrome: string | null): Promise<RunFile> {
  const records: RunRecord[] = [];
  for (const r of run.records) {
    try {
      records.push(await regradeRecord(r, source, chrome));
    } catch (error) {
      records.push({ ...r, checks: [unavailable("replay", String(error))], replay: ["replay failed"] });
    }
  }
  return { meta: { ...run.meta, regradedAt: new Date().toISOString() }, records };
}
