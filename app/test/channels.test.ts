import { afterEach, describe, expect, test, vi } from "vitest";
import { lineChannel } from "../src/channels/line";
import { MAX_TEXT as TELEGRAM_MAX_TEXT, telegramChannel } from "../src/channels/telegram";
import { NOTICE, TURN } from "../src/agent/turn";
import type { EpochMs, Identity, OutboundMessage, OutboxId } from "../src/domain";

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

  test("without secrets the route doesn't exist", async () => {
    expect(await lineChannel(null).receive(lineWebhook(LINE_BODY, LINE_SIGNATURE))).toEqual({ kind: "rejected", status: 404 });
  });
});

const NOW = 4097563210000 as EpochMs;
function outbound(over: Partial<OutboundMessage> = {}): OutboundMessage {
  const to: Identity = { channel: "line", channelUserId: USER };
  return { id: "5f0c2c61-0d1e-4c3c-9a43-1d1f6c2a8b10" as OutboxId, to, texts: ["Done.", "(note)"], intent: "reply", inDoubt: false, ...over };
}
const fresh = { token: "reply-token-1", expiresAt: (NOW + 50_000) as EpochMs };

describe("LINE delivery", () => {
  test("a fresh reply token uses the free reply API with every text", async () => {
    const seen = stubFetch(() => Response.json({}));

    expect(await line().deliver(outbound({ reply: fresh }), NOW)).toEqual({ kind: "sent", via: "reply" });
    expect(seen.map((s) => s.url)).toEqual(["https://api.line.me/v2/bot/message/reply"]);
    expect(seen[0].body).toEqual({ replyToken: "reply-token-1", messages: [{ type: "text", text: "Done." }, { type: "text", text: "(note)" }] });
    expect(seen[0].headers.get("authorization")).toBe("Bearer line-access-token");
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

  test("a row in doubt never reuses its reply token", async () => {
    const seen = stubFetch(() => Response.json({}));
    expect(await line().deliver(outbound({ reply: fresh, inDoubt: true }), NOW)).toEqual({ kind: "sent", via: "push" });
    expect(seen.map((s) => s.url)).toEqual(["https://api.line.me/v2/bot/message/push"]);
  });

  test("a rejected reply token falls back to a push", async () => {
    const seen = stubFetch((s) => (s.url.endsWith("/reply") ? Response.json({ message: "Invalid reply token" }, { status: 400 }) : Response.json({})));
    expect(await line().deliver(outbound({ reply: fresh }), NOW)).toEqual({ kind: "sent", via: "push" });
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
    expect(accepted.map((s) => [s.url, s.body])).toEqual([["https://api.telegram.org/bot123:abc/sendMessage", { chat_id: "777000111", text: "Done.\n\n(note)" }]]);
  });

  test("the longest row a turn can produce fits one Telegram message", () => {
    const notices = Object.values(NOTICE).map((n) => (typeof n === "string" ? n : n("x".repeat(TURN.maxNoteChars))));
    const longestSend = TURN.maxLateNoticeChars + "\n".length + TURN.maxTextChars;
    const longestText = Math.max(longestSend, notices.join("\n").length);
    expect(TURN.maxSendsPerTurn * longestText + "\n\n".length * (TURN.maxSendsPerTurn - 1)).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
  });

  test("a block is reported as the recipient being gone; flood control retries when told", async () => {
    stubFetch(() => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 }));
    expect(await telegram().deliver(msg, NOW)).toEqual({ kind: "recipient_gone" });

    vi.restoreAllMocks();
    stubFetch(() => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 5 } }, { status: 429 }));
    expect(await telegram().deliver(msg, NOW)).toMatchObject({ kind: "retry", afterMs: 5000 });
  });
});
