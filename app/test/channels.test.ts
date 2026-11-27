import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TASKS } from "../src/agent/tasks";
import { devChannel } from "../src/channels/dev";
import { TURN } from "../src/agent/turn";
import { lineChannel } from "../src/channels/line";
import { SEND_MESSAGE_MAX_CHARS as TELEGRAM_MAX_CHARS, telegramChannel } from "../src/channels/telegram";
import { LANGUAGES, type EpochMs, type Identity, type OutboundMessage, type OutboxId } from "../src/domain";
import { NOTICES, type FixedNotice } from "../src/notices";

type Seen = { url: string; headers: Headers; body: unknown };

function stubFetch(respond: (seen: Seen) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const s = { url: req.url, headers: req.headers, body: await req.json().catch(() => null) };
    seen.push(s);
    return respond(s);
  });
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const LINE_SECRET = "line-channel-secret-for-tests";
const USER = "U4af4980629a1b2c3d4e5f60718293a4b";
const T = 4097563200000;
const LINE_BODY =
  '{"destination":"Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","events":[{"type":"message","webhookEventId":"01HZEVT0000000000000000001","timestamp":4097563200000,"mode":"active","source":{"type":"user","userId":"U4af4980629a1b2c3d4e5f60718293a4b"},"replyToken":"reply-token-1","message":{"id":"1","type":"text","text":"remind me at 6pm"},"deliveryContext":{"isRedelivery":false}},{"type":"message","webhookEventId":"01HZEVT0000000000000000002","timestamp":4097563201000,"mode":"active","source":{"type":"user","userId":"U4af4980629a1b2c3d4e5f60718293a4b"},"replyToken":"reply-token-2","message":{"id":"2","type":"sticker","packageId":"1","stickerId":"2"},"deliveryContext":{"isRedelivery":false}},{"type":"follow","webhookEventId":"01HZEVT0000000000000000003","timestamp":4097563202000,"mode":"active","source":{"type":"user","userId":"U4af4980629a1b2c3d4e5f60718293a4b"},"replyToken":"reply-token-3","follow":{"isUnblocked":true},"deliveryContext":{"isRedelivery":false}},{"type":"unfollow","webhookEventId":"01HZEVT0000000000000000004","timestamp":4097563203000,"mode":"active","source":{"type":"user","userId":"U4af4980629a1b2c3d4e5f60718293a4b"},"deliveryContext":{"isRedelivery":true}},{"type":"message","webhookEventId":"01HZEVT0000000000000000005","timestamp":4097563204000,"mode":"active","source":{"type":"group","groupId":"Cgroup","userId":"U4af4980629a1b2c3d4e5f60718293a4b"},"replyToken":"reply-token-5","message":{"id":"5","type":"text","text":"hi all"},"deliveryContext":{"isRedelivery":false}}]}';
const LINE_SIGNATURE = "aH8hSlr1rq+2eLuZdUEtiMz/NfzZQPIXhjG3lsZaZLs=";

const line = () => lineChannel({ channelSecret: LINE_SECRET, accessToken: "line-access-token" });
const lineWebhook = (body: string, signature: string | null) =>
  new Request("https://agent.test/webhook/line", { method: "POST", body, headers: signature === null ? {} : { "x-line-signature": signature } });

