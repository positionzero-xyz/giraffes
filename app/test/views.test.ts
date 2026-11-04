import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const START = 4_100_000_000_000;

type Person = { readonly agent: string; readonly cohort: "recruit" | "joiner" | "staff"; readonly half: "th_line" | "intl_telegram" | null; readonly consentedAt: number };

const run = (sql: string, ...params: unknown[]) => env.LEDGER.prepare(sql).bind(...params).run();
const rows = async (sql: string) => (await env.LEDGER.prepare(sql).all()).results;

let seq = 0;
const next = () => ++seq;

async function beta(): Promise<void> {
  await run("INSERT INTO beta (one, starts_at) VALUES (1, ?)", START);
}

async function enroll(p: Person, inviter: string | null = null): Promise<void> {
  await run(
    "INSERT INTO enrollment (agent_key, code, cohort, half, inviter, channel, seated_at) VALUES (?, ?, ?, ?, ?, 'telegram', ?)",
    p.agent,
    `C${next()}`,
    p.cohort,
    p.half,
    inviter,
    p.consentedAt,
  );
  await run("INSERT INTO admission_log (id, agent_key, change, reason, channel, at) VALUES (?, ?, 'consented', ?, 'telegram', ?)", `${p.agent}|a`, p.agent, p.cohort, p.consentedAt);
}

/** A task that the person completed by accepting its plan at `at`, by tap or typed. */
async function completed(agent: string, at: number, via: "tap" | "typed" = "tap"): Promise<string> {
  const task = `${agent}|t${next()}`;
  await run("INSERT INTO task (id, agent_key, ref, kind, title, cause_kind, opened_at) VALUES (?, ?, 'trip', 'plan', 'A trip', 'checkin', ?)", task, agent, at - DAY);
  await run(
    `INSERT INTO task_fact (id, agent_key, task_id, kind, ref, detail, completes, person_decision, cause_kind, cause_at, at)
     VALUES (?, ?, ?, 'plan_accepted', '1.1', ?, 1, 1, 'choice', ?, ?)`,
    `${agent}|f${next()}`,
    agent,
    task,
    JSON.stringify({ via, version: 1 }),
    at,
    at,
  );
  return task;
}

async function unasked(agent: string, task: string | null, at: number, purpose = "task_followup"): Promise<string> {
  const id = `o${next()}`;
  await run(
    "INSERT INTO unasked_message (id, agent_key, trigger_kind, text, status, day, at, task_id, purpose) VALUES (?, ?, 'checkin', 'Morning!', 'sent', NULL, ?, ?, ?)",
    id,
    agent,
    at,
    task,
    purpose,
  );
  return id;
}

async function wrote(agent: string, at: number): Promise<void> {
  await run(
    "INSERT INTO turn_log (id, agent_key, event_kind, batch_size, outcome, refused_for_budget, cost_micro, attempts, started_at, finished_at) VALUES (?, ?, 'message', 1, 'acted', 0, 1000, 1, ?, ?)",
    `${agent}|turn${next()}`,
    agent,
    at,
    at,
  );
}

const ana: Person = { agent: "p:line:ana", cohort: "recruit", half: "th_line", consentedAt: START };
const ben: Person = { agent: "p:telegram:ben", cohort: "recruit", half: "intl_telegram", consentedAt: START + DAY };

