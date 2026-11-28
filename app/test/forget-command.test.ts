import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { devLane, DEV_URL_SCRIPTED } from "../src/access/access";
import { prepareOutsideWrite } from "../src/action/writes";
import { ACCOUNT_COPY } from "../src/agent/account";
import { Agent } from "../src/agent/agent";
import { backupsWithin, HOST_BACKUP_DAYS } from "../src/agent/backups";
import { FORGET_TEXT, type Receipt } from "../src/agent/forget-text";
import { MIGRATIONS, migrate } from "../src/agent/schema";
import { AgentStore } from "../src/agent/store";
import type { ChannelAdapter, Delivery } from "../src/channels/channel";
import type { Env } from "../src/config";
import { eventKey, personAgentKey, type AgentKey, type EpochMs, type Identity, type OutboundMessage } from "../src/domain";
import { connect } from "../src/model/client";
import { scriptedConnect, type ScriptStep } from "../src/model/scripted";
import {
  chat,
  devChat,
  fakeBox,
  fakeProvider,
  local,
  memoryLedger,
  postTelegramUpdate,
  propose,
  routine,
  schedule,
  scripted,
  send,
  TEST_KEYS,
  turn,
  type DevChat,
  type ScriptedChannel,
} from "./testkit";

afterEach(() => {
  vi.restoreAllMocks();
});

const VOLUME = "5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const MARKER = "zanzibar";
const en = FORGET_TEXT.en;

const stubOf = (agent: AgentKey) => env.AGENT.get(env.AGENT.idFromName(agent));
const sql = <T>(c: DevChat, query: string, ...params: unknown[]) =>
  runInDurableObject<Agent, T[]>(stubOf(c.agent), (_a, state) => state.storage.sql.exec(query, ...params).toArray() as T[]);
const nextAlarm = (c: DevChat) => runInDurableObject<Agent, number | null>(stubOf(c.agent), (_a, state) => state.storage.getAlarm());

/** Every table and column of the person's Durable Object whose stored value contains `marker`. */
async function holding(c: DevChat, marker: string): Promise<string[]> {
  return runInDurableObject<Agent, string[]>(stubOf(c.agent), (_a, state) => {
    const s = state.storage.sql;
    const tables = s.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'").toArray();
    const hits = new Set<string>();
    for (const { name } of tables) {
      for (const row of s.exec(`SELECT * FROM "${name}"`).toArray()) {
        for (const [col, v] of Object.entries(row)) {
          if (typeof v === "string" && v.toLowerCase().includes(marker)) hits.add(`${name}.${col}`);
        }
      }
    }
    return [...hits].sort();
  });
}

/** The person writes again a second later, so the message is after the last forget's cutoff. */
async function say(c: DevChat, text: string): Promise<string[]> {
  c.clock.set((c.clock.now() + 1000) as EpochMs);
  await c.say(text);
  return c.received();
}

async function coldDrain(c: DevChat, channel: ScriptedChannel | ChannelAdapter = c.channel, box?: ReturnType<typeof fakeBox>): Promise<void> {
  await runInDurableObject<Agent, void>(stubOf(c.agent), async (_a, state) => {
    const fresh = new Agent(state, env as unknown as Env);
    fresh.withDeps({
      connect: scriptedConnect(c.model, connect(fakeProvider())),
      included: devLane(DEV_URL_SCRIPTED),
      keys: TEST_KEYS,
      clock: c.clock,
      ledger: memoryLedger(),
      channels: { line: channel, telegram: channel, dev: channel },
      admission: "open",
      ...(box ? { box: box.deps } : {}),
    });
    await fresh.alarm();
  });
}

