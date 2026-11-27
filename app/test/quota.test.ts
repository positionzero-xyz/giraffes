import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { makeChannels } from "../src/channels/channel";
import { loadConfig, type Env } from "../src/config";
import type { EpochMs, OutboundMessage, OutboxId } from "../src/domain";
import { d1Ledger } from "../src/ledger/ledger";
import worker from "../src/worker";

const LINE_TOKEN = "line-access-token";
const LINE_VARS = { LINE_CHANNEL_SECRET: "line-channel-secret", LINE_CHANNEL_ACCESS_TOKEN: LINE_TOKEN };
const TELEGRAM_VARS = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: "tg-test-secret-0123456789abcdefghi" };

type FakeLine = {
  quota: unknown;
  used: number;
  pushQuotaStatus: number;
  replyStatus: number;
  alertStatus: number;
  readonly alerts: string[];
  readonly lineCalls: string[];
};

function fakeApis(): FakeLine {
  const fake: FakeLine = { quota: { type: "limited", value: 1000 }, used: 0, pushQuotaStatus: 200, replyStatus: 200, alertStatus: 200, alerts: [], lineCalls: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url.startsWith("https://api.line.me/")) {
      expect(req.headers.get("authorization")).toBe(`Bearer ${LINE_TOKEN}`);
      fake.lineCalls.push(req.url);
      if (req.url.endsWith("/reply")) return new Response(null, { status: fake.replyStatus });
      if (req.url.endsWith("/push")) return Response.json({});
      expect(req.method).toBe("GET");
      if (req.url === "https://api.line.me/v2/bot/message/quota") return Response.json(fake.quota, { status: fake.pushQuotaStatus });
      if (req.url === "https://api.line.me/v2/bot/message/quota/consumption") return Response.json({ totalUsage: fake.used });
    }
    if (req.url === "https://api.telegram.org/bot123:abc/sendMessage") {
      const body = (await req.json()) as { chat_id: string; text: string };
      expect(body.chat_id).toBe("4242");
      if (fake.alertStatus !== 200) return new Response(null, { status: fake.alertStatus });
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
    expect(warn.mock.calls).toEqual([[{ code: "line_quota", value: 70 }]]);

    line.quota = { type: "none" };
    await hourly(LINE_VARS, "2099-11-21T00:00:00Z");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await readings()).toHaveLength(3);
    expect(line.alerts).toEqual([]);
  });

  test("without LINE configured, nothing is read", async () => {
    const line = fakeApis();
    await hourly({}, "2099-11-20T00:00:00Z");
    expect(line.lineCalls).toEqual([]);
    expect(await readings()).toEqual([]);
  });

  test("logs reply thresholds once when no operator chat is configured", async () => {
    fakeApis();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await env.LEDGER.prepare("INSERT INTO line_reply_usage (month, used) VALUES ('2027-02', 22500)").run();

    await hourly(LINE_VARS, "2027-02-15T00:00:00Z");
    await hourly(LINE_VARS, "2027-02-15T01:00:00Z");

    expect(warn.mock.calls).toEqual([
      [{ code: "line_reply_quota", value: 70 }],
      [{ code: "line_reply_quota", value: 90 }],
    ]);
  });

  test("counts a successful reply with two message objects once, and excludes fallback pushes and uncertain replies", async () => {
    const fake = fakeApis();
    const vars = { ...LINE_VARS, ...TELEGRAM_VARS, OPERATOR_CHAT: "telegram:4242" };
    const channel = makeChannels(loadConfig({ ...env, ...vars } as Env), d1Ledger(env.LEDGER)).line;
    const now = Date.parse("2027-02-15T00:00:00Z") as EpochMs;
    const outbound: OutboundMessage = {
      id: crypto.randomUUID() as OutboxId,
      to: { channel: "line", channelUserId: "U0123456789abcdef0123456789abcdef" },
      texts: ["First message", "Second message"],
      intent: "reply",
      reply: { token: "fresh", expiresAt: (now + 60_000) as EpochMs },
    };
    await env.LEDGER.prepare("INSERT INTO line_reply_usage (month, used) VALUES ('2027-02', 17499)").run();

    fake.replyStatus = 400;
    expect(await channel.deliver(outbound, now)).toEqual({ kind: "sent", via: "push" });
    fake.replyStatus = 503;
    expect(await channel.deliver(outbound, now)).toMatchObject({ kind: "in_doubt" });
    await hourly(vars, "2027-02-15T01:00:00Z");
    expect(fake.alerts).toEqual([]);

    fake.replyStatus = 200;
    expect(await channel.deliver({ ...outbound, replyOnly: true }, now)).toEqual({ kind: "sent", via: "reply" });
    await hourly(vars, "2027-02-15T02:00:00Z");
    expect(fake.alerts).toEqual([expect.stringContaining("LINE replies this month: 17500 of 25000 (70%)")]);
  });

  test("retries failed reply alerts, tracks thresholds independently of pushes, and resets next month", async () => {
    const fake = fakeApis();
    const vars = { ...LINE_VARS, ...TELEGRAM_VARS, OPERATOR_CHAT: "telegram:4242" };
    fake.used = 900;
    await hourly(vars, "2027-02-15T00:00:00Z");
    expect(fake.alerts).toHaveLength(2);

    await env.LEDGER.prepare("INSERT INTO line_reply_usage (month, used) VALUES ('2027-02', 22500)").run();
    fake.alertStatus = 503;
    await hourly(vars, "2027-02-15T01:00:00Z");
    expect(fake.alerts).toHaveLength(2);

    fake.alertStatus = 200;
    await hourly(vars, "2027-02-15T02:00:00Z");
    await hourly(vars, "2027-02-15T03:00:00Z");
    expect(fake.alerts.slice(2)).toEqual([
      expect.stringContaining("22500 of 25000 (90%), past the 70% alert"),
      expect.stringContaining("22500 of 25000 (90%), past the 90% alert"),
    ]);

    fake.used = 0;
    await hourly(vars, "2027-03-01T00:00:00Z");
    expect(fake.alerts).toHaveLength(4);
    await env.LEDGER.prepare("INSERT INTO line_reply_usage (month, used) VALUES ('2027-03', 17500)").run();
    await hourly(vars, "2027-03-01T01:00:00Z");
    expect(fake.alerts.slice(4)).toEqual([expect.stringContaining("17500 of 25000 (70%)")]);
  });

  test("sends an eligible reply alert even if LINE's push quota endpoint is down", async () => {
    const fake = fakeApis();
    fake.pushQuotaStatus = 503;
    const vars = { ...LINE_VARS, ...TELEGRAM_VARS, OPERATOR_CHAT: "telegram:4242" };
    await env.LEDGER.prepare("INSERT INTO line_reply_usage (month, used) VALUES ('2027-02', 17500)").run();

    await expect(hourly(vars, "2027-02-15T00:00:00Z")).rejects.toThrow("LINE quota check failed");
    expect(fake.alerts).toEqual([expect.stringContaining("LINE replies this month: 17500 of 25000 (70%)")]);
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
