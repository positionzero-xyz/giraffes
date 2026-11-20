import { registerHooks } from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Batch, InboxItem, TurnCommit, TurnView } from "../src/agent/turn.ts";
import type { AgentEvent, EpochMs, LocalDateTime, MicroUsd, TimeZone, WakeupId, WakeupKey } from "../src/domain.ts";
import type { Attempt, Endpoint, Meter, SchemaMode, Usage } from "../src/model/client.ts";
import type { ModelRef, ProviderId } from "../src/model/providers.ts";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});

const { connect, runParse, SecretKey } = await import("../src/model/client.ts");
const { fitPrompt } = await import("../src/model/prompt.ts");
const { isProviderId, PROVIDERS } = await import("../src/model/providers.ts");
const { PROMPT_FLOOR_BYTES, routeFor } = await import("../src/model/routes.ts");
const { costOf, estimate } = await import("../src/policy/spend.ts");
const { renderUser, planTurn, TurnOutputSchema } = await import("../src/agent/turn.ts");
const { compactionCommit, CompactionOutputSchema, planCompaction } = await import("../src/agent/compaction.ts");
const { COMPACTION_SYSTEM, TURN_SYSTEM } = await import("../src/agent/prompt.ts");
const { fromLocal, localDate, parseLocalDateTime, parseTimeZone } = await import("../src/policy/time.ts");

const USAGE = `usage: node scripts/eval.ts --routes <provider:model,...> [--yes] [--fixtures eval/fixtures] [--only <tag>]
  [--repeat 3] [--mode strict|loose|both] [--max-usd 2] [--gate valid=0.98,checks=0.9,month_usd=0.6] [--out eval/out]
Keys come from <PROVIDER>_API_KEY (OPENROUTER_API_KEY, OPENCODE_GO_API_KEY, ...); a custom provider also needs <PROVIDER>_BASE_URL.`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  return process.argv[at + 1] ?? fail(USAGE);
}

const At = z.string().refine((s) => parseLocalDateTime(s) !== null, "a local date and time, YYYY-MM-DDTHH:mm");
const TAGS = ["chat", "reminder", "plan", "checkin", "correction", "compaction", "long"] as const;

const TurnCheck = z.discriminatedUnion("check", [
  z.object({ check: z.literal("sends"), min: z.number().int().optional(), max: z.number().int().optional() }),
  z.object({ check: z.literal("replies_in"), lang: z.enum(["th", "en"]) }),
  z.object({ check: z.literal("schedules"), key: z.string().optional(), at: At, asked: z.boolean().optional() }),
  z.object({ check: z.literal("cancels"), key: z.string() }),
  z.object({ check: z.literal("no_schedule") }),
  z.object({ check: z.literal("no_rejections") }),
  z.object({ check: z.literal("mentions"), any: z.array(z.string()).min(1) }),
  z.object({ check: z.literal("proposes") }),
]);
const CompactionCheck = z.discriminatedUnion("check", [
  z.object({ check: z.literal("keeps"), any: z.array(z.string()).min(1) }),
  z.object({ check: z.literal("max_chars"), n: z.number().int() }),
]);
const Base = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  lang: z.enum(["th", "en"]),
  tags: z.array(z.enum(TAGS)),
  now: At,
  tz: z.string().refine((s) => parseTimeZone(s) !== null, "an IANA time zone"),
  memory: z.object({ summary: z.string(), notes: z.array(z.string()) }).optional(),
  pending: z.array(z.object({ key: z.string(), due: At, note: z.string(), origin: z.enum(["person", "agent"]) })).optional(),
  history: z.array(z.object({ role: z.enum(["person", "agent", "note"]), at: At, text: z.string() })).optional(),
});
const Fixture = z.discriminatedUnion("purpose", [
  Base.extend({
    purpose: z.literal("turn"),
    batch: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("message"), text: z.string() }),
          z.object({ kind: z.literal("wakeup"), key: z.string(), origin: z.enum(["person", "agent"]), lateMinutes: z.number().optional() }),
          z.object({ kind: z.literal("checkin") }),
        ]),
      )
      .min(1),
    expect: z.array(TurnCheck),
  }),
  Base.extend({ purpose: z.literal("compaction"), turns: z.number().int().min(61).default(61), expect: z.array(CompactionCheck) }),
]);
type Fixture = z.infer<typeof Fixture>;
type TurnFixture = Extract<Fixture, { purpose: "turn" }>;