const receipt = (r: Partial<Receipt> = {}) => en.receipt({ deleted: ["all"], backups: "expire", ...r });
const codeOf = (page: string): string => {
  const m = / (#[A-Z0-9]{6}) /.exec(page);
  if (!m) throw new Error(`no code on the page: ${page}`);
  return m[1];
};

describe("replies after a forget", () => {
  test("a Telegram reply cannot bring a forgotten message into the prompt", async () => {
    const user = 10502;
    const oldText = `I saved ${MARKER}.`;
    const model = scripted([
      turn({ actions: [{ type: "remember", note: MARKER }, send(oldText)] }),
      chat("Can you clarify?"), chat("I need more context."), chat("I remember the new message."),
    ]);
    const c = await devChat(String(user), { model, at: "2099-11-04T10:00", channel: "telegram" });
    expect(await say(c, `Remember this: ${MARKER}`)).toEqual([oldText]);
    const originalDate = c.clock.now() / 1000;
    const [page] = await say(c, "/forget");
    const reviewDate = c.clock.now() / 1000 + 1;
    await c.advanceTo("2099-11-04T10:01");
    expect(await say(c, `/forget ${codeOf(page)} 1`)).toEqual([receipt({ deleted: [[1]] })]);
    const completedDate = c.clock.now() / 1000;

    const privateChat = { id: user, type: "private" };
    const askAbout = async (updateId: number, text: string, date: number) => {
      c.clock.set((c.clock.now() + 2000) as EpochMs);
      expect((await postTelegramUpdate({
        update_id: updateId,
        message: {
          chat: privateChat, date: c.clock.now() / 1000, text: "What did you mean by this?",
          reply_to_message: { chat: privateChat, date, text },
        },
      })).status).toBe(200);
      await c.settle();
      return model.calls.at(-1)?.user;
    };

    for (const prompt of [await askAbout(10_502, oldText, originalDate), await askAbout(10_503, page, reviewDate)]) {
      expect(prompt).toContain("Person: What did you mean by this?");
      expect(prompt).not.toContain(MARKER);
      expect(prompt).not.toContain("Earlier message being replied to");
    }
    expect(await holding(c, MARKER)).toEqual([]);
    expect(await askAbout(10_504, "A new message.", completedDate + 1)).toContain(
      'Earlier message being replied to (context, not a request): "A new message."',
    );
    model.assertDone();
  });

  test("a LINE forget receipt leaves no old provider message ID to quote", async () => {
    const id = "461230966842064897";
    const model = scripted([chat(MARKER), chat("Can you clarify?")]);
    const c = await devChat("forget-line-quote", {
      model, at: "2099-11-04T10:00", channel: "line",
      deliveries: [{ kind: "sent", providerMessages: [{ id, position: 0 }] }],
    });
    expect(await say(c, "What should I remember?")).toEqual([MARKER]);
    expect(await sql(c, "SELECT id FROM line_message")).toEqual([{ id }]);

    await sql(c, "CREATE TRIGGER fail_delete_line_message BEFORE DELETE ON line_message BEGIN SELECT RAISE(ABORT, 'cannot delete LINE message'); END");
    c.clock.set((c.clock.now() + 1000) as EpochMs);
    for (let attempt = 0; attempt < 2; attempt++) {
      await runInDurableObject(stubOf(c.agent), async (agent) => {
        await expect(agent.enqueue({
          agent: c.agent, identity: { channel: "line", channelUserId: "forget-line-quote" },
          key: eventKey.line("forget-with-fault"), receivedAt: c.clock.now(), event: { kind: "message", text: "/forget all" },
        })).rejects.toThrow("cannot delete LINE message");
      });
      expect(await c.received()).toEqual([]);
      expect(await sql(c, "SELECT id FROM line_message")).toEqual([{ id }]);
      expect(await sql(c, "SELECT texts FROM outbox WHERE id = (SELECT outbox_id FROM line_message)")).toEqual([{ texts: JSON.stringify([MARKER]) }]);
    }
    await sql(c, "DROP TRIGGER fail_delete_line_message");
    expect(await say(c, "/forget all")).toEqual([FORGET_TEXT.th.receipt({ deleted: ["all"], backups: "expire" })]);
    expect(await sql(c, "SELECT id FROM line_message")).toEqual([]);

    c.clock.set((c.clock.now() + 1000) as EpochMs);
    await c.event({ kind: "message", text: "What was this?", quote: { kind: "reference", id } });
    expect(model.calls[1].user).toContain("Person: What was this?");
    expect(model.calls[1].user).not.toContain("Earlier message being replied to");
    model.assertDone();
  });

  test("a reply held while a forget is open loses its stored quote text when the forget finishes, while still being answered and deduplicated", async () => {
    const user = 10503;
    const model = scripted([
      turn({ actions: [{ type: "remember", note: MARKER }, send(`I saved ${MARKER}.`)] }),
      chat("That list is gone now."),
    ]);
    const c = await devChat(String(user), { model, at: "2099-11-04T10:00", channel: "telegram" });
    expect(await say(c, `Remember this: ${MARKER}`)).toEqual([`I saved ${MARKER}.`]);

    const [page] = await say(c, "/forget");
    expect(page).toContain(MARKER);
    const forgetDate = c.clock.now() / 1000;

    c.clock.set((c.clock.now() + 2000) as EpochMs);
    const privateChat = { id: user, type: "private" };
    const heldUpdate = {
      update_id: 10_521,
      message: {
        chat: privateChat, date: c.clock.now() / 1000, text: "What is this list?",
        reply_to_message: { chat: privateChat, date: forgetDate + 1, text: page },
      },
    };
    expect((await postTelegramUpdate(heldUpdate)).status).toBe(200);
    await c.settle();
    expect(await c.received()).toEqual([en.held]);
    expect(await sql(c, "SELECT status FROM inbox WHERE event_key = 'tg:10521'")).toEqual([{ status: "pending" }]);
    await sql(
      c,
      "INSERT INTO inbox (event_key, kind, payload, received_at, ready_at, status, outcome, finished_at) VALUES (?, 'message', ?, ?, ?, 'done', 'acted', ?)",
      "tg:10520",
      JSON.stringify({ kind: "message", text: "Earlier done reply", quote: { kind: "text", text: page, at: (forgetDate + 1) * 1000 } }),
      c.clock.now(),
      c.clock.now(),
      c.clock.now(),
    );

    await c.advanceTo("2099-11-04T10:01");
    expect(await say(c, `/forget ${codeOf(page)} 1`)).toEqual([receipt({ deleted: [[1]] }), "That list is gone now."]);

    expect(model.calls).toHaveLength(2);
    expect(model.calls[1].user).toContain("Person: What is this list?");
    expect(model.calls[1].user).not.toContain(MARKER);
    expect(model.calls[1].user).not.toContain("Earlier message being replied to");
    expect(await holding(c, MARKER)).toEqual([]);
    expect(await sql(c, "SELECT event_key, status, payload FROM inbox WHERE event_key IN ('tg:10520', 'tg:10521') ORDER BY event_key")).toEqual([
      { event_key: "tg:10520", status: "done", payload: JSON.stringify({ kind: "message", text: "Earlier done reply" }) },
      { event_key: "tg:10521", status: "done", payload: JSON.stringify({ kind: "message", text: "What is this list?" }) },
    ]);

    expect((await postTelegramUpdate(heldUpdate)).status).toBe(200);
    await c.settle();
    expect(await c.received()).toEqual([]);
    expect(model.calls).toHaveLength(2);
    model.assertDone();
  });

  test("if stripping stored inbox quotes fails when a forget finishes, no receipt is sent until it succeeds", async () => {
    const user = 10504;
    const model = scripted([
      turn({ actions: [{ type: "remember", note: MARKER }, send(`I saved ${MARKER}.`)] }),
      chat("That list is gone now."),
    ]);
    const c = await devChat(String(user), { model, at: "2099-11-04T10:00", channel: "telegram" });
    expect(await say(c, `Remember this: ${MARKER}`)).toEqual([`I saved ${MARKER}.`]);

    const [page] = await say(c, "/forget");
    expect(page).toContain(MARKER);
    const forgetDate = c.clock.now() / 1000;

    c.clock.set((c.clock.now() + 2000) as EpochMs);
    const privateChat = { id: user, type: "private" };
    expect((await postTelegramUpdate({
      update_id: 10_531,
      message: {
        chat: privateChat, date: c.clock.now() / 1000, text: "What is this list?",
        reply_to_message: { chat: privateChat, date: forgetDate + 1, text: page },
      },
    })).status).toBe(200);
    await c.settle();
    expect(await c.received()).toEqual([en.held]);

    await sql(c, "CREATE TRIGGER fail_strip_inbox_quote BEFORE UPDATE OF payload ON inbox BEGIN SELECT RAISE(ABORT, 'cannot strip inbox quote'); END");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await c.advanceTo("2099-11-04T10:01");
      const first = await say(c, `/forget ${codeOf(page)} 1`);
      await c.advanceTo("2099-11-04T10:05");
      const whileFailing = [...first, ...(await c.received())];
      expect(whileFailing).toEqual([en.erasing]);
      expect(await sql(c, "SELECT op IS NOT NULL AS open, phase, receipt, completed_at FROM forget")).toEqual([
        { open: 1, phase: "erase", receipt: null, completed_at: null },
      ]);
      expect(await sql(c, "SELECT COUNT(*) AS n FROM outbox WHERE privacy = 'receipt'")).toEqual([{ n: 0 }]);
      expect(model.calls).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith({ code: "drain_forget_failed" });
    } finally {
      warn.mockRestore();
      await sql(c, "DROP TRIGGER IF EXISTS fail_strip_inbox_quote");
    }

    await c.advanceTo("2099-11-04T11:30");
    expect(await c.received()).toEqual([receipt({ deleted: [[1]] }), "That list is gone now."]);
    expect(model.calls[1].user).not.toContain(MARKER);
    expect(await holding(c, MARKER)).toEqual([]);
    model.assertDone();
  });

  test("a forget finished before completed_at existed drops quotes of its review page after migration and when completed_at is still empty", async () => {
    const user = 10505;
    const model = scripted([
      turn({ actions: [{ type: "remember", note: MARKER }, send(`I saved ${MARKER}.`)] }),
      chat("Can you clarify?"),
      chat("I remember the post-upgrade message."),
      chat("Still need more context."),
    ]);
    const c = await devChat(String(user), { model, at: "2099-11-04T10:00", channel: "telegram" });
    expect(await say(c, `Remember this: ${MARKER}`)).toEqual([`I saved ${MARKER}.`]);

    const [page] = await say(c, "/forget");
    expect(page).toContain(MARKER);
    await c.advanceTo("2099-11-04T10:01");
    expect(await say(c, `/forget ${codeOf(page)} 1`)).toEqual([receipt({ deleted: [[1]] })]);

    const forgetDate = Math.floor(Date.now() / 1000) - 10;
    const { beforeMigrate, afterMigrate, completedAt } = await runInDurableObject(stubOf(c.agent), (_agent, { storage }) => {
      const completedMigration = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN completed_at"));
      storage.sql.exec("ALTER TABLE forget DROP COLUMN completed_at");
      storage.sql.exec("UPDATE forget SET cutoff_at = ?, cutoff_seq = NULL", forgetDate * 1000);
      storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'schema_version'", String(completedMigration));
      const before = Date.now();
      migrate(storage);
      const after = Date.now();
      const row = storage.sql.exec<{ completed_at: number | null }>("SELECT completed_at FROM forget").one();
      return { beforeMigrate: before, afterMigrate: after, completedAt: row.completed_at };
    });

    const privateChat = { id: user, type: "private" };
    const askAbout = async (updateId: number, text: string, date: number) => {
      c.clock.set((c.clock.now() + 2000) as EpochMs);
      expect((await postTelegramUpdate({
        update_id: updateId,
        message: {
          chat: privateChat, date: c.clock.now() / 1000, text: "What was this list?",
          reply_to_message: { chat: privateChat, date, text },
        },
      })).status).toBe(200);
      await c.settle();
      return model.calls.at(-1)?.user;
    };

    const reviewPrompt = await askAbout(10_541, page, forgetDate + 1);
    expect(reviewPrompt).toContain("Person: What was this list?");
    expect(reviewPrompt).not.toContain(MARKER);
    expect(reviewPrompt).not.toContain("Earlier message being replied to");
    expect(await holding(c, MARKER)).toEqual([]);

    expect(completedAt).not.toBeNull();
    expect(completedAt!).toBeGreaterThanOrEqual(beforeMigrate - 1000);
    expect(completedAt!).toBeLessThanOrEqual(afterMigrate + 1000);

    const postUpgradePrompt = await askAbout(10_542, "A post-upgrade message.", c.clock.now() / 1000);
    expect(postUpgradePrompt).toContain('Earlier message being replied to (context, not a request): "A post-upgrade message."');

    await sql(c, "UPDATE forget SET completed_at = NULL");
    const emptyCompletedPrompt = await askAbout(10_543, "Even a fresh message.", c.clock.now() / 1000);
    expect(emptyCompletedPrompt).toContain("Person: What was this list?");
    expect(emptyCompletedPrompt).not.toContain("Even a fresh message.");
    expect(emptyCompletedPrompt).not.toContain("Earlier message being replied to");
    model.assertDone();
  });
});