describe("LINE webhook", () => {
  test("a correctly signed body becomes person-scoped domain events", async () => {
    const received = await line().receive(lineWebhook(LINE_BODY, LINE_SIGNATURE));

    const identity = { channel: "line", channelUserId: USER };
    const agent = `p:line:${USER}`;
    expect(received).toEqual({
      kind: "accepted",
      ignored: 1,
      envelopes: [
        {
          agent,
          identity,
          key: "line:01HZEVT0000000000000000001",
          receivedAt: T,
          event: { kind: "message", text: "remind me at 6pm", reply: { token: "reply-token-1", expiresAt: T + 60_000 } },
        },
        {
          agent,
          identity,
          key: "line:01HZEVT0000000000000000002",
          receivedAt: T + 1000,
          event: { kind: "message", text: "[sent a sticker]", reply: { token: "reply-token-2", expiresAt: T + 61_000 } },
        },
        {
          agent,
          identity,
          key: "line:01HZEVT0000000000000000003",
          receivedAt: T + 2000,
          event: { kind: "lifecycle", change: "follow", at: T + 2000, reply: { token: "reply-token-3", expiresAt: T + 62_000 } },
        },
        { agent, identity, key: "line:01HZEVT0000000000000000004", receivedAt: T + 3000, event: { kind: "lifecycle", change: "block", at: T + 3000 } },
      ],
    });
  });

  test("a missing, wrong or stale signature is rejected", async () => {
    expect(await line().receive(lineWebhook(LINE_BODY, null))).toEqual({ kind: "rejected", status: 401 });
    expect(await line().receive(lineWebhook(LINE_BODY, "aH8hSlr1rq+2eLuZdUEtiMz/NfzZQPIXhjG3lsZaZLt="))).toEqual({ kind: "rejected", status: 401 });
    expect(await line().receive(lineWebhook(LINE_BODY.replace("6pm", "7pm"), LINE_SIGNATURE))).toEqual({ kind: "rejected", status: 401 });
  });

  test("rejects a webhook whose body exceeds one MiB", async () => {
    expect(await line().receive(lineWebhook(" ".repeat(1024 * 1024 + 1), LINE_SIGNATURE))).toEqual({ kind: "rejected", status: 413 });
  });

  test("without secrets the route doesn't exist", async () => {
    expect(await lineChannel(null).receive(lineWebhook(LINE_BODY, LINE_SIGNATURE))).toEqual({ kind: "rejected", status: 404 });
  });

  test("a postback from a button becomes a choice, with its reply token; unknown data is ignored", async () => {
    const postback = (id: string, data: string) => ({
      type: "postback",
      webhookEventId: id,
      timestamp: T,
      mode: "active",
      source: { type: "user", userId: USER },
      replyToken: `token-${id}`,
      postback: { data },
      deliveryContext: { isRedelivery: false },
    });
    const body = JSON.stringify({ destination: "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", events: [postback("P1", "a:7.1"), postback("P2", "c"), postback("P3", "x:1")] });
    const signature = createHmac("sha256", LINE_SECRET).update(body).digest("base64");

    const received = await line().receive(lineWebhook(body, signature));

    const reply = (id: string) => ({ token: `token-${id}`, expiresAt: T + 60_000 });
    expect(received).toMatchObject({
      kind: "accepted",
      ignored: 1,
      envelopes: [
        { key: "line:P1", event: { kind: "choice", choice: { kind: "accept", proposal: "7.1" }, at: T, reply: reply("P1") } },
        { key: "line:P2", event: { kind: "choice", choice: { kind: "consent" }, at: T, reply: reply("P2") } },
      ],
    });
  });

  test("a quoted message id becomes a reference, while a malformed one is ignored", async () => {
    const quoted = {
      type: "message",
      webhookEventId: "Q1",
      timestamp: T,
      mode: "active",
      source: { type: "user", userId: USER },
      replyToken: "reply-token-q1",
      message: { id: "3", type: "text", text: "move this to 5", quotedMessageId: "461230966842064897" },
      deliveryContext: { isRedelivery: false },
    };
    const malformed = { ...quoted, webhookEventId: "Q2", message: { ...quoted.message, quotedMessageId: 461230966842064897 } };
    const body = JSON.stringify({ destination: "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", events: [quoted, malformed] });
    const signature = createHmac("sha256", LINE_SECRET).update(body).digest("base64");

    const received = await line().receive(lineWebhook(body, signature));

    expect(received).toMatchObject({
      kind: "accepted",
      ignored: 1,
      envelopes: [
        {
          key: "line:Q1",
          event: {
            kind: "message",
            text: "move this to 5",
            quote: { kind: "reference", id: "461230966842064897" },
            reply: { token: "reply-token-q1", expiresAt: T + 60_000 },
          },
        },
      ],
    });
  });
});

const NOW = 4097563210000 as EpochMs;
function outbound(over: Partial<OutboundMessage> = {}): OutboundMessage {
  const to: Identity = { channel: "line", channelUserId: USER };
  return { id: "5f0c2c61-0d1e-4c3c-9a43-1d1f6c2a8b10" as OutboxId, to, texts: ["Done.", "(note)"], intent: "reply", ...over };
}
const fresh = { token: "reply-token-1", expiresAt: (NOW + 50_000) as EpochMs };