type Check = { readonly name: string; readonly pass: boolean; readonly detail?: string };
type EvalRow = {
  readonly route: ModelRef;
  readonly fixture: string;
  readonly rep: number;
  readonly mode: SchemaMode;
  readonly outcome: "valid" | "repaired" | "invalid" | "refused" | "error";
  readonly error?: string;
  readonly checks: readonly Check[];
  readonly usage: Usage | null;
  readonly costMicro: number;
  readonly reportedMicro: number | null;
  readonly promptBytes: number;
  readonly latencyMs: number;
};

const routesArg = flag("routes", "");
if (!routesArg) fail(USAGE);
const fixturesDir = resolve(flag("fixtures", "eval/fixtures"));
const only = flag("only", "");
const repeat = Number(flag("repeat", "3"));
const modeArg = flag("mode", "provider");
const maxUsd = Number(flag("max-usd", "2"));
const outDir = resolve(flag("out", "eval/out"));
const gate = Object.fromEntries(
  flag("gate", "")
    .split(",")
    .filter(Boolean)
    .map((kv) => kv.split("=") as [string, string])
    .map(([k, v]) => [k, Number(v)]),
) as Partial<Record<"valid" | "checks" | "month_usd", number>>;
if (!Number.isInteger(repeat) || repeat < 1 || !Number.isFinite(maxUsd) || !["provider", "strict", "loose", "both"].includes(modeArg)) fail(USAGE);

type Target = { readonly ref: ModelRef; readonly provider: ProviderId; readonly model: string; readonly endpoint: Endpoint; readonly modes: readonly SchemaMode[] };

function targetOf(ref: string): Target {
  const at = ref.indexOf(":");
  const provider = ref.slice(0, at);
  const model = ref.slice(at + 1);
  if (at < 1 || !model || !isProviderId(provider)) fail(`not a route: ${ref}\n${USAGE}`);
  const p = PROVIDERS[provider];
  const env = provider.toUpperCase().replaceAll("-", "_");
  const key = SecretKey.from(process.env[`${env}_API_KEY`] ?? "") ?? fail(`${env}_API_KEY is required for ${ref}`);
  const baseUrl = (p.baseUrl ?? process.env[`${env}_BASE_URL`] ?? fail(`${env}_BASE_URL is required for ${ref}`)).replace(/\/+$/, "");
  const policy: readonly SchemaMode[] = p.schema === "loose" ? ["loose"] : ["strict"];
  const modes: readonly SchemaMode[] = modeArg === "provider" ? policy : modeArg === "both" ? ["strict", "loose"] : [modeArg as SchemaMode];
  return {
    ref: `${provider}:${model}`,
    provider,
    model,
    endpoint: { provider, protocol: p.protocol, baseUrl, auth: p.auth, key, headers: p.headers({ session: "giraffes-eval" }), body: p.body },
    modes,
  };
}

const targets = routesArg.split(",").map((r) => targetOf(r.trim()));
const fixtures: Fixture[] = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => {
    const parsed = Fixture.safeParse(JSON.parse(readFileSync(join(fixturesDir, f), "utf8")));
    if (!parsed.success) fail(`${f}: ${parsed.error.message}`);
    return parsed.data;
  })
  .filter((f) => !only || f.tags.some((t) => t === only));
if (fixtures.length === 0) fail(`no fixtures in ${fixturesDir}${only ? ` tagged ${only}` : ""}`);

const tzOf = (f: Fixture) => parseTimeZone(f.tz) as TimeZone;
const at = (s: string, tz: TimeZone) => fromLocal(s as LocalDateTime, tz);