/** A person with a note, a person-asked routine, an agent wake-up, a task with an offered plan, a summary and a box. */
async function seeded(user: string, opts: { readonly box?: boolean; readonly extra?: readonly ScriptStep[] } = {}) {
  const box = fakeBox({ signedIn: true, volume: VOLUME });
  const steps: ScriptStep[] = [
    turn({
      actions: [
        { type: "remember", note: `Lives opposite the ${MARKER} bakery.` },
        routine(`${MARKER}-walk`, "2099-11-05T07:00", `Walk past the ${MARKER} bakery`, "daily"),
        schedule("check-in-later", "2099-11-06T09:00", `Ask how the ${MARKER} trip went`, false),
        send(`Noted, the ${MARKER} bakery.`),
      ],
    }),
    turn({ actions: [send("Here's a plan.")], tasks: [propose("trip", `${MARKER} weekend`, `Fri 18:30 overnight train to ${MARKER} from the central station\nSat market at 9, then the old fort before lunch\nSun 16:00 ferry back home`)] }),
  ];
  const model = scripted(opts.box ? [...(opts.extra ?? [])] : [...steps, ...(opts.extra ?? [])]);
  const c = await devChat(user, { model, at: "2099-11-04T10:00", ...(opts.box ? { box: box.deps } : {}) });
  if (opts.box) {
    await c.say("/claude");
    await c.received();
    box.replies.push(...steps.map((step) => ({ kind: "reply" as const, step })));
  }
  await say(c, `I live opposite the ${MARKER} bakery, remind me daily at 7 to walk past it`);
  await say(c, `plan me a ${MARKER} weekend`);
  await sql(c, "UPDATE memory SET summary = ?", `The person's home faces a bakery on ${MARKER.toUpperCase()} road.`);
  return { c, box, model };
}

