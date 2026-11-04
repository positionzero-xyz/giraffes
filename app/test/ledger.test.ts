import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { COHORTS, HALVES, TASK_KINDS, type TaskRef, type AgentKey, type EpochMs, type MicroUsd, type UtcMonth } from "../src/domain";
import type { BoxName } from "../src/box/names";
import { BOX_HOST_KINDS } from "../src/box/host";
import { ACTION_REJECTIONS, BACKENDS, d1Ledger, MODEL_CALL_STATUSES, TURN_OUTCOMES, UNASKED_STATUSES, type LogRow } from "../src/ledger/ledger";
import { PURPOSES } from "../src/model/model";
import { UNASKED_PURPOSES } from "../src/agent/tasks";
import { ADMISSION_CHANGES } from "../src/agent/admission";
import { PAID_PLANS, SUBSCRIPTION_STATUSES } from "../src/billing/plan";

const month = "2099-11" as UtcMonth;
const at = 4_100_000_000_000 as EpochMs;
const micro = (n: number) => n as MicroUsd;
const agent = (name: string) => `p:dev:${name}` as AgentKey;

describe("global ceiling leases", () => {
  test("leases are granted until the ceiling, and a retried seq gets its original answer", async () => {
    const ledger = d1Ledger(env.LEDGER, micro(1_000_000));

    expect(await ledger.requestLease({ agent: agent("a"), month, seq: 1, micro: micro(600_000), at })).toEqual({ kind: "granted", micro: 600_000 });
    expect(await ledger.requestLease({ agent: agent("b"), month, seq: 1, micro: micro(500_000), at })).toEqual({ kind: "ceiling" });
    expect(await ledger.requestLease({ agent: agent("b"), month, seq: 1, micro: micro(400_000), at })).toEqual({ kind: "granted", micro: 400_000 });
    expect(await ledger.requestLease({ agent: agent("a"), month, seq: 1, micro: micro(500_000), at })).toEqual({ kind: "granted", micro: 600_000 });
    expect(await ledger.requestLease({ agent: agent("a"), month: "2099-12" as UtcMonth, seq: 1, micro: micro(600_000), at })).toEqual({
      kind: "granted",
      micro: 600_000,
    });

    const total = await env.LEDGER.prepare("SELECT SUM(micro) AS s FROM spend_lease WHERE month = ?").bind(month).first<{ s: number }>();
    expect(total?.s).toBe(1_000_000);
  });
});

describe("box inventory", () => {
  test("boxes are recorded until MAX_BOXES are live, and a retried claim for a recorded box is granted", async () => {
    const ledger = d1Ledger(env.LEDGER, micro(1_000_000));
    const claim = (who: string) => ledger.claimBox({ agent: agent(who), name: `gbox-${who}` as BoxName, host: "fly", at, max: 2 });

    expect(await claim("a")).toBe("granted");
    expect(await claim("b")).toBe("granted");
    expect(await claim("c")).toBe("full");
    expect(await claim("a")).toBe("granted");

    const rows = await env.LEDGER.prepare("SELECT agent_key, name, host FROM boxes ORDER BY agent_key").all();
    expect(rows.results).toEqual([
      { agent_key: "p:dev:a", name: "gbox-a", host: "fly" },
      { agent_key: "p:dev:b", name: "gbox-b", host: "fly" },
    ]);
  });

  test("a deleted box frees its slot", async () => {
    const ledger = d1Ledger(env.LEDGER, micro(1_000_000));
    const claim = (who: string) => ledger.claimBox({ agent: agent(who), name: `gbox-${who}` as BoxName, host: "fly", at, max: 1 });
    expect(await claim("a")).toBe("granted");
    expect(await claim("b")).toBe("full");

    await env.LEDGER.prepare("UPDATE boxes SET deleted_at = ? WHERE agent_key = 'p:dev:a'").bind(at).run();

    expect(await claim("b")).toBe("granted");
  });

  test("a released box frees its slot, a second release changes nothing, and its owner can claim again", async () => {
    const ledger = d1Ledger(env.LEDGER, micro(1_000_000));
    const claim = (who: string) => ledger.claimBox({ agent: agent(who), name: `gbox-${who}` as BoxName, host: "fly", at, max: 1 });
    expect(await claim("a")).toBe("granted");

    await ledger.releaseBox(agent("a"), at);
    await ledger.releaseBox(agent("a"), (at + 1) as EpochMs);
    const released = await env.LEDGER.prepare("SELECT deleted_at FROM boxes WHERE agent_key = 'p:dev:a'").first<{ deleted_at: number }>();
    expect(released?.deleted_at).toBe(at);

    expect(await claim("a")).toBe("granted");
    expect(await claim("b")).toBe("full");
    const row = await env.LEDGER.prepare("SELECT deleted_at FROM boxes WHERE agent_key = 'p:dev:a'").first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).toBeNull();
  });
});

