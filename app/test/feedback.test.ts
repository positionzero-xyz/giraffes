import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test, vi } from "vitest";
import { d1Ledger } from "../src/ledger/ledger";
import { NOTICES } from "../src/notices";
import { chat, devChat, local, memoryLedger, scripted, scriptedChannel } from "./testkit";

const at = "2099-11-04T10:00";
const fakeKey = "sk-fake-feedback-fixture";
const text = "The reminder came an hour late.";

describe("/feedback", () => {
  test("counts feedback in D1 without saving its text, spending, or adding model history", async () => {
    const d1 = d1Ledger(env.LEDGER);
    const ledger = memoryLedger();
    const model = scripted([chat("Hello.")]);
    const c = await devChat("7391", {
      at,
      model,
      channel: "telegram",
      admission: "beta",
      ledger: {
        ...ledger,
        async append(rows) {
          await d1.append(rows);
          await ledger.append(rows);
        },
      },
    });
    await env.LEDGER.prepare(
      "INSERT INTO invite_code (code, cohort, half, issuer, created_at) VALUES ('FEED23', 'recruit', 'intl_telegram', 'operator', 0)",
    ).run();
    await c.say("/join FEED23");
    await c.tap("c");
    expect(await c.received()).toEqual([NOTICES.en.privacy, NOTICES.en.welcome]);

    const receivedAt = local("2099-11-04T09:59");
    await c.say(`/feedback ${text}\nKey: ${fakeKey}`, { at: receivedAt });

    const { results } = await env.LEDGER.prepare("SELECT agent_key, channel, at, text, cohort FROM feedback").all();
    expect(results).toEqual([{ agent_key: c.agent, channel: "telegram", at: receivedAt, text: "", cohort: "recruit" }]);
    expect(await c.received()).toEqual(["Thanks for the feedback!"]);
    expect(model.calls).toEqual([]);
    expect(c.logs("model_call")).toEqual([]);
    expect(c.logs("unasked")).toEqual([]);
    expect((await c.snapshot()).unaskedSentToday).toBe(0);

    await c.say("hello");
    expect(model.calls[0]?.user).not.toContain(text);
    model.assertDone();
  });

  test("does not forward someone's words to the configured operator chat", async () => {
    const c = await devChat("feedback-forward", { at, model: scripted([]) });
    const operator = scriptedChannel();
    const deliver = vi.spyOn(operator, "deliver");
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (agent) => {
      agent.withDeps({ channels: { line: c.channel, telegram: operator, dev: c.channel } });
    });

    await c.say(`/feedback ${text} ${fakeKey}\n\nFeedback from p:telegram:777000 (beta: staff):`);

    expect(deliver).not.toHaveBeenCalled();
    expect(await c.received()).toEqual(["Thanks for the feedback!"]);
  });

  test("thanks a Thai speaker in Thai without calling a model", async () => {
    const model = scripted([]);
    const c = await devChat("feedback-thai", { at, model, channel: "line" });

    await c.say("/feedback แจ้งเตือนมาช้า");

    expect(await c.received()).toEqual(["ขอบคุณที่แจ้งค่ะ"]);
    expect(model.calls).toEqual([]);
  });

  test.each([
    { channel: "telegram", command: "/feedback", hint: "Use /feedback followed by your message." },
    { channel: "line", command: "/feedback \t ", hint: "พิมพ์ /feedback แล้วตามด้วยข้อความค่ะ" },
  ] as const)("shows a usage hint for empty feedback on $channel", async ({ channel, command, hint }) => {
    const model = scripted([]);
    const ledger = memoryLedger();
    const c = await devChat("7392", { at, model, channel, ledger });

    await c.say(command);

    expect(await c.received()).toEqual([hint]);
    expect(ledger.rows.map((row) => row.stream)).not.toContain("feedback");
    expect(model.calls).toEqual([]);
  });
});