describe("/forget all", () => {
  test("clears the chat and every saved item, erases the box last, and sends one receipt", async () => {
    const { c, box } = await seeded("fa-box", { box: true });
    expect((await holding(c, MARKER)).length).toBeGreaterThan(5);

    const replies = await say(c, "/forget all");

    expect(replies).toEqual([receipt()]);
    expect(box.erases).toEqual([1]);
    expect(await holding(c, MARKER)).toEqual([]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM turn")).toEqual([{ n: 0 }]);
    expect(await sql(c, "SELECT key, kind, origin FROM wakeup")).toEqual([{ key: "daily-checkin", kind: "checkin", origin: "system" }]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM task")).toEqual([{ n: 0 }]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM box_session")).toEqual([{ n: 0 }]);
    expect(await sql(c, "SELECT op FROM forget")).toEqual([{ op: null }]);

    box.replies.push({ kind: "reply", step: chat("Hello again.") });
    expect(await say(c, "hello")).toEqual(["Hello again."]);
    const next = box.parses.at(-1);
    expect(next?.agent?.session).toBeNull();
    expect(next?.user.toLowerCase()).not.toContain(MARKER);
    expect(next?.agent?.append.toLowerCase()).not.toContain(MARKER);
    expect(await say(c, "/forget status")).toEqual([en.lastReceipt({ deleted: ["all"], backups: "expire" })]);
  });

  test("works with no AI connected, and the next prompt carries nothing from before", async () => {
    const { c, model } = await seeded("fa-signed-out");
    const signedOut = await devChat("fa-signed-out", { model: null, at: "2099-11-04T10:05" });
    expect(await say(signedOut, "/forget all")).toEqual([receipt()]);
    expect(await holding(c, MARKER)).toEqual([]);

    const back = await devChat("fa-signed-out", { model: scripted([chat("Hi!")]), at: "2099-11-04T10:10" });
    expect(await say(back, "hi")).toEqual(["Hi!"]);
    expect(back.model.calls[0].user.toLowerCase()).not.toContain(MARKER);
    expect(model.calls).toHaveLength(2);
  });

  test("never stores the words after /forget", async () => {
    const c = await devChat("fa-words", { model: scripted([]), at: "2099-11-04T10:00" });
    await say(c, `/forget the ${MARKER} address`);
    expect(await holding(c, MARKER)).toEqual([]);
  });

  test("an agent wake-up, a pending send and a paraphrased summary go without being picked", async () => {
    const { c } = await seeded("fa-leaks");
    await sql(c, "UPDATE outbox SET status = 'pending', ready_at = ? WHERE id = (SELECT id FROM outbox ORDER BY rowid DESC LIMIT 1)", local("2099-11-05T00:00"));

    const page = (await say(c, "/forget"))[0];
    expect(await say(c, `/forget ${codeOf(page)} done`)).toEqual([receipt({ deleted: [[]] })]);

    expect(await sql(c, "SELECT summary FROM memory")).toEqual([{ summary: "" }]);
    expect(await sql(c, "SELECT origin FROM wakeup WHERE origin = 'agent'")).toEqual([]);
    expect(await sql(c, "SELECT status, texts FROM outbox WHERE status IN ('pending', 'sending')")).toEqual([]);
    await c.advanceTo("2099-11-06T12:00");
    expect((await c.received()).join("\n").toLowerCase()).not.toContain("trip went");
    expect(await sql(c, "SELECT texts FROM outbox WHERE texts LIKE '%trip went%'")).toEqual([]);
  });
});