function viewOf(f: TurnFixture): TurnView {
  const tz = tzOf(f);
  const now = at(f.now, tz);
  const pending = (f.pending ?? []).map((p, i) => ({
    id: (i + 1) as WakeupId,
    key: p.key as WakeupKey,
    note: p.note,
    dueAt: at(p.due, tz),
    kind: "reminder" as const,
    origin: p.origin,
    task: null,
    bookkeeping: false,
    repeat: null,
  }));
  const eventOf = (b: TurnFixture["batch"][number], i: number): AgentEvent => {
    switch (b.kind) {
      case "message":
        return { kind: "message", text: b.text };
      case "wakeup": {
        const w = pending.find((p) => p.key === b.key);
        const dueAt = (now - (b.lateMinutes ?? 0) * 60_000) as EpochMs;
        return { kind: "wakeup", wakeupId: (100 + i) as WakeupId, key: b.key as WakeupKey, origin: b.origin, note: w?.note ?? b.key, dueAt, firedAt: now, task: null, bookkeeping: false, repeat: null };
      }
      case "checkin":
        return { kind: "checkin", day: localDate(now, tz), dueAt: now, firedAt: now };
    }
  };
  const items = f.batch.map((b, i): InboxItem => ({ key: `eval:${f.id}:${i}` as InboxItem["key"], event: eventOf(b, i), attempts: 1, receivedAt: now }));
  return {
    now,
    tz,
    language: f.lang,
    status: "active",
    statusAt: 0 as EpochMs,
    checkinLocal: "09:00" as TurnView["checkinLocal"],
    admission: { state: "admitted", seat: { cohort: "staff", half: null, code: null, inviter: null }, at: 0 as EpochMs },
    batch: { items: items as unknown as Batch["items"] },
    summary: f.memory?.summary ?? "",
    notes: f.memory?.notes ?? [],
    recent: (f.history ?? []).map((h) => ({ role: h.role, text: h.text, at: at(h.at, tz) })),
    historyLeftOut: 0,
    pending: pending.filter((p) => !f.batch.some((b) => b.kind === "wakeup" && b.key === p.key)),
    openTasks: [],
    acceptable: null,
    tapped: [],
    unaskedLeftToday: 3,
  };
}

const THAI = /[฀-๿]/g;
const thaiShare = (s: string) => (s.match(THAI)?.length ?? 0) / Math.max(1, s.replace(/\s/g, "").length);

function turnChecks(f: TurnFixture, commit: TurnCommit): Check[] {
  const tz = tzOf(f);
  const texts = commit.outbound?.texts ?? [];
  const said = texts.join("\n");
  return f.expect.map((c): Check => {
    switch (c.check) {
      case "sends": {
        const n = texts.length;
        return { name: "sends", pass: n >= (c.min ?? 1) && n <= (c.max ?? Infinity), detail: `${n}` };
      }
      case "replies_in": {
        const share = thaiShare(said);
        return { name: `${c.lang}:replies_in`, pass: c.lang === "th" ? share >= 0.3 : share <= 0.05, detail: share.toFixed(2) };
      }
      case "schedules": {
        const due = at(c.at, tz);
        const hit = commit.wakeupsAdd.some((w) => w.dueAt === due && (c.key === undefined || w.key === c.key) && (c.asked === undefined || (w.origin === "person") === c.asked));
        const moved = commit.wakeupsRetime.some((w) => w.dueAt === due && (c.key === undefined || w.key === c.key));
        return { name: "schedules.at", pass: hit || moved, detail: commit.wakeupsAdd.map((w) => `${w.key}@${w.dueAt}`).join(" ") };
      }
      case "cancels":
        return { name: "cancels", pass: commit.wakeupsCancel.includes(c.key as WakeupKey) };
      case "no_schedule":
        return { name: "no_schedule", pass: commit.wakeupsAdd.length === 0 };
      case "no_rejections":
        return { name: "no_rejections", pass: commit.rejected.length === 0, detail: commit.rejected.map((r) => r.reason).join(" ") };
      case "mentions":
        return { name: "mentions", pass: c.any.some((w) => said.toLowerCase().includes(w.toLowerCase())) };
      case "proposes":
        return { name: "proposes", pass: commit.tasks.propose !== null };
    }
  });
}

let spentMicro = 0;
let stopped = false;

function meter(sink: { cost: number; reported: number | null }): Meter {
  return {
    reserve(r, promptBytes) {
      const est = estimate(r, promptBytes);
      if (spentMicro + est > maxUsd * 1_000_000) {
        stopped = true;
        return null;
      }
      spentMicro += est;
      return { id: crypto.randomUUID(), estimate: est };
    },
    settle(reserved, r, outcome: Attempt<unknown>) {
      const cost =
        outcome.kind === "ok" || outcome.kind === "invalid" || outcome.kind === "refused_by_model"
          ? costOf(r, outcome.usage, outcome.reported)
          : outcome.kind === "in_doubt"
            ? reserved.estimate
            : (0 as MicroUsd);
      spentMicro += cost - reserved.estimate;
      sink.cost += cost;
      if ("reported" in outcome && outcome.reported !== null) sink.reported = (sink.reported ?? 0) + outcome.reported;
    },
  };
}