describe("log shipping", () => {
  test("re-shipping the same rows changes nothing", async () => {
    const ledger = d1Ledger(env.LEDGER, micro(1_000_000));
    const rows: LogRow[] = [
      { stream: "agent", id: "agent:p:dev:a", agent: agent("a"), channel: "dev", firstSeenAt: at },
      {
        stream: "turn",
        id: "p:dev:a|dev:1",
        agent: agent("a"),
        eventKind: "message",
        batchSize: 1,
        outcome: "acted",
        refusedForBudget: false,
        costMicro: micro(700),
        attempts: 1,
        startedAt: at,
        finishedAt: at,
      },
      { stream: "unasked", id: "o-1", agent: agent("a"), triggerKind: "checkin", text: "Morning!", status: "sent", day: null, at, taskId: "p:dev:a|t1", purpose: "task_followup" },
      { stream: "task", id: "p:dev:a|t1", agent: agent("a"), ref: "trip" as TaskRef, kind: "plan", title: "A trip", causeKind: "checkin", openedAt: at },
      {
        stream: "task_fact",
        id: "p:dev:a|f1",
        agent: agent("a"),
        taskId: "p:dev:a|t1",
        kind: "plan_accepted",
        ref: "1.1",
        detail: '{"via":"tap","version":1}',
        completes: true,
        personDecision: true,
        causeKind: "choice",
        causeAt: at,
        at,
      },
      { stream: "lifecycle", id: "dev:2", agent: agent("a"), change: "block", source: "channel", at },
      {
        stream: "model_call",
        id: "r-1",
        agent: agent("a"),
        purpose: "turn",
        model: "claude-haiku-5-5",
        backend: "api",
        status: "settled",
        estimateMicro: micro(900),
        costMicro: micro(700),
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        at,
      },
      { stream: "rejection", id: "p:dev:a|dev:1|0", agent: agent("a"), turnId: "p:dev:a|dev:1", action: "schedule_wakeup:dentist", reason: "bad_time", at },
    ];

    await ledger.append(rows);
    await ledger.append(rows);

    const counts = await env.LEDGER.prepare(
      `SELECT (SELECT COUNT(*) FROM agent) AS agents, (SELECT COUNT(*) FROM turn_log) AS turns,
              (SELECT COUNT(*) FROM unasked_message) AS unasked, (SELECT COUNT(*) FROM lifecycle) AS lifecycle,
              (SELECT COUNT(*) FROM model_call) AS calls, (SELECT COUNT(*) FROM action_rejection) AS rejections,
              (SELECT COUNT(*) FROM task) AS tasks, (SELECT COUNT(*) FROM task_fact WHERE completes = 1) AS completions`,
    ).first();
    expect(counts).toEqual({ agents: 1, turns: 1, unasked: 1, lifecycle: 1, calls: 1, rejections: 1, tasks: 1, completions: 1 });
  });

  test("a row the ledger refuses fails the flush instead of vanishing", async () => {
    const ledger = d1Ledger(env.LEDGER, micro(1_000_000));
    const refused = {
      stream: "model_call",
      id: "r-refused",
      agent: agent("a"),
      purpose: "turn",
      model: "claude-haiku-5-5",
      backend: "api",
      status: "not_a_status",
      estimateMicro: micro(900),
      costMicro: micro(700),
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      at,
    } as unknown as LogRow;

    await expect(ledger.append([refused])).rejects.toThrow(/CHECK/);
  });
});

describe("schema", () => {
  test("each enumerated column allows exactly the values of the TypeScript union that writes it", async () => {
    const tables = await env.LEDGER.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all<{ name: string; sql: string }>();
    const allowed = new Map(
      tables.results.flatMap(({ name, sql }) =>
        [...sql.matchAll(/CHECK \((\w+) IN \(([^)]*)\)\)/g)].map(([, column, list]) => [`${name}.${column}`, [...list.matchAll(/'(\w+)'/g)].map(([, v]) => v).sort()]),
      ),
    );
    const expected: Record<string, readonly string[]> = {
      "task.kind": TASK_KINDS,
      "unasked_message.purpose": UNASKED_PURPOSES,
      "invite_code.cohort": COHORTS,
      "invite_code.half": HALVES,
      "enrollment.cohort": COHORTS,
      "enrollment.half": HALVES,
      "admission_log.change": ADMISSION_CHANGES,
      "turn_log.outcome": TURN_OUTCOMES,
      "model_call.purpose": PURPOSES,
      "model_call.status": MODEL_CALL_STATUSES,
      "model_call.backend": BACKENDS,
      "boxes.host": BOX_HOST_KINDS,
      "unasked_message.status": UNASKED_STATUSES,
      "action_rejection.reason": ACTION_REJECTIONS,
      "billing_subscription.plan": PAID_PLANS,
      "billing_subscription.status": SUBSCRIPTION_STATUSES,
    };

    for (const [column, values] of Object.entries(expected)) expect(allowed.get(column), column).toEqual([...values].sort());
  });
});
