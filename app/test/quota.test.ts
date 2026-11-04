import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig, type Env } from "../src/config";
import worker from "../src/worker";

const LINE_TOKEN = "line-access-token";
const LINE_VARS = { LINE_CHANNEL_SECRET: "line-channel-secret", LINE_CHANNEL_ACCESS_TOKEN: LINE_TOKEN };
const TELEGRAM_VARS = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: "tg-secret" };

type FakeLine = { quota: unknown; used: number; readonly alerts: string[]; readonly lineCalls: string[] };

function fakeApis(): FakeLine {
  const fake: FakeLine = { quota: { type: "limited", value: 1000 }, used: 0, alerts: [], lineCalls: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url.startsWith("https://api.line.me/")) {
      expect(req.method).toBe("GET");
      expect(req.headers.get("authorization")).toBe(`Bearer ${LINE_TOKEN}`);
      fake.lineCalls.push(req.url);
      if (req.url === "https://api.line.me/v2/bot/message/quota") return Response.json(fake.quota);
      if (req.url === "https://api.line.me/v2/bot/message/quota/consumption") return Response.json({ totalUsage: fake.used });
    }
    if (req.url === "https://api.telegram.org/bot123:abc/sendMessage") {
      const body = (await req.json()) as { chat_id: string; text: string };
      expect(body.chat_id).toBe("4242");
      fake.alerts.push(body.text);
      return Response.json({ ok: true, result: {} });
    }
    throw new Error(`unexpected fetch ${req.method} ${req.url}`);
  });
  return fake;
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function hourly(vars: Record<string, string>, at: string): Promise<void> {
  const ctx = createExecutionContext();
  await (worker as ExportedHandler<Env>).scheduled!(createScheduledController({ scheduledTime: new Date(at) }), { ...env, ...vars } as Env, ctx);
  await waitOnExecutionContext(ctx);
}

const readings = () => env.LEDGER.prepare("SELECT month, quota, used FROM line_quota ORDER BY at").all().then((r) => r.results);

describe("LINE quota", () => {
  test("each hourly reading is recorded, and the operator is told once a month at 70% and at 90%", async () => {
    const line = fakeApis();
    const vars = { ...LINE_VARS, ...TELEGRAM_VARS, OPERATOR_CHAT: "telegram:4242" };

    for (const [hour, used] of [[0, 500], [1, 700], [2, 750], [3, 900], [4, 950]] as const) {
      line.used = used;
      await hourly(vars, `2099-11-20T0${hour}:00:00Z`);
    }
    line.used = 710;
    await hourly(vars, "2099-12-01T05:00:00Z");

    expect(await readings()).toEqual([
      { month: "2099-11", quota: 1000, used: 500 },
      { month: "2099-11", quota: 1000, used: 700 },
      { month: "2099-11", quota: 1000, used: 750 },
      { month: "2099-11", quota: 1000, used: 900 },
      { month: "2099-11", quota: 1000, used: 950 },
      { month: "2099-12", quota: 1000, used: 710 },
    ]);
    expect(line.alerts).toHaveLength(3);
    expect(line.alerts[0]).toContain("700 of 1000 (70%)");
    expect(line.alerts[1]).toContain("900 of 1000 (90%)");
    expect(line.alerts[2]).toContain("710 of 1000 (71%)");
  });

  test("with no operator chat the alert is only logged, still once, and an account with no limit never alerts", async () => {
    const line = fakeApis();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    line.used = 800;
    await hourly(LINE_VARS, "2099-11-20T00:00:00Z");
    await hourly(LINE_VARS, "2099-11-20T01:00:00Z");
    expect(warn.mock.calls.filter(([m]) => String(m).includes("80%"))).toHaveLength(1);

    line.quota = { type: "none" };
    await hourly(LINE_VARS, "2099-11-21T00:00:00Z");
    expect(warn.mock.calls.filter(([m]) => String(m).includes("LINE messages"))).toHaveLength(1);
    expect(await readings()).toHaveLength(3);
    expect(line.alerts).toEqual([]);
  });

  test("without LINE configured, nothing is read", async () => {
    const line = fakeApis();
    await hourly({}, "2099-11-20T00:00:00Z");
    expect(line.lineCalls).toEqual([]);
    expect(await readings()).toEqual([]);
  });

  test("OPERATOR_CHAT must name a configured channel and a real id", () => {
    const base = { MODEL_BACKEND: "scripted", DEV_MODE: "1", ...LINE_VARS } as unknown as Env;
    expect(loadConfig({ ...base, OPERATOR_CHAT: "line:U0123456789abcdef0123456789abcdef" }).operatorChat).toEqual({
      channel: "line",
      channelUserId: "U0123456789abcdef0123456789abcdef",
    });
    expect(() => loadConfig({ ...base, OPERATOR_CHAT: "telegram:4242" })).toThrow("isn't configured");
    expect(() => loadConfig({ ...base, OPERATOR_CHAT: "line:bob" })).toThrow("OPERATOR_CHAT must be");
  });
});