describe("LINE loading animation", () => {
  const to = { channel: "line", channelUserId: USER } as const;

  test("a turn shows the loading animation, which spends no reply token, and asks again before it runs out", async () => {
    const seen = stubFetch(() => Response.json({}, { status: 202 }));
    const working = line().working;
    await working?.show(to);
    expect(seen.map((s) => [s.url, s.headers.get("authorization"), s.body])).toEqual([
      ["https://api.line.me/v2/bot/chat/loading/start", "Bearer line-access-token", { chatId: USER, loadingSeconds: 20 }],
    ]);
    expect(working?.everyMs).toBeLessThan(20_000);
  });

  test("a failed loading request doesn't fail the turn", async () => {
    stubFetch(() => Response.json({ message: "Internal error" }, { status: 500 }));
    await expect(line().working?.show(to)).resolves.toBeUndefined();
  });
});

describe("LINE delivery", () => {
  test.each([
    [{ message: "The property, 'to', in the request body is invalid (line: 1, column: 9)" }, "recipient_gone"],
    [{ message: "The request body has 1 error(s)", details: [{ property: "to", message: "invalid user ID" }] }, "recipient_gone"],
    [{ message: "The request body has 1 error(s)", details: [{ property: "messages[0].text", message: "Required" }] }, "failed"],
    [{ message: "Failed to send messages" }, "failed"],
  ] as const)("classifies LINE push 400 by the error's field: %j", async (body, kind) => {
    stubFetch(() => Response.json(body, { status: 400 }));
    expect(await line().deliverOperatorAlert?.(outbound(), NOW)).toMatchObject({ kind });
  });

  test("a LINE push recovers from a transient error with the same retry key", async () => {
    let unavailable = true;
    const seen = stubFetch(() => unavailable ? new Response(null, { status: 503 })
      : Response.json({ message: "The retry key is already accepted" }, { status: 409 }));
    const message = outbound();
    expect(await line().deliver(message, NOW)).toMatchObject({ kind: "retry" });
    unavailable = false;
    expect(await line().deliver(message, NOW)).toEqual({ kind: "sent", via: "push" });
    expect(seen.map((request) => request.headers.get("x-line-retry-key"))).toEqual([message.id, message.id]);
  });

  test("a button rides on the last text as a postback quick reply that shows its label", async () => {
    const seen = stubFetch(() => Response.json({}));

    await line().deliver(outbound({ reply: fresh, button: { label: "Accept plan", data: "a:7.1" } }), NOW);

    expect(seen[0].body).toEqual({
      replyToken: "reply-token-1",
      messages: [
        { type: "text", text: "Done." },
        {
          type: "text",
          text: "(note)",
          quickReply: { items: [{ type: "action", action: { type: "postback", label: "Accept plan", data: "a:7.1", displayText: "Accept plan" } }] },
        },
      ],
    });
  });

  test("a reply-only row is never pushed, even when its reply token is refused", async () => {
    const seen = stubFetch(() => Response.json({ message: "Invalid reply token" }, { status: 400 }));

    expect(await line().deliver(outbound({ replyOnly: true }), NOW)).toMatchObject({ kind: "failed" });
    expect(await line().deliver(outbound({ replyOnly: true, reply: fresh }), NOW)).toMatchObject({ kind: "failed" });
    expect(seen.map((s) => s.url.split("/").pop())).toEqual(["reply"]);
  });

  test("a fresh reply token uses the reply API with every text", async () => {
    const seen = stubFetch(() => Response.json({}));

    expect(await line().deliver(outbound({ reply: fresh }), NOW)).toEqual({ kind: "sent", via: "reply" });
    expect(seen.map((s) => s.url)).toEqual(["https://api.line.me/v2/bot/message/reply"]);
    expect(seen[0].body).toEqual({ replyToken: "reply-token-1", messages: [{ type: "text", text: "Done." }, { type: "text", text: "(note)" }] });
    expect(seen[0].headers.get("authorization")).toBe("Bearer line-access-token");
  });

  test("message ids LINE returns for a reply or push keep the position of the text they carried", async () => {
    stubFetch((s) =>
      s.url.endsWith("/reply")
        ? Response.json({ sentMessages: [{ id: "461230966842064897" }, { id: "461230966842064898" }] })
        : Response.json({ sentMessages: [{ id: "461230966842064899" }, { id: "461230966842064900" }] }),
    );

    expect(await line().deliver(outbound({ reply: fresh }), NOW)).toEqual({
      kind: "sent",
      via: "reply",
      providerMessages: [
        { id: "461230966842064897", position: 0 },
        { id: "461230966842064898", position: 1 },
      ],
    });
    expect(await line().deliver(outbound(), NOW)).toEqual({
      kind: "sent",
      via: "push",
      providerMessages: [
        { id: "461230966842064899", position: 0 },
        { id: "461230966842064900", position: 1 },
      ],
    });
  });

  test("a failed quota write leaves an accepted reply marked as sent", async () => {
    const seen = stubFetch(() => Response.json({}));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const line = lineChannel({ channelSecret: LINE_SECRET, accessToken: "line-access-token" }, async () => {
      throw new Error("D1 unavailable");
    });

    expect(await line.deliver(outbound({ reply: fresh }), NOW)).toEqual({ kind: "sent", via: "reply" });
    expect(seen.map((s) => s.url)).toEqual(["https://api.line.me/v2/bot/message/reply"]);
    expect(warn.mock.calls).toEqual([[{ code: "line_reply_usage_write_failed" }]]);
  });

  test("a token near expiry, or none, pushes with the outbox id as the retry key", async () => {
    const seen = stubFetch(() => Response.json({}));

    const nearlyExpired = { token: "reply-token-1", expiresAt: (NOW + 9_000) as EpochMs };
    expect(await line().deliver(outbound({ reply: nearlyExpired }), NOW)).toEqual({ kind: "sent", via: "push" });
    expect(await line().deliver(outbound({ intent: "unasked" }), NOW)).toEqual({ kind: "sent", via: "push" });

    expect(seen.map((s) => s.url)).toEqual(["https://api.line.me/v2/bot/message/push", "https://api.line.me/v2/bot/message/push"]);
    expect(seen[0].headers.get("x-line-retry-key")).toBe("5f0c2c61-0d1e-4c3c-9a43-1d1f6c2a8b10");
    expect(seen[0].body).toEqual({ to: USER, messages: [{ type: "text", text: "Done." }, { type: "text", text: "(note)" }] });
  });

  test("a rejected reply token falls back to a push", async () => {
    const seen = stubFetch((s) => (s.url.endsWith("/reply") ? Response.json({ message: "Invalid reply token" }, { status: 400 }) : Response.json({})));
    expect(await line().deliver(outbound({ reply: fresh }), NOW)).toEqual({ kind: "sent", via: "push" });
    expect(seen.map((s) => s.url.split("/").pop())).toEqual(["reply", "push"]);
  });

  test("after LINE refuses a reply token, a push that must be retried is retried without that token", async () => {
    const seen = stubFetch((s) => (s.url.endsWith("/reply") ? Response.json({ message: "Invalid reply token" }, { status: 400 }) : new Response("upstream down", { status: 503 })));
    expect(await line().deliver(outbound({ reply: fresh }), NOW)).toMatchObject({ kind: "in_doubt" });
    expect(seen.map((s) => s.url.split("/").pop())).toEqual(["reply", "push"]);
  });

  test("a retried push that LINE already accepted counts as sent", async () => {
    stubFetch(() => Response.json({ message: "The retry key is already accepted" }, { status: 409 }));
    expect(await line().deliver(outbound(), NOW)).toEqual({ kind: "sent", via: "push" });
  });

  test("rate limits and outages retry; an exhausted monthly quota does not", async () => {
    stubFetch(() => Response.json({ message: "Too many requests" }, { status: 429 }));
    expect(await line().deliver(outbound(), NOW)).toMatchObject({ kind: "retry" });

    vi.restoreAllMocks();
    stubFetch(() => Response.json({ message: "You have reached your monthly limit." }, { status: 429 }));
    expect(await line().deliver(outbound(), NOW)).toMatchObject({ kind: "failed" });

    vi.restoreAllMocks();
    stubFetch(() => new Response("upstream down", { status: 503 }));
    expect(await line().deliver(outbound(), NOW)).toMatchObject({ kind: "retry" });
  });

  test("a reply that hit an outage or a dropped connection may have been accepted, so it is in doubt", async () => {
    stubFetch(() => new Response("upstream down", { status: 503 }));
    expect(await line().deliver(outbound({ reply: fresh }), NOW)).toMatchObject({ kind: "in_doubt" });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Network connection lost."));
    expect(await line().deliver(outbound({ reply: fresh }), NOW)).toMatchObject({ kind: "in_doubt" });

    vi.restoreAllMocks();
    stubFetch(() => Response.json({ message: "Too many requests" }, { status: 429 }));
    expect(await line().deliver(outbound({ reply: fresh }), NOW)).toMatchObject({ kind: "retry" });
  });
});

