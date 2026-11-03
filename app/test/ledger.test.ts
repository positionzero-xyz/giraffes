import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type { AgentKey, EpochMs, MicroUsd, MonthKey } from "../src/domain";
import { d1Ledger, type LogRow } from "../src/ledger/ledger";

const month = "2099-11" as MonthKey;
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
    expect(await ledger.requestLease({ agent: agent("a"), month: "2099-12" as MonthKey, seq: 1, micro: micro(600_000), at })).toEqual({
      kind: "granted",
      micro: 600_000,
    });

    const total = await env.LEDGER.prepare("SELECT SUM(micro) AS s FROM spend_lease WHERE month = ?").bind(month).first<{ s: number }>();
    expect(total?.s).toBe(1_000_000);
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
        taskKind: "plan",
        taskKey: "trip",
        taskStatus: "completed",
        outcome: "acted",
        refusedForBudget: false,
        costMicro: micro(700),
        attempts: 1,
        startedAt: at,
        finishedAt: at,
      },
      { stream: "unasked", id: "o-1", agent: agent("a"), triggerKind: "checkin", text: "Morning!", status: "sent", day: null, at },
      { stream: "lifecycle", id: "dev:2", agent: agent("a"), change: "block", source: "channel", at },
      {
        stream: "model_call",
        id: "r-1",
        agent: agent("a"),
        purpose: "turn",
        model: "claude-haiku-5-5",
        status: "settled",
        estimateMicro: micro(900),
        costMicro: micro(700),
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        at,
      },
    ];

    await ledger.append(rows);
    await ledger.append(rows);

    const counts = await env.LEDGER.prepare(
      `SELECT (SELECT COUNT(*) FROM agent) AS agents, (SELECT COUNT(*) FROM turn_log) AS turns,
              (SELECT COUNT(*) FROM unasked_message) AS unasked, (SELECT COUNT(*) FROM lifecycle) AS lifecycle,
              (SELECT COUNT(*) FROM model_call) AS calls`,
    ).first();
    expect(counts).toEqual({ agents: 1, turns: 1, unasked: 1, lifecycle: 1, calls: 1 });
    const followed = await env.LEDGER.prepare("SELECT followed FROM unasked_with_followup WHERE id = 'o-1'").first<{ followed: number }>();
    expect(followed?.followed).toBe(0);
  });
});