describe("the box erase", () => {
  test("a box that keeps failing leaves the forget pending, holds other messages, and doesn't spin the alarm", async () => {
    const { c, box } = await seeded("erase-fails", { box: true });
    box.eraseSteps.push(...Array.from({ length: 30 }, () => "fail" as const));

    expect(await say(c, "/forget all")).toEqual([]);
    const alarm = await nextAlarm(c);
    expect(alarm).not.toBeNull();
    expect(alarm! - c.clock.now()).toBeGreaterThanOrEqual(10_000);

    await c.advanceTo("2099-11-04T10:10");
    expect(await c.received()).toEqual([en.erasing]);
    expect(await say(c, "are you there?")).toEqual([en.held]);
    expect(await say(c, "hello?")).toEqual([]);
    expect(await say(c, "/forget status")).toEqual([en.erasing]);
    expect(box.erases.length).toBeLessThan(12);

    box.eraseSteps.length = 0;
    box.replies.push({ kind: "reply", step: chat("Sorry for the wait.") });
    await c.advanceTo("2099-11-04T12:00");
    expect(await c.received()).toEqual([receipt(), "Sorry for the wait."]);
  });

  test("a box image without erase stays pending", async () => {
    const { c, box } = await seeded("erase-old-image", { box: true });
    box.eraseSteps.push(...Array.from({ length: 30 }, () => "old_image" as const));
    await say(c, "/forget all");
    await c.advanceTo("2099-11-04T11:00");
    expect(await c.received()).toEqual([en.erasing]);
    expect(await sql(c, "SELECT op IS NOT NULL AS open FROM forget")).toEqual([{ open: 1 }]);
  });

  test("an erase answer from another volume can't complete the forget", async () => {
    const { c, box } = await seeded("erase-wrong-box", { box: true });
    box.eraseSteps.push("wrong_box");
    await say(c, "/forget all");
    expect(await sql(c, "SELECT op IS NOT NULL AS open FROM forget")).toEqual([{ open: 1 }]);
    await c.advanceTo("2099-11-04T10:05");
    expect(box.erases).toEqual([1, 1]);
    expect(await c.received()).toEqual([receipt()]);
  });

  test("an erase answer that arrives after a newer forget began can't complete the newer one", async () => {
    const { c, box } = await seeded("erase-stale", { box: true });
    let open = () => {};
    box.eraseHold = new Promise<void>((r) => (open = r));
    c.clock.set((c.clock.now() + 1000) as EpochMs);
    await c.post("/forget all");
    const first = c.settle();
    for (let i = 0; i < 200 && box.erases.length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    expect(box.erases).toEqual([1]);

    c.clock.set((c.clock.now() + 1000) as EpochMs);
    await c.post("/forget all");
    box.eraseHold = null;
    open();
    await first;
    await c.settle();

    expect(box.erases).toEqual([1, 2]);
    expect(await sql(c, "SELECT epoch, op FROM forget")).toEqual([{ epoch: 2, op: null }]);
    expect(await c.received()).toEqual([en.receipt({ deleted: ["all", "all"], backups: "expire" })]);
  });

  test("an account erase confirmed while the forget's box erase is in flight sends nothing more of the forget", async () => {
    const { c, box } = await seeded("erase-account-meanwhile", { box: true });
    box.eraseSteps.push("fail");
    expect(await say(c, "/forget all")).toEqual([]);
    await say(c, "/erase");
    const confirm = c.channel.delivered.at(-1)?.button;
    if (!confirm) throw new Error("no erase confirmation");

    let open = () => {};
    box.eraseHold = new Promise<void>((r) => (open = r));
    c.clock.set((c.clock.now() + 3 * 60_000) as EpochMs);
    const first = c.settle();
    for (let i = 0; i < 200 && box.erases.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
    expect(box.erases).toEqual([1, 1]);
    await c.post(`/tap ${confirm.data}`);
    box.eraseHold = null;
    open();
    await first;
    await c.settle();

    expect(await c.received()).toEqual([ACCOUNT_COPY.en.receipt + "\n\n" + ACCOUNT_COPY.en.flyCopies + "\n\n" + ACCOUNT_COPY.en.stripeRecords + "\n\n" + ACCOUNT_COPY.en.return]);
    expect((await c.snapshot()).agent).toBeNull();
  });

  test("a crash between the deletion and the erase is survived, and the receipt goes out once", async () => {
    const { c, box } = await seeded("erase-crash", { box: true });
    box.reachable = false;
    await say(c, "/forget all");
    box.reachable = true;
    c.clock.set((c.clock.now() + 60_000) as EpochMs);
    await coldDrain(c, c.channel, box);
    await coldDrain(c, c.channel, box);
    await c.settle();
    expect(await c.received()).toEqual([receipt()]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent' AND texts LIKE '%cleared our chat%'")).toEqual([{ n: 1 }]);
  });
});

describe("/forget lists every saved item and deletes only what the person picks", () => {
  test("the list shows each item whole, and the picked numbers go with every copy", async () => {
    const { c } = await seeded("pick");
    const page = (await say(c, "/forget"))[0];
    expect(page).toContain(`Lives opposite the ${MARKER} bakery.`);
    expect(page).toContain(`Walk past the ${MARKER} bakery`);
    expect(page).toContain("Repeat: daily");
    expect(page).toContain(`${MARKER} weekend`);
    expect(page).toContain("Time zone: Asia/Bangkok");
    expect(page).toContain(en.listDone(codeOf(page)));
    expect(await sql(c, "SELECT COUNT(*) AS n FROM turn")).toEqual([{ n: 0 }]);

    const items = page.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(items.slice(0, 3)).toEqual(["1. Note", "2. Reminder", "3. Task"]);
    expect(await say(c, `/forget ${codeOf(page)} 2 3`)).toEqual([receipt({ deleted: [[2, 3]] })]);

    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: `Lives opposite the ${MARKER} bakery.` }]);
    expect(await sql(c, "SELECT origin FROM wakeup WHERE origin = 'person'")).toEqual([]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM task_fact")).toEqual([{ n: 0 }]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM proposal")).toEqual([{ n: 0 }]);
  });

  test("a confirmation before every page is sent deletes nothing", async () => {
    const c = await devChat("pick-incomplete", { model: scripted([]), at: "2099-11-04T10:00" });
    await sql(c, `INSERT INTO memory_note (text, created_at, event_key)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 130)
      SELECT 'A saved note about the garden, the shed, and the long path down to the river, number ' || i, 0, 'dev:seed' FROM n`);
    const first = (await say(c, "/forget"))[0];
    expect(first).toContain(en.listMore);

    expect(await say(c, "/forget #ABC123 2")).toEqual([en.help]);
    const [{ code }] = await sql<{ code: string }>(c, "SELECT code FROM forget");
    expect(await say(c, `/forget ${code} 2`)).toEqual([en.reviewOpen(null)]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM memory_note")).toEqual([{ n: 130 }]);

    let page = first;
    for (let i = 0; i < 40 && page.includes(en.listMore); i++) page = (await say(c, "/forget next"))[0];
    expect(await say(c, `/forget ${codeOf(page)} 1 130`)).toEqual([receipt({ deleted: [[1, 130]] })]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM memory_note")).toEqual([{ n: 128 }]);
  });

  test("a code from a replaced list, from another chat, or replayed deletes nothing", async () => {
    const { c } = await seeded("pick-replaced");
    const old = codeOf((await say(c, "/forget"))[0]);
    const current = codeOf((await say(c, "/forget"))[0]);
    expect(current).not.toEqual(old);

    expect(await say(c, `/forget ${old} 1`)).toEqual([en.help]);
    const other = await devChat("pick-other-chat", { model: scripted([]), at: "2099-11-04T10:30" });
    expect(await say(other, `/forget ${current} 1`)).toEqual([en.help]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM memory_note")).toEqual([{ n: 1 }]);

    c.clock.set((c.clock.now() + 1000) as EpochMs);
    await c.say(`/forget ${current} 1`, { id: "confirm-1" });
    expect(await c.received()).toEqual([receipt({ deleted: [[1]] })]);
    await c.say(`/forget ${current} 1`, { id: "confirm-1" });
    expect(await c.received()).toEqual([]);
    expect(await say(c, "/forget")).toHaveLength(1);
    const replayed = await c.post(`/forget ${current} 2`, { at: (c.clock.now() - 5000) as EpochMs });
    expect(replayed.status).toBe(200);
    await c.settle();
    expect(await c.received()).toEqual([]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM wakeup WHERE origin = 'person'")).toEqual([{ n: 1 }]);
  });

  test("a time zone and check-in reset keeps a reminder's wall time and moves the check-in to its default", async () => {
    const model = scripted([
      turn({ actions: [{ type: "set_locale", timeZone: "Europe/London", language: "en" }, schedule("dentist", "2099-11-10T09:00", "Dentist at 9"), send("Done.")] }),
    ]);
    const c = await devChat("pick-zone", { model, at: "2099-11-04T10:00" });
    await say(c, "I'm in London now. Remind me of the dentist on the 10th at 9");
    await sql(c, "UPDATE agent SET checkin_local = '10:30'");
    const page = (await say(c, "/forget"))[0];
    expect(page).toContain("Due in the default time zone: 2099-11-10T09:00 Asia/Bangkok");
    const numbers = page.split("\n").flatMap((l) => (/^\d+\. Setting$/.test(l) ? [Number(l.split(".")[0])] : []));
    expect(numbers).toHaveLength(3);

    await say(c, `/forget ${codeOf(page)} ${numbers[1]} ${numbers[2]}`);
    expect(await sql(c, "SELECT tz, checkin_local FROM agent")).toEqual([{ tz: "Asia/Bangkok", checkin_local: "09:00" }]);
    expect(await sql(c, "SELECT due_at FROM wakeup WHERE key = 'dentist'")).toEqual([{ due_at: local("2099-11-10T09:00") }]);
    expect(await sql(c, "SELECT due_at FROM wakeup WHERE key = 'daily-checkin'")).toEqual([{ due_at: local("2099-11-05T09:00") }]);
  });

  test("a kept routine renews on its schedule, and a deleted one never fires again", async () => {
    const model = scripted([
      turn({ actions: [routine("stretch", "2099-11-05T07:00", "Stretch", "daily"), routine("pills", "2099-11-05T07:30", "Take the pills", "daily"), send("Set.")] }),
      ...Array.from({ length: 6 }, () => chat("Good morning.")),
    ]);
    const c = await devChat("pick-routine", { model, at: "2099-11-04T10:00" });
    await say(c, "remind me daily to stretch at 7 and take pills at 7:30");
    const page = (await say(c, "/forget"))[0];
    const pills = page.split("\n").findIndex((l) => l === "Take the pills");
    const number = Number(page.split("\n")[pills - 1].split(".")[0]);
    await say(c, `/forget ${codeOf(page)} ${number}`);

    await c.advanceTo("2099-11-06T08:00");
    const got = (await c.received()).join("\n");
    expect(got).not.toContain("pills");
    expect(await sql(c, "SELECT key, due_at FROM wakeup WHERE kind = 'reminder' AND status = 'pending'")).toEqual([{ key: "stretch", due_at: local("2099-11-07T07:00") }]);
  });

  test("a routine that already fired is one entry, and picking it deletes all of it while the other routine keeps firing", async () => {
    const key = `${MARKER}-stretch`;
    const model = scripted([
      turn({ actions: [routine(key, "2099-11-04T10:30", `Stretch by the ${MARKER} gate`, "daily"), routine("pills", "2099-11-05T07:30", "Take the pills", "daily"), send("Set.")] }),
      chat(`Time to stretch by the ${MARKER} gate.`),
      chat("Time for the pills."),
    ]);
    const c = await devChat("pick-fired-routine", { model, at: "2099-11-04T10:00" });
    await say(c, "remind me daily at 10:30 to stretch by the gate, and at 7:30 to take the pills");
    await c.advanceTo("2099-11-04T10:31");
    expect(await c.received()).toEqual([`Time to stretch by the ${MARKER} gate.`]);
    const counted = "SELECT COUNT(*) AS n FROM routine_delivery WHERE sending_id IS NULL AND at > ?";
    expect(await sql(c, counted, c.clock.now() - 86_400_000)).toEqual([{ n: 1 }]);

    const page = (await say(c, "/forget"))[0];
    const lines = page.split("\n");
    const entries = (k: string) => lines.flatMap((l, i) => (l === `Key: ${k}` ? [{ number: Number(lines[i - 2].split(".")[0]), status: lines[i + 1] }] : []));
    expect.soft(entries(key)).toEqual([{ number: expect.any(Number), status: "Status: pending" }]);
    expect.soft(entries("pills")).toHaveLength(1);

    const stretch = entries(key).find((e) => e.status === "Status: pending");
    if (!stretch) throw new Error(`no pending entry for ${key}: ${page}`);
    expect(await say(c, `/forget ${codeOf(page)} ${stretch.number}`)).toEqual([receipt({ deleted: [[stretch.number]] })]);
    expect(await holding(c, MARKER)).toEqual([]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM wakeup WHERE key = ?", key)).toEqual([{ n: 0 }]);
    expect(await sql(c, counted, c.clock.now() - 86_400_000)).toEqual([{ n: 1 }]);

    await c.advanceTo("2099-11-05T07:31");
    expect(await c.received()).toEqual(["Time for the pills."]);
    expect(await sql(c, "SELECT key, due_at FROM wakeup WHERE kind = 'reminder' AND status = 'pending'")).toEqual([{ key: "pills", due_at: local("2099-11-06T07:30") }]);
    expect(await sql(c, counted, c.clock.now() - 86_400_000)).toEqual([{ n: 2 }]);
  });

  test("a one-off reminder with the same key and note as a routine stays its own entry and isn't deleted with it", async () => {
    const c = await devChat("pick-one-off", { model: scripted([]), at: "2099-11-04T10:00" });
    await say(c, "/forget status");
    await sql(c, `INSERT INTO wakeup (key, kind, origin, note, due_at, status, created_at, created_by, repeat, repeat_anchor) VALUES
      ('stretch', 'reminder', 'person', 'Stretch', ?, 'fired', 0, 'test', NULL, NULL),
      ('stretch', 'reminder', 'person', 'Stretch', ?, 'fired', 0, 'test', 'daily', '2099-11-03T07:00'),
      ('stretch', 'reminder', 'person', 'Stretch', ?, 'pending', 0, 'test', 'daily', '2099-11-03T07:00')`,
    local("2099-11-02T07:00"), local("2099-11-03T07:00"), local("2099-11-05T07:00"));

    const page = (await say(c, "/forget"))[0];
    const lines = page.split("\n");
    const entries = lines.flatMap((l, i) => (l === "Key: stretch" ? [{ number: Number(lines[i - 2].split(".")[0]), status: lines[i + 1] }] : []));
    expect(entries.map((e) => e.status)).toEqual(["Status: fired", "Status: pending"]);

    await say(c, `/forget ${codeOf(page)} ${entries[1].number}`);
    expect(await sql(c, "SELECT status, repeat FROM wakeup WHERE key = 'stretch'")).toEqual([{ status: "fired", repeat: null }]);
  });

  test("an old Accept on a deleted task's plan, tapped or typed, accepts nothing", async () => {
    const { c } = await seeded("pick-accept", { extra: [chat("Okay!"), chat("Okay again!")] });
    const button = c.channel.delivered.at(-1)?.button?.data;
    expect(button).toBeDefined();
    const page = (await say(c, "/forget"))[0];
    await say(c, `/forget ${codeOf(page)} 3`);

    c.clock.set((c.clock.now() + 1000) as EpochMs);
    await c.say(`/tap ${button}`);
    await say(c, "ok");
    const got = (await c.received()).join("\n");
    expect(got).not.toContain("Plan accepted");
    expect(await sql(c, "SELECT COUNT(*) AS n FROM task")).toEqual([{ n: 0 }]);
  });
});

describe("plain words", () => {
  test("a Thai sentence about forgetting keys is an ordinary message", async () => {
    const c = await devChat("plain-thai", { model: scripted([chat("ลองดูในกระเป๋าเสื้อนะคะ")]), at: "2099-11-04T10:00" });
    expect(await say(c, "ลืมกุญแจ")).toEqual(["ลองดูในกระเป๋าเสื้อนะคะ"]);
    expect(await sql(c, "SELECT epoch, op FROM forget")).toEqual([{ epoch: 0, op: null }]);
  });

  test("when the model flags a forget, only the fixed offer goes out and nothing else the turn did is kept", async () => {
    const model = scripted([
      turn({ actions: [{ type: "forget" }, send("Done, I've forgotten it."), { type: "remember", note: `Moved to ${MARKER}.` }, schedule("x-later", "2099-11-06T09:00", "Ask again")] }),
    ]);
    const c = await devChat("plain-flag", { model, at: "2099-11-04T10:00" });
    expect(await say(c, "please forget where I live")).toEqual([en.offer]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM memory_note")).toEqual([{ n: 0 }]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM wakeup WHERE kind = 'reminder'")).toEqual([{ n: 0 }]);
    expect(await sql(c, "SELECT epoch FROM forget")).toEqual([{ epoch: 0 }]);
  });

  test("a model that fails on a forget request deletes nothing", async () => {
    const c = await devChat("plain-fails", { model: scripted([{ kind: "throw" }, { kind: "throw" }, { kind: "throw" }]), at: "2099-11-04T10:00" });
    await sql(c, "INSERT INTO memory_note (text, created_at, event_key) VALUES ('kept', 0, 'dev:seed')");
    await say(c, "forget my address");
    await c.advanceTo("2099-11-04T12:00");
    expect(await sql(c, "SELECT epoch FROM forget")).toEqual([{ epoch: 0 }]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM memory_note")).toEqual([{ n: 1 }]);
  });
});

/** A LINE or Telegram account as seen from the agent: a reply token that may have expired, and sends that may be in doubt. */
function channelOf(outcome: (msg: OutboundMessage, now: EpochMs) => Delivery): ChannelAdapter & { readonly sent: string[]; reset(): void } {
  const sent: string[] = [];
  return {
    sent,
    reset: () => void sent.splice(0),
    receive: async () => ({ kind: "rejected", status: 404 }),
    async deliver(msg, now) {
      const d = outcome(msg, now);
      if (d.kind === "sent") sent.push(msg.texts.join("\n"));
      return d;
    },
  };
}

/** The person's first message is a /forget status, which makes their agent without a model, so a test can set them up after. */
async function onChannel(user: string, channel: "line" | "telegram", adapter: ChannelAdapter & { reset(): void }) {
  const c = await devChat(user, { model: scripted([]), at: "2099-11-04T10:00", channel });
  await runInDurableObject<Agent, void>(stubOf(c.agent), (a) => a.withDeps({ channels: { line: adapter, telegram: adapter, dev: adapter } }));
  const identity: Identity = { channel, channelUserId: user };
  let n = 0;
  const message = async (text: string, reply: boolean) => {
    c.clock.set((c.clock.now() + 1000) as EpochMs);
    const at = c.clock.now();
    await stubOf(c.agent).enqueue({
      agent: personAgentKey(identity), identity, key: channel === "line" ? eventKey.line(`${user}-${++n}`) : eventKey.telegram(9000 + ++n), receivedAt: at,
      event: { kind: "message", text, ...(reply ? { reply: { token: `tok-${n}`, expiresAt: (at + 60_000) as EpochMs } } : {}) },
    });
    await c.settle();
  };
  await message("/forget status", false);
  adapter.reset();
  return { c, message };
}

describe("delivery of the forget's own messages", () => {
  test("a removed person on LINE whose reply token expired gets the receipt from /forget status", async () => {
    const line = channelOf((msg, now) => (msg.replyOnly && !(msg.reply && now < msg.reply.expiresAt - 10_000) ? { kind: "failed", detail: "reply_only" } : { kind: "sent", via: "reply" }));
    const box = fakeBox({ signedIn: true, volume: VOLUME });
    const { c, message } = await onChannel("U0123456789abcdef0123456789abcdef", "line", line);
    await runInDurableObject<Agent, void>(stubOf(c.agent), (a) => a.withDeps({ box: box.deps }));
    await sql(c, "INSERT INTO box (one, name, host, url, state, state_at) VALUES (1, 'gbox-x', 'fly', 'https://gbox-x.box.test', 'signed_in', 0)");
    box.created.add("gbox-x");
    box.reachable = false;
    await c.remove();
    c.clock.set((c.clock.now() + 1000) as EpochMs);
    await message("/forget all", true);
    expect(await sql(c, "SELECT state FROM box")).toEqual([{ state: "reclaiming" }]);
    box.reachable = true;
    c.clock.set((c.clock.now() + 120_000) as EpochMs);
    await c.settle();
    expect(await sql(c, "SELECT state FROM box")).toEqual([]);
    expect(line.sent).toEqual([]);

    await message("/forget status", true);
    expect(line.sent).toEqual([FORGET_TEXT.th.lastReceipt({ deleted: ["all"], backups: "expire" })]);
  });

  test("a Telegram receipt whose send was in doubt isn't sent again by itself, and /forget status offers it", async () => {
    let doubt = false;
    const tg = channelOf(() => (doubt ? ((doubt = false), { kind: "retry", afterMs: 30_000, detail: "502" }) : { kind: "sent", via: "push" }));
    const { c, message } = await onChannel("4242", "telegram", tg);
    doubt = true;
    await message("/forget all", false);
    await c.advanceTo("2099-11-04T11:00");
    expect(tg.sent).toEqual([]);
    await message("/forget status", false);
    expect(tg.sent).toEqual([en.lastReceipt({ deleted: ["all"], backups: "expire" })]);
  });

  test("a blocked person stays blocked and gets nothing", async () => {
    const tg = channelOf(() => ({ kind: "sent", via: "push" }));
    const { c, message } = await onChannel("4343", "telegram", tg);
    await sql(c, "UPDATE agent SET status = 'blocked'");
    await message("/forget all", false);
    expect(tg.sent).toEqual([]);
    expect(await sql(c, "SELECT status FROM agent")).toEqual([{ status: "blocked" }]);
    expect(await sql(c, "SELECT op FROM forget")).toEqual([{ op: null }]);
  });
});

describe("a forget left open", () => {
  test("reminds the person a few times, answers /forget status, and keeps ordinary chat held", async () => {
    const { c } = await seeded("open-review");
    await say(c, "/forget");
    expect(await say(c, "what's the weather?")).toEqual([en.held]);
    await c.advanceTo("2099-11-09T10:00");
    const reminders = await c.received();
    expect(reminders.length).toBeGreaterThanOrEqual(1);
    expect(reminders.length).toBeLessThanOrEqual(3);
    expect(new Set(reminders).size).toBe(1);
    expect(await say(c, "/forget status")).toHaveLength(1);
    expect(c.model.calls).toHaveLength(2);
    await c.advanceTo("2099-11-20T10:00");
    expect(await c.received()).toEqual([]);
  });
});

describe("the receipt's backup sentence", () => {
  test("is used only when every backup copy has a documented expiry within 30 days", () => {
    expect(backupsWithin([HOST_BACKUP_DAYS.durableObject, ...HOST_BACKUP_DAYS.fly])).toBe("expire");
    expect(backupsWithin([HOST_BACKUP_DAYS.durableObject, 60])).toBe("pending");
    expect(backupsWithin([HOST_BACKUP_DAYS.durableObject, ...HOST_BACKUP_DAYS.static])).toBe("pending");
    expect(en.receipt({ deleted: [[2, 5]], backups: "pending" })).toBe(
      "I cleared our chat and deleted saved items 2 and 5. Removing the backup copies at our hosts is still pending.",
    );
  });
});

describe("the model flag and recovery on other paths", () => {
  test("a forget the person's box flags sends only the offer and saves nothing else", async () => {
    const box = fakeBox({ signedIn: true, volume: VOLUME });
    const c = await devChat("flag-box", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();
    box.replies.push({ kind: "reply", step: turn({ actions: [{ type: "forget" }, send("I forgot it."), { type: "remember", note: `Moved to ${MARKER}.` }] }) });

    expect(await say(c, "please forget where I live")).toEqual([en.offer]);
    expect(box.parses.at(-1)?.agent?.tools).toContain("forget");
    expect(await sql(c, "SELECT COUNT(*) AS n FROM memory_note")).toEqual([{ n: 0 }]);
    expect(await sql(c, "SELECT epoch FROM forget")).toEqual([{ epoch: 0 }]);
  });

  test("a page left sending by a send that died is recovered and sent again during the hold", async () => {
    const c = await devChat("crash-page", { model: scripted([]), at: "2099-11-04T10:00", deliveries: [{ kind: "throw" }] });
    await sql(c, "INSERT INTO memory_note (text, created_at, event_key) VALUES ('kept note', 0, 'dev:seed')");
    const [page] = await say(c, "/forget");
    expect(await sql(c, "SELECT status, attempts FROM outbox WHERE privacy = 'page'")).toEqual([{ status: "sent", attempts: 2 }]);
    expect(page).toContain("kept note");
    expect(page).toContain(en.listDone(codeOf(page)));
  });

  test("a Telegram receipt left sending by a send that died isn't sent again by itself", async () => {
    let dies = false;
    const tg = channelOf(() => {
      if (dies) throw new Error("the instance died mid-send");
      return { kind: "sent", via: "push" };
    });
    const { c, message } = await onChannel("4545", "telegram", tg);
    dies = true;
    await message("/forget all", false);
    dies = false;
    await coldDrain(c, tg);
    expect(await sql(c, "SELECT status, attempts FROM outbox WHERE privacy = 'receipt'")).toEqual([{ status: "dropped", attempts: 1 }]);
    expect(tg.sent).toEqual([]);
    await message("/forget status", false);
    expect(tg.sent).toEqual([en.lastReceipt({ deleted: ["all"], backups: "expire" })]);
  });
});

describe("stores added on main", () => {
  test("a routine that fired leaves no marker once the person picks it, and its send still counts toward the routine cap", async () => {
    const key = `${MARKER}-stretch`;
    const model = scripted([
      turn({ actions: [routine(key, "2099-11-04T10:30", `Stretch by the ${MARKER} gate`, "daily"), send("Set.")] }),
      chat(`Time to stretch by the ${MARKER} gate.`),
    ]);
    const c = await devChat("routine-marker", { model, at: "2099-11-04T10:00" });
    await say(c, "remind me daily at 10:30 to stretch by the gate");
    await c.advanceTo("2099-11-04T10:31");
    expect(await c.received()).toEqual([`Time to stretch by the ${MARKER} gate.`]);
    const counted = "SELECT COUNT(*) AS n FROM routine_delivery WHERE sending_id IS NULL AND at > ?";
    expect(await sql(c, counted, c.clock.now() - 86_400_000)).toEqual([{ n: 1 }]);
    expect(await holding(c, MARKER)).toEqual(["inbox.payload", "outbox.texts", "turn.text", "wakeup.key", "wakeup.note"]);

    const page = (await say(c, "/forget"))[0];
    const lines = page.split("\n");
    const picks = lines.flatMap((l, i) => (l === `Key: ${key}` ? [Number(lines[i - 2].split(".")[0])] : []));
    expect(picks).toHaveLength(1);
    expect(await say(c, `/forget ${codeOf(page)} ${picks.join(" ")}`)).toEqual([receipt({ deleted: [picks] })]);

    expect(await holding(c, MARKER)).toEqual([]);
    expect(await sql(c, counted, c.clock.now() - 86_400_000)).toEqual([{ n: 1 }]);
  });

  test("every forget deletes outside writes and their approvals, even when the person keeps every saved item", async () => {
    const c = await devChat("outside-writes", { model: scripted([]), at: "2099-11-04T10:00" });
    await say(c, "/forget status");
    await runInDurableObject<Agent, void>(stubOf(c.agent), (_a, state) => {
      const store = new AgentStore(state.storage);
      const now = c.clock.now();
      const draft = (intent: string, approval: boolean) => {
        const d = prepareOutsideWrite({
          intent, provider: "mail", action: "send", args: { body: `Meet at the ${MARKER} gate` }, epoch: store.forget().epoch, now,
          ...(approval ? { approval: { owner: c.agent, expiresAt: (now + 60_000) as EpochMs } } : {}),
        });
        if (!d) throw new Error("no draft");
        expect(store.putOutsideWrite(d.write, d.approval).kind).toBe("created");
        return d.write.id;
      };
      draft("awaiting-approval", true);
      const done = draft("already-sent", false);
      const begun = store.beginOutsideWrite(done, now, 30_000, store.forget().epoch);
      if (!begun) throw new Error("not begun");
      store.finishOutsideWrite(done, begun.attempt, { kind: "succeeded", receipt: { thread: `${MARKER}-thread` } }, now);
    });
    expect(await holding(c, MARKER)).toEqual(["outside_write.args", "outside_write.receipt"]);

    const page = (await say(c, "/forget"))[0];
    expect(await say(c, `/forget ${codeOf(page)} done`)).toEqual([receipt({ deleted: [[]] })]);

    expect(await holding(c, MARKER)).toEqual([]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM outside_approval")).toEqual([{ n: 0 }]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM outside_write")).toEqual([{ n: 0 }]);
  });
});