describe("gate views", () => {
  test("without a beta start there are no participants, and both halves still report", async () => {
    await enroll(ana);
    await completed(ana.agent, START + DAY);

    expect(await rows("SELECT * FROM participant")).toEqual([]);
    expect(await rows("SELECT half, starters, qualified FROM gate_main ORDER BY half")).toEqual([
      { half: "intl_telegram", starters: 0, qualified: 0 },
      { half: "th_line", starters: 0, qualified: 0 },
    ]);
  });

  test("a recruit qualifies on completions in 4 weeks of 0 to 5, one of them late; a completion before the start doesn't count", async () => {
    await beta();
    await enroll(ana);
    await enroll(ben);
    for (const week of [0, 1, 2, 4]) await completed(ana.agent, START + week * WEEK + DAY);
    await completed(ben.agent, START - 3 * DAY);
    await completed(ben.agent, START + 2 * DAY, "typed");

    expect(await rows("SELECT agent_key, week, evidence, via FROM completion ORDER BY agent_key, at")).toEqual([
      ...[0, 1, 2, 4].map((week) => ({ agent_key: ana.agent, week, evidence: "plan_accepted", via: "tap" })),
      { agent_key: ben.agent, week: 0, evidence: "plan_accepted", via: "typed" },
    ]);
    expect(await rows("SELECT half, starters, completed FROM gate_first_week ORDER BY half")).toEqual([
      { half: "intl_telegram", starters: 1, completed: 1 },
      { half: "th_line", starters: 1, completed: 1 },
    ]);
    expect(await rows("SELECT half, starters, qualified FROM gate_main ORDER BY half")).toEqual([
      { half: "intl_telegram", starters: 1, qualified: 0 },
      { half: "th_line", starters: 1, qualified: 1 },
    ]);
  });

  test("an unasked message is credited when the person's decision on its task follows within 7 days; only the last one before it", async () => {
    await beta();
    await enroll(ana);
    const decidedAt = START + 2 * DAY;
    const task = `${ana.agent}|t${next()}`;
    const early = await unasked(ana.agent, task, decidedAt - 3 * DAY);
    const last = await unasked(ana.agent, task, decidedAt - DAY);
    await unasked(ana.agent, task, decidedAt - 2 * DAY, "bookkeeping");
    await unasked(ana.agent, null, decidedAt - DAY, "unlinked");
    await run("INSERT INTO task (id, agent_key, ref, kind, title, cause_kind, opened_at) VALUES (?, ?, 'trip', 'plan', 'A trip', 'checkin', ?)", task, ana.agent, START);
    await run(
      `INSERT INTO task_fact (id, agent_key, task_id, kind, ref, detail, completes, person_decision, cause_kind, cause_at, at)
       VALUES ('f-accept', ?, ?, 'plan_accepted', '1.1', '{"via":"tap"}', 1, 1, 'choice', ?, ?)`,
      ana.agent,
      task,
      decidedAt,
      decidedAt,
    );
    const stale = await completed(ana.agent, START + 20 * DAY);
    await unasked(ana.agent, stale, START + 10 * DAY);

    expect(await rows("SELECT id, task_id FROM unasked_credit")).toEqual([{ id: last, task_id: task }]);
    expect(early).not.toBe(last);
  });

  test("always-on needs 2 credited messages, and the block rate counts blocks after consent", async () => {
    await beta();
    await enroll(ana);
    await enroll(ben);
    for (const day of [3, 10]) {
      const task = await completed(ana.agent, START + day * DAY);
      await unasked(ana.agent, task, START + (day - 1) * DAY);
    }
    await run("INSERT INTO lifecycle (id, agent_key, change, source, at) VALUES ('b1', ?, 'block', 'channel', ?)", ben.agent, START + 5 * DAY);
    await run("INSERT INTO lifecycle (id, agent_key, change, source, at) VALUES ('b0', ?, 'block', 'channel', ?)", ana.agent, START - DAY);

    expect(await rows("SELECT half, starters, qualified, blocked FROM gate_always_on ORDER BY half")).toEqual([
      { half: "intl_telegram", starters: 1, qualified: 0, blocked: 1 },
      { half: "th_line", starters: 1, qualified: 1, blocked: 0 },
    ]);
  });

  test("a joiner's own second week counts for spread, and invites per active person are by beta week", async () => {
    await beta();
    await enroll(ana);
    const jo: Person = { agent: "p:line:jo", cohort: "joiner", half: "th_line", consentedAt: START + 10 * DAY };
    await run("INSERT INTO invite_code (code, cohort, half, issuer, created_at) VALUES ('JOIN22', 'joiner', NULL, ?, ?)", ana.agent, START + DAY);
    await enroll(jo, ana.agent);
    await completed(jo.agent, jo.consentedAt + WEEK + DAY);
    await wrote(ana.agent, START + DAY);

    expect(await rows("SELECT joiners_week2, invites_issued, invites_accepted, waitlist_length FROM gate_spread")).toEqual([
      { joiners_week2: 1, invites_issued: 1, invites_accepted: 1, waitlist_length: 0 },
    ]);
    expect(await rows("SELECT beta_week, wau, issued FROM invites_per_active")).toEqual([{ beta_week: 0, wau: 1, issued: 1 }]);
  });

  test("safety and the survey come from operator rows, and the summary has one row per gate", async () => {
    await beta();
    await enroll(ana);
    await wrote(ana.agent, START + DAY);
    await run("INSERT INTO survey_response (agent_key, answered_at, answer) VALUES (?, ?, 'very')", ana.agent, START + 30 * DAY);
    await run("INSERT INTO safety_incident (id, agent_key, kind, detail, at) VALUES ('s1', NULL, 'red_team_fail', 'tried', ?)", START);

    expect(await rows("SELECT incidents, red_team_passes, red_team_attempts FROM gate_safety")).toEqual([{ incidents: 0, red_team_passes: 0, red_team_attempts: 1 }]);
    expect(await rows("SELECT active, very FROM gate_survey")).toEqual([{ active: 1, very: 1 }]);
    const summary = await rows("SELECT gate, passed FROM gate_summary");
    expect(summary.map((r) => r.gate)).toEqual([
      "gate_first_week",
      "gate_main",
      "gate_always_on",
      "gate_always_on block rate",
      "gate_spread",
      "gate_groups",
      "gate_cost",
      "gate_safety",
      "gate_survey",
    ]);
    expect(summary.find((r) => r.gate === "gate_safety")?.passed).toBe(1);
    expect(summary.find((r) => r.gate === "gate_survey")?.passed).toBe(1);
  });

  test("every view reads", async () => {
    const views = (await rows("SELECT name FROM sqlite_master WHERE type = 'view'")).map((r) => r.name as string);
    expect(views.length).toBeGreaterThan(15);
    for (const v of views) await expect(env.LEDGER.prepare(`SELECT * FROM ${v}`).all(), v).resolves.toBeDefined();
  });
});