const TG_SECRET = "tg-webhook-secret";
const telegram = () => telegramChannel({ botToken: "123:abc", webhookSecret: TG_SECRET });
const tgWebhook = (update: object, secret: string | null = TG_SECRET) =>
  new Request("https://agent.test/webhook/telegram", {
    method: "POST",
    body: JSON.stringify(update),
    headers: secret === null ? {} : { "x-telegram-bot-api-secret-token": secret },
  });
const privateChat = { id: 777000111, type: "private", first_name: "Ann" };
const from = { id: 777000111, is_bot: false, first_name: "Ann" };
const DATE = 4097563200;

describe("Telegram webhook", () => {
  const identity = { channel: "telegram", channelUserId: "777000111" };
  const envelope = (key: string, event: object) => ({ agent: "p:telegram:777000111", identity, key, receivedAt: DATE * 1000, event });

  test("private messages, /start and membership changes become domain events", async () => {
    const cases: [object, object][] = [
      [{ update_id: 1, message: { message_id: 1, date: DATE, chat: privateChat, from, text: "hello" } }, envelope("tg:1", { kind: "message", text: "hello" })],
      [{ update_id: 2, message: { message_id: 2, date: DATE, chat: privateChat, from, photo: [{ file_id: "x" }] } }, envelope("tg:2", { kind: "message", text: "[sent a photo]" })],
      [
        { update_id: 3, message: { message_id: 3, date: DATE, chat: privateChat, from, text: "/start invite-42" } },
        envelope("tg:3", { kind: "lifecycle", change: "follow", at: DATE * 1000 }),
      ],
      [
        { update_id: 8, message: { message_id: 8, date: DATE, chat: privateChat, from, text: "/start k7p3qz" } },
        envelope("tg:8", { kind: "lifecycle", change: "follow", at: DATE * 1000, code: "K7P3QZ" }),
      ],
      [
        { update_id: 4, my_chat_member: { date: DATE, chat: privateChat, from, old_chat_member: { status: "member" }, new_chat_member: { status: "kicked" } } },
        envelope("tg:4", { kind: "lifecycle", change: "block", at: DATE * 1000 }),
      ],
      [
        { update_id: 5, my_chat_member: { date: DATE, chat: privateChat, from, old_chat_member: { status: "kicked" }, new_chat_member: { status: "member" } } },
        envelope("tg:5", { kind: "lifecycle", change: "follow", at: DATE * 1000 }),
      ],
    ];
    for (const [update, expected] of cases) {
      expect(await telegram().receive(tgWebhook(update))).toEqual({ kind: "accepted", envelopes: [expected], ignored: 0 });
    }
  });

  test("a reply carries the earlier message's text as a quote", async () => {
    const update = {
      update_id: 20,
      message: {
        message_id: 42,
        date: DATE,
        chat: privateChat,
        from,
        text: "move this to 5",
        reply_to_message: { message_id: 41, date: DATE - 100, chat: privateChat, from, text: "I'll remind you at 4." },
      },
    };

    const received = await telegram().receive(tgWebhook(update));

    expect(received).toMatchObject({
      kind: "accepted",
      ignored: 0,
      envelopes: [
        envelope("tg:20", {
          kind: "message",
          text: "move this to 5",
          quote: { kind: "text", text: "I'll remind you at 4." },
        }),
      ],
    });
  });

  test("an edited private message becomes a correction at its edit time", async () => {
    const update = {
      update_id: 21,
      edited_message: { message_id: 43, date: DATE - 100, edit_date: DATE, chat: privateChat, from, text: "actually, make it 5" },
    };

    const received = await telegram().receive(tgWebhook(update));

    expect(received).toEqual({
      kind: "accepted",
      ignored: 0,
      envelopes: [envelope("tg:21", { kind: "message", text: "actually, make it 5", edited: true })],
    });
  });

  test("editing a message to /start is still a correction, not a new follow", async () => {
    const update = {
      update_id: 22,
      edited_message: { message_id: 44, date: DATE - 100, edit_date: DATE, chat: privateChat, from, text: "/start" },
    };

    const received = await telegram().receive(tgWebhook(update));

    expect(received).toEqual({
      kind: "accepted",
      ignored: 0,
      envelopes: [envelope("tg:22", { kind: "message", text: "/start", edited: true })],
    });
  });

  test("a tap on a button in a private chat becomes a choice, and Telegram is told the tap was received", async () => {
    const seen = stubFetch(() => Response.json({ ok: true, result: true }));
    const tap = (update_id: number, data: string) => ({
      update_id,
      callback_query: { id: `cb${update_id}`, from, message: { message_id: 9, date: DATE, chat: privateChat }, data },
    });

    const received = await telegram().receive(tgWebhook(tap(9, "a:7.1")));

    expect(received).toMatchObject({
      kind: "accepted",
      ignored: 0,
      envelopes: [{ agent: "p:telegram:777000111", identity, key: "tg:9", event: { kind: "choice", choice: { kind: "accept", proposal: "7.1" } } }],
    });
    expect(seen.map((s) => [s.url, s.body])).toEqual([["https://api.telegram.org/bot123:abc/answerCallbackQuery", { callback_query_id: "cb9" }]]);
    expect(await telegram().receive(tgWebhook(tap(10, "nonsense")))).toEqual({ kind: "accepted", envelopes: [], ignored: 1 });
  });

  test("group chats and unknown updates are ignored, not rejected", async () => {
    const group = { update_id: 6, message: { message_id: 6, date: DATE, chat: { id: -100, type: "group" }, from, text: "hi" } };
    expect(await telegram().receive(tgWebhook(group))).toEqual({ kind: "accepted", envelopes: [], ignored: 1 });
    expect(await telegram().receive(tgWebhook({ update_id: 7, edited_message: {} }))).toEqual({ kind: "accepted", envelopes: [], ignored: 1 });
  });

  test("a missing or wrong secret token is rejected", async () => {
    const update = { update_id: 1, message: { message_id: 1, date: DATE, chat: privateChat, from, text: "hello" } };
    expect(await telegram().receive(tgWebhook(update, null))).toEqual({ kind: "rejected", status: 401 });
    expect(await telegram().receive(tgWebhook(update, "tg-webhook-secreT"))).toEqual({ kind: "rejected", status: 401 });
  });
});