const utf8 = new TextEncoder();

async function runOne(t: Target, mode: SchemaMode, f: Fixture, rep: number): Promise<EvalRow> {
  const route = routeFor({ kind: "key", provider: t.provider, model: t.model }, f.purpose);
  const sink = { cost: 0, reported: null as number | null };
  const client = connect(fetch)(t.endpoint);
  const started = Date.now();
  const base = { route: t.ref, fixture: f.id, rep, mode };
  if (f.purpose === "turn") {
    const view = viewOf(f);
    const user = fitPrompt(renderUser(view), route.promptBytes - utf8.encode(TURN_SYSTEM).length);
    const out = await runParse(client, { route, mode, system: TURN_SYSTEM, user, schema: TurnOutputSchema }, meter(sink));
    return finish(base, out.last, out.attempts, sink, utf8.encode(TURN_SYSTEM + user).length, started, (v) => turnChecks(f, planTurn(v as Parameters<typeof planTurn>[0], view)));
  }
  const tz = tzOf(f);
  const oldest = (f.history ?? []).map((h, i) => ({ seq: i + 1, role: h.role, text: h.text, at: at(h.at, tz) }));
  const plan = planCompaction(
    { summary: f.memory?.summary ?? "", throughSeq: 0, turnCount: f.turns, oldestTurns: oldest, noteCount: f.memory?.notes.length ?? 0, oldestNotes: (f.memory?.notes ?? []).map((text, i) => ({ id: i + 1, text })) },
    PROMPT_FLOOR_BYTES.compaction - utf8.encode(COMPACTION_SYSTEM).length,
  );
  if (!plan) return { ...base, outcome: "error", error: "fixture not due for compaction", checks: [], usage: null, costMicro: 0, reportedMicro: null, promptBytes: 0, latencyMs: 0 };
  const user = fitPrompt(plan.prompt, route.promptBytes);
  const out = await runParse(client, { route, mode, system: COMPACTION_SYSTEM, user, schema: CompactionOutputSchema }, meter(sink));
  return finish(base, out.last, out.attempts, sink, utf8.encode(COMPACTION_SYSTEM + user).length, started, (v) => {
    const summary = compactionCommit(plan, v as z.infer<typeof CompactionOutputSchema>).summary;
    return f.expect.map((c) =>
      c.check === "keeps"
        ? { name: "keeps", pass: c.any.some((w) => summary.toLowerCase().includes(w.toLowerCase())) }
        : { name: "max_chars", pass: summary.length <= c.n, detail: `${summary.length}` },
    );
  });
}

function finish(
  base: Pick<EvalRow, "route" | "fixture" | "rep" | "mode">,
  last: Attempt<unknown> | null,
  attempts: number,
  sink: { cost: number; reported: number | null },
  promptBytes: number,
  started: number,
  checks: (value: unknown) => Check[],
): EvalRow {
  const common = { costMicro: sink.cost, reportedMicro: sink.reported, promptBytes, latencyMs: Date.now() - started };
  if (last === null) return { ...base, outcome: "error", error: "over --max-usd", checks: [], usage: null, ...common };
  switch (last.kind) {
    case "ok":
      return { ...base, outcome: attempts > 1 ? "repaired" : "valid", checks: checks(last.value), usage: last.usage, ...common };
    case "invalid":
      return { ...base, outcome: "invalid", error: last.issues.split("\n")[0], checks: [], usage: last.usage, ...common };
    case "refused_by_model":
      return { ...base, outcome: "refused", checks: [], usage: last.usage, ...common };
    case "fault":
      return { ...base, outcome: "error", error: `provider ${last.fault}`, checks: [], usage: null, ...common };
    case "turned_away":
    case "rejected":
    case "in_doubt":
      return { ...base, outcome: "error", error: last.kind, checks: [], usage: null, ...common };
  }
}

