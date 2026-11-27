import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { betaStartSql } from "../src/ledger/beta-start";

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

async function completed(agent: string, at: number, via: "tap" | "typed" = "tap"): Promise<string> {
  const task = `${agent}|t${next()}`;
  await run("INSERT INTO task (id, agent_key, ref, kind, title, cause_kind, opened_at) VALUES (?, ?, '', 'plan', '', 'checkin', ?)", task, agent, at - DAY);
  await run(
    `INSERT INTO task_fact (id, agent_key, task_id, kind, ref, detail, completes, person_decision, cause_kind, cause_at, at)
     VALUES (?, ?, ?, 'plan_accepted', '', '{}', 1, 1, ?, ?, ?)`,
    `${agent}|f${next()}`,
    agent,
    task,
    via === "tap" ? "choice" : "message",
    at,
    at,
  );
  return task;
}

async function unasked(agent: string, task: string | null, at: number, purpose = "task_followup"): Promise<string> {
  const id = `o${next()}`;
  await run(
    "INSERT INTO unasked_message (id, agent_key, trigger_kind, text, status, day, at, task_id, purpose) VALUES (?, ?, 'checkin', '', 'sent', NULL, ?, ?, ?)",
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

async function modelCall(agent: string, at: number, backend: "api" | "box" | "key" | "included", costMicro: number): Promise<void> {
  await run(
    `INSERT INTO model_call (id, agent_key, purpose, model, backend, status, estimate_micro, cost_micro, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, at)
     VALUES (?, ?, 'turn', '', ?, 'settled', ?, ?, 0, 0, 0, 0, ?)`,
    `${agent}|m${next()}`,
    agent,
    backend,
    costMicro,
    costMicro,
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
    await modelCall(ana.agent, START + DAY, "key", 1000);
    await modelCall(ben.agent, START + 2 * DAY, "box", 0);

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

  test("the first-week gate counts only recruits whose AI has answered, and keeps the unconnected split visible", async () => {
    await beta();
    await enroll(ana);
    await enroll(ben);
    await completed(ana.agent, START + DAY);
    await completed(ben.agent, START + DAY);
    await modelCall(ana.agent, START + DAY, "key", 1000);

    expect(await rows("SELECT agent_key, connected_ai_at FROM participant ORDER BY agent_key")).toEqual([
      { agent_key: ana.agent, connected_ai_at: START + DAY },
      { agent_key: ben.agent, connected_ai_at: null },
    ]);
    expect(await rows("SELECT half, starters, not_connected, completed FROM gate_first_week ORDER BY half")).toEqual([
      { half: "intl_telegram", starters: 0, not_connected: 1, completed: 0 },
      { half: "th_line", starters: 1, not_connected: 0, completed: 1 },
    ]);
  });

  test("gate_cost splits what Giraffe pays from spend on a person's key or plan", async () => {
    await beta();
    await enroll(ana);
    await enroll(ben);
    await wrote(ana.agent, START + DAY);
    await wrote(ben.agent, START + DAY);
    await modelCall(ana.agent, START + DAY, "key", 2_000_000);
    await modelCall(ben.agent, START + DAY, "included", 1_000_000);
    await modelCall(ana.agent, START + DAY, "box", 0);

    expect(await rows("SELECT beta_week, wau, usd_per_wau, key_usd_per_wau, plan_usd_per_wau FROM gate_cost")).toEqual([
      { beta_week: 0, wau: 2, usd_per_wau: 0.5, key_usd_per_wau: 1, plan_usd_per_wau: 0 },
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
    await run("INSERT INTO task (id, agent_key, ref, kind, title, cause_kind, opened_at) VALUES (?, ?, '', 'plan', '', 'checkin', ?)", task, ana.agent, START);
    await run(
      `INSERT INTO task_fact (id, agent_key, task_id, kind, ref, detail, completes, person_decision, cause_kind, cause_at, at)
       VALUES ('f-accept', ?, ?, 'plan_accepted', '', '{}', 1, 1, 'choice', ?, ?)`,
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
    await run("INSERT INTO safety_incident (id, agent_key, kind, detail, at) VALUES ('s1', NULL, 'red_team_fail', '', ?)", START);

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

  test("the safety gate needs at least one red-team attempt before it can pass", async () => {
    const safety = async () => (await rows("SELECT gate, passed FROM gate_summary")).find((r) => r.gate === "gate_safety")?.passed;
    expect(await safety()).toBe(0);
    await run("INSERT INTO safety_incident (id, agent_key, kind, detail, at) VALUES ('s2', NULL, 'red_team_fail', '', ?)", START);
    expect(await safety()).toBe(1);
  });

  test("the survey counts each person's latest answer only", async () => {
    await beta();
    await enroll(ana);
    await wrote(ana.agent, START + DAY);
    await run("INSERT INTO survey_response (agent_key, answered_at, answer) VALUES (?, ?, 'very')", ana.agent, START + 20 * DAY);
    await run("INSERT INTO survey_response (agent_key, answered_at, answer) VALUES (?, ?, 'not')", ana.agent, START + 30 * DAY);

    expect(await rows("SELECT active, very FROM gate_survey")).toEqual([{ active: 1, very: 0 }]);
    expect((await rows("SELECT gate, passed FROM gate_summary")).find((r) => r.gate === "gate_survey")?.passed).toBe(0);
  });

  test("tasks_by_type counts every task opened once, with completions broken down by evidence", async () => {
    await beta();
    await enroll(ana);
    const open = async () => {
      const task = `${ana.agent}|t${next()}`;
      await run("INSERT INTO task (id, agent_key, ref, kind, title, cause_kind, opened_at) VALUES (?, ?, '', 'plan', '', 'checkin', ?)", task, ana.agent, START);
    };
    await open();
    await open();
    await completed(ana.agent, START + DAY);

    expect(await rows("SELECT task_kind, opened, completed FROM tasks_by_type")).toEqual([{ task_kind: "plan", opened: 3, completed: 1 }]);
    expect(await rows("SELECT task_kind, evidence, completed FROM tasks_by_evidence")).toEqual([{ task_kind: "plan", evidence: "plan_accepted", completed: 1 }]);
  });

  test("beta-codes --start sets the start once, says the old and new dates, and moves it only with --force", async () => {
    const apply = async (startsAt: number, force: boolean) => {
      const [report, write] = betaStartSql(startsAt, force);
      const said = (await rows(report))[0];
      await run(write);
      return said;
    };
    const first = Date.parse("2026-11-16T00:00:00+07:00");
    const later = Date.parse("2026-11-23T00:00:00+07:00");

    expect(await apply(first, false)).toEqual({ old_start: "none", new_start: "2026-11-15T17:00:00.000Z", outcome: "set" });
    expect(await apply(later, false)).toEqual({ old_start: "2026-11-15T17:00:00Z", new_start: "2026-11-22T17:00:00.000Z", outcome: "kept the old start: pass --force to move it" });
    expect(await rows("SELECT starts_at FROM beta")).toEqual([{ starts_at: first }]);
    expect(await apply(later, true)).toMatchObject({ old_start: "2026-11-15T17:00:00Z", outcome: "set" });
    expect(await rows("SELECT starts_at FROM beta")).toEqual([{ starts_at: later }]);
  });

  test("every view reads", async () => {
    const views = (await rows("SELECT name FROM sqlite_master WHERE type = 'view'")).map((r) => r.name as string);
    expect(views.length).toBeGreaterThan(15);
    for (const v of views) await expect(env.LEDGER.prepare(`SELECT * FROM ${v}`).all(), v).resolves.toBeDefined();
  });
});