describe("Telegram typing", () => {
  const to = { channel: "telegram", channelUserId: "777000111" } as const;

  test("a turn shows typing, which is not a message, and asks again before Telegram's 5 seconds run out", async () => {
    const seen = stubFetch(() => Response.json({ ok: true, result: true }));
    const working = telegram().working;
    await working?.show(to);
    expect(seen.map((s) => [s.url, s.body])).toEqual([["https://api.telegram.org/bot123:abc/sendChatAction", { chat_id: "777000111", action: "typing" }]]);
    expect(working?.everyMs).toBeLessThan(5000);
  });

  test("a failed typing request doesn't fail the turn", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(telegram().working?.show(to)).resolves.toBeUndefined();
  });
});

describe("Telegram delivery", () => {
  const msg = outbound({ to: { channel: "telegram", channelUserId: "777000111" } });

  test("a row's texts go out as one message, so a retry after flood control repeats nothing", async () => {
    let limited = false;
    const accepted: Seen[] = [];
    stubFetch((s) => {
      if (!limited && JSON.stringify(s.body).includes("(note)")) {
        limited = true;
        return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 });
      }
      accepted.push(s);
      return Response.json({ ok: true, result: {} });
    });

    let delivery = await telegram().deliver(msg, NOW);
    expect(delivery).toMatchObject({ kind: "retry", afterMs: 1000 });
    delivery = await telegram().deliver(msg, NOW);

    expect(delivery).toEqual({ kind: "sent", via: "push" });
    expect(accepted.map((s) => [s.url, s.body])).toEqual([["https://api.telegram.org/bot123:abc/sendMessage", {
      chat_id: "777000111", text: "Done.\n\n(note)", link_preview_options: { is_disabled: true },
    }]]);
  });

  test.each(LANGUAGES)("the longest row a turn can produce fits one Telegram message, in %s", (lang) => {
    const t = NOTICES[lang];
    const due = "2026-11-04 09:00";
    const rejections: FixedNotice[] = [
      "reminderLimit",
      "reminderPast",
      "reminderTooFar",
      "reminderBadTime",
      "reminderDuplicate",
      "reminderNotSet",
      "tooManyActions",
      "checkinReserved",
      "cancelNotFound",
      "badZone",
    ];
    const corrections = [...rejections.map((k) => t[k]), ...Array.from({ length: TURN.maxActions }, () => t.reminderKept(due))].join("\n");
    const requestedReminder = `${t.lateFallback(due)}\n${t.reminder("x".repeat(TURN.maxNoteBytes))}`;
    const longestSend = TURN.maxLateNoticeChars + "\n".length + TURN.maxTextChars;
    const longestText = Math.max(longestSend, corrections.length, requestedReminder.length);
    expect(TURN.maxSendsPerTurn * longestText + "\n\n".length * (TURN.maxSendsPerTurn - 1)).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    const withPlan = (TURN.maxSendsPerTurn - 1) * longestSend + corrections.length + t.planAccepted("x".repeat(TASKS.maxTitleBytes)).length + TASKS.maxPlanChars;
    expect(withPlan + "\n\n".length * TURN.maxSendsPerTurn).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  test("Markdown in a reply reaches Telegram as plain text, with no literal asterisks or link syntax", async () => {
    const seen = stubFetch(() => Response.json({ ok: true, result: {} }));
    await telegram().deliver({ ...msg, texts: ["It's **x** today.", "See [t](https://example.com) or [https://example.org](https://example.org)."] }, NOW);
    expect(seen[0].body).toMatchObject({ text: "It's x today.\n\nSee t (https://example.com) or https://example.org." });
  });

  test("a button goes out as one inline button under the message", async () => {
    const seen = stubFetch(() => Response.json({ ok: true, result: {} }));
    await telegram().deliver({ ...msg, button: { label: "Accept plan", data: "a:7.1" } }, NOW);
    expect(seen[0].body).toEqual({
      chat_id: "777000111",
      text: "Done.\n\n(note)",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "Accept plan", callback_data: "a:7.1" }]] },
    });
  });

  test("a block is reported as the recipient being gone; flood control retries when told", async () => {
    stubFetch(() => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 }));
    expect(await telegram().deliver(msg, NOW)).toEqual({ kind: "recipient_gone" });

    vi.restoreAllMocks();
    stubFetch(() => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 5 } }, { status: 429 }));
    expect(await telegram().deliver(msg, NOW)).toMatchObject({ kind: "retry", afterMs: 5000 });
  });

  test.each([
    [{ description: "Bad Request: chat not found" }, "chat_unavailable"],
    [{ description: "Bad Request: private chat not found" }, "chat_unavailable"],
    [{ parameters: { migrate_to_chat_id: -1001234567890 } }, "chat_migrated"],
    [{ description: "Bad Request: message is too long" }, "failed"],
  ] as const)("classifies Telegram sendMessage 400 by its description or migration parameter: %j", async (body, kind) => {
    stubFetch(() => Response.json({ ok: false, error_code: 400, ...body }, { status: 400 }));
    expect(await telegram().deliverOperatorAlert?.(msg, NOW)).toMatchObject({ kind });
  });
});

describe("dev channel", () => {
  test("/tap with a button's data is a tap, since the dev page draws no buttons", async () => {
    const req = new Request("https://agent.test/webhook/dev", { method: "POST", body: JSON.stringify({ user: "ann", text: "/tap a:1.1", id: "t1", at: T }) });
    expect(await devChannel(true).receive(req)).toMatchObject({
      envelopes: [{ key: "dev:t1", event: { kind: "choice", choice: { kind: "accept", proposal: "1.1" }, at: T } }],
    });
  });
});