const calls = targets.reduce((n, t) => n + t.modes.length, 0) * fixtures.length * repeat;
const upperBound = targets.reduce(
  (sum, t) =>
    sum +
    t.modes.length *
      repeat *
      fixtures.reduce((s, f) => {
        const route = routeFor({ kind: "key", provider: t.provider, model: t.model }, f.purpose);
        return s + estimate(route, route.promptBytes) * (t.modes.includes("loose") ? 2 : 1);
      }, 0),
  0,
);
console.log(`routes: ${targets.map((t) => `${t.ref} (${t.modes.join("+")})`).join(", ")}`);
console.log(`fixtures: ${fixtures.length}, repeats: ${repeat}, calls: ${calls}`);
console.log(`upper bound: $${(upperBound / 1e6).toFixed(4)} at list price plus fees, stopping at --max-usd $${maxUsd}`);
if (!process.argv.includes("--yes")) {
  console.log("This spends money on the keys above. Re-run with --yes.");
  process.exit(2);
}

const rows: EvalRow[] = [];
for (const t of targets) {
  for (const mode of t.modes) {
    for (const f of fixtures) {
      for (let rep = 1; rep <= repeat && !stopped; rep++) rows.push(await runOne(t, mode, f, rep));
    }
  }
}

const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((100 * n) / d)}%`);
const median = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const WARM_TURNS_A_MONTH = 900;

const header = ["route", "mode", "valid", "repaired", "checks", "top check fails", "$/turn cold", "$/turn warm", "$/month(900)", "p50/p95 s", "gate"];
const lines: string[][] = [];
let gatesFailed = false;
for (const t of targets) {
  for (const mode of t.modes) {
    const mine = rows.filter((r) => r.route === t.ref && r.mode === mode);
    const ok = mine.filter((r) => r.outcome === "valid" || r.outcome === "repaired");
    const checks = mine.flatMap((r) => r.checks);
    const fails = new Map<string, number>();
    for (const c of checks) if (!c.pass) fails.set(c.name, (fails.get(c.name) ?? 0) + 1);
    const top = [...fails].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, k]) => `${n}(${k})`).join(", ") || "-";
    const turns = mine.filter((r) => fixtures.find((f) => f.id === r.fixture)?.purpose === "turn");
    const cold = mean(turns.filter((r) => r.rep === 1).map((r) => r.costMicro)) / 1e6;
    const warm = mean(turns.filter((r) => r.rep > 1).map((r) => r.costMicro)) / 1e6 || cold;
    const month = warm * WARM_TURNS_A_MONTH;
    const validShare = mine.length ? ok.length / mine.length : 0;
    const checkShare = checks.length ? checks.filter((c) => c.pass).length / checks.length : 0;
    const missed = [
      gate.valid !== undefined && validShare < gate.valid ? "valid" : null,
      gate.checks !== undefined && checkShare < gate.checks ? "checks" : null,
      gate.month_usd !== undefined && month > gate.month_usd ? "month_usd" : null,
    ].filter((x) => x !== null);
    gatesFailed ||= missed.length > 0;
    const latency = mine.map((r) => r.latencyMs / 1000);
    lines.push([
      t.ref,
      mode,
      pct(ok.length, mine.length),
      pct(mine.filter((r) => r.outcome === "repaired").length, mine.length),
      pct(checks.filter((c) => c.pass).length, checks.length),
      top,
      cold.toFixed(5),
      warm.toFixed(5),
      month.toFixed(2),
      `${median(latency, 0.5).toFixed(1)}/${median(latency, 0.95).toFixed(1)}`,
      Object.keys(gate).length === 0 ? "-" : missed.length === 0 ? "PASS" : `FAIL ${missed.join(",")}`,
    ]);
  }
}
const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
for (const l of [header, ...lines]) console.log(l.map((c, i) => c.padEnd(widths[i])).join("  "));
console.log("Costs are list price plus the provider's fee from our price cards, not an invoice.");
if (stopped) console.log(`Stopped starting calls at --max-usd $${maxUsd}.`);

mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, `${JSON.stringify({ routes: targets.map((t) => t.ref), repeat, gate, spentMicro, rows }, null, 2)}\n`);
console.log(`report: ${file}`);
process.exit(gatesFailed ? 1 : 0);
