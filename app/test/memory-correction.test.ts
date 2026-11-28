import { createHash } from "node:crypto";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { prepareOutsideWrite } from "../src/action/writes";
import type { Agent } from "../src/agent/agent";
import { MIGRATIONS, migrate } from "../src/agent/schema";
import { AgentStore } from "../src/agent/store";
import type { AgentKey, EpochMs } from "../src/domain";
import type { ScriptStep } from "../src/model/scripted";
import { cancel, chat, devChat, fakeBox, hold, holding, local, postTelegramUpdate, propose, rewindQuoteRewrites, schedule, scripted, send, turn, type DevChat } from "./testkit";

const WRONG = "Zanzibar";
const RIGHT = "Mombasa";
const SECRET = "whiskerton";
const PLAN = `Fri 18:30 overnight train to see ${WRONG}\nSat market at 9 with ${WRONG}\nSun 16:00 ferry back home`;

const stubOf = (agent: AgentKey) => env.AGENT.get(env.AGENT.idFromName(agent));
const sql = <T>(c: DevChat, query: string, ...params: unknown[]) =>
  runInDurableObject<Agent, T[]>(stubOf(c.agent), (_a, state) => state.storage.sql.exec(query, ...params).toArray() as T[]);

const correct = (wrong: string, right: string) => ({ type: "correct", wrong, right });
const dontRemember = () => ({ type: "dont_remember" });

/** A note, a reminder the person asked for, a task with an offered plan, all naming the sister, and a summary that does too. */
const seedSteps: ScriptStep[] = [
  turn({
    actions: [
      { type: "remember", note: `Sister ${WRONG} lives in Hat Yai.` },
      schedule(`call-${WRONG.toLowerCase()}`, "2099-11-05T09:00", `Call ${WRONG} about Friday`),
      send(`Noted, ${WRONG}.`),
    ],
    tasks: [propose(`${WRONG.toLowerCase()}-visit`, `${WRONG} visit`, PLAN)],
  }),
];

async function seed(c: DevChat): Promise<void> {
  await c.say(`My sister ${WRONG} lives in Hat Yai. Remind me tomorrow at 9 to call her, and plan a visit.`);
  await sql(c, "UPDATE memory SET summary = ?", `The person's sister ${WRONG.toUpperCase()} lives in Hat Yai.`);
}

async function later(c: DevChat, text: string): Promise<string[]> {
  c.clock.set((c.clock.now() + 60_000) as EpochMs);
  await c.say(text);
  return c.received();
}

describe("a correction", () => {
  test("corrects the words in a stored reply quote", async () => {
    const model = scripted([
      turn({ actions: [{ type: "remember", note: "The city is Zanzibar." }, send("Saved.")] }),
      chat("I see."),
      turn({ actions: [correct(WRONG, RIGHT), send("Updated.")] }),
    ]);
    const c = await devChat("correct-stored-quote", { model, at: "2099-11-04T10:00" });
    await later(c, "Remember the city Zanzibar.");
    await c.event({ kind: "message", text: "About that trip", quote: { kind: "text", at: c.clock.now(), text: "The city is Zanzibar." } });
    expect(model.calls[1].user).toContain('context, not a request): "The city is Zanzibar."');

    await later(c, "The city is actually Mombasa.");

    expect(await sql(c, "SELECT json_extract(payload, '$.quote.text') AS text FROM inbox WHERE json_type(payload, '$.quote') IS NOT NULL"))
      .toEqual([{ text: "The city is Mombasa." }]);
  });

  test.each([
    ["line", false], ["line", true], ["telegram", false], ["telegram", true],
  ] as const)("a reply to an old %s message (legacy: %s) uses the corrected words", async (channel, legacy) => {
    const id = "461230966842064897";
    const script = scripted([
      turn({ actions: [{ type: "remember", note: "The city is Zanzibar." }, send("The city is Zanzibar.")] }),
      turn({ actions: [correct(WRONG, RIGHT), send("Updated.")] }),
      chat("I see."),
    ]);
    let advance = () => {};
    const model = { ...script, send(req: Parameters<typeof script.send>[0]) {
      if (legacy) advance();
      return script.send(req);
    } };
    const c = await devChat("correct-old-quote", {
      model, at: "2099-11-04T10:00", channel,
      deliveries: [{ kind: "sent", providerMessages: [{ id, position: 0 }] }],
    });
    advance = () => c.clock.set((c.clock.now() + 10) as EpochMs);
    expect(await later(c, "Remember the city Zanzibar.")).toEqual(["The city is Zanzibar."]);
    const at = c.clock.now();
    if (legacy) {
      expect(await sql(c, "SELECT o.created_at - t.at AS delay FROM outbox o JOIN turn t USING (event_key) WHERE t.role = 'agent'"))
        .toEqual([{ delay: 10 }]);
      await sql(c, "UPDATE turn SET correction_spans = NULL");
      await sql(c, "UPDATE outbox SET correction_spans = NULL");
    }
    await later(c, "The city is actually Mombasa.");

    const quote = channel === "line" ? { kind: "reference" as const, id } : { kind: "text" as const, at, text: "The city is Zanzibar." };
    await c.event({ kind: "message", text: "About that trip", quote });
    expect(model.calls[2].user).toContain('context, not a request): "The city is Mombasa."');
    expect(model.calls[2].user).not.toContain(WRONG);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM inbox WHERE payload LIKE ?", "%" + WRONG + "%")).toEqual([{ n: 0 }]);
  });

  test("keeps an unrelated old Telegram quote when its sent copy is still stored", async () => {
    const model = scripted([
      turn({ actions: [{ type: "remember", note: "The city is Zanzibar." }, send("Nothing else to add.")] }),
      turn({ actions: [correct(WRONG, RIGHT), send("Updated.")] }),
      chat("I see."),
    ]);
    const c = await devChat("correct-unrelated-quote", { model, at: "2099-11-04T10:00", channel: "telegram" });
    await later(c, "Remember Zanzibar.");
    const at = c.clock.now();
    await later(c, "Change the name.");
    await c.event({ kind: "message", text: "What did you mean?", quote: { kind: "text", at, text: "Nothing else to add." } });
    expect(model.calls[2].user).toContain('context, not a request): "Nothing else to add."');
  });

  test("refuses the whole correction when a note would exceed its byte cap", async () => {
    const note = "fox ".repeat(75).trimEnd();
    const replacement = "aardvark".repeat(37);
    const model = scripted([
      turn({ actions: [{ type: "remember", note }, send("Noted fox.")] }),
      turn({ actions: [correct("fox", replacement), send("Correction received.")] }),
    ]);
    const c = await devChat("correct-note-cap", { model, at: "2099-11-04T10:00" });
    await later(c, "Remember these fox entries.");
    await sql(c, "UPDATE memory SET summary = 'The person keeps fox entries.'");

    expect(await later(c, "The name has changed.")).toEqual(["Correction received."]);

    expect(await sql(c, "SELECT length(CAST(text AS BLOB)) AS bytes FROM memory_note")).toEqual([{ bytes: 299 }]);
    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: note }]);
    expect(await sql(c, "SELECT summary FROM memory")).toEqual([{ summary: "The person keeps fox entries." }]);
    expect(c.logs("rejection")).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "too_long" })]));
  });

  test("refuses a replacement over 300 bytes even if the saved summary could hold it", async () => {
    const replacement = "a".repeat(301);
    const model = scripted([chat("Hello."), turn({ actions: [correct("fox", replacement), send("Okay.")] })]);
    const c = await devChat("correct-replacement-cap", { model, at: "2099-11-04T10:00" });
    await later(c, "Hello.");
    await sql(c, "UPDATE memory SET summary = 'The person keeps fox entries.'");

    expect(await later(c, "The name has changed.")).toEqual(["Okay.\n(I couldn't make that correction, so what I saved is unchanged.)"]);
    expect(await sql(c, "SELECT summary FROM memory")).toEqual([{ summary: "The person keeps fox entries." }]);
  });

  test("refuses the correction when an outgoing model reply would exceed its cap", async () => {
    const reply = "fox ".repeat(150).trimEnd();
    const model = scripted([
      turn({ actions: [{ type: "remember", note: "The label is fox." }, send("Noted.")] }),
      turn({ actions: [correct("fox", "bear"), send(reply)] }),
    ]);
    const c = await devChat("correct-reply-cap", { model, at: "2099-11-04T10:00" });
    await later(c, "Remember the label fox.");

    expect(await later(c, "Change the label.")).toEqual([reply]);
    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: "The label is fox." }]);
  });

  test("trims the already sent copies at a word boundary instead of refusing the correction", async () => {
    const reply = "fox " + "route ".repeat(101) + "home";
    const model = scripted([
      turn({ actions: [{ type: "remember", note: "The label is fox." }, send(reply)] }),
      turn({ actions: [correct("fox", "longer animal ".repeat(8).trimEnd()), send("Updated.")] }),
      chat("Hello."),
    ]);
    const c = await devChat("correct-sent-cap", { model, at: "2099-11-04T10:00" });
    const original = await later(c, "Remember the label fox.");
    expect(original[0]).toHaveLength(600);
    expect(await later(c, "Change the label.")).toEqual(["Updated."]);
    expect(await holding(c.agent, "fox")).toEqual([]);
    const [stored] = await sql<{ text: string }>(c, "SELECT json_extract(texts, '$[0]') AS text FROM outbox ORDER BY rowid LIMIT 1");
    expect(stored.text.length).toBeLessThanOrEqual(600);
    expect(stored.text).toMatch(/ route(?:…)?$/);
    expect(await sql(c, "SELECT text FROM turn WHERE role = 'agent' ORDER BY seq LIMIT 1")).toEqual([stored]);
    await later(c, "Hello.");
    expect(model.calls.at(-1)?.user).not.toContain("fox");
  });

  test("refuses the correction when a wake-up key would exceed its cap", async () => {
    const key = "old-" + "a".repeat(36);
    const model = scripted([
      turn({ actions: [schedule(key, "2099-11-05T09:00", "Take the old route"), send("Noted.")] }),
      turn({ actions: [correct("old", "newer"), send("Okay.")] }),
    ]);
    const c = await devChat("correct-key-cap", { model, at: "2099-11-04T10:00" });
    await later(c, "Remind me to take the old route tomorrow at nine.");

    expect(await later(c, "The route name has changed.")).toEqual(["Okay."]);
    expect(await sql(c, "SELECT key, note FROM wakeup WHERE kind = 'reminder'")).toEqual([{ key, note: "Take the old route" }]);
  });

  test.each(["region", "region\nReview marker"])("delivers the fixed invalid-zone notice during a correction to %j", async (replacement) => {
    const model = scripted([
      turn({ actions: [{ type: "remember", note: "My label is time zone." }, send("Noted.")] }),
      turn({ actions: [correct("time zone", replacement), { type: "set_locale", language: "en", timeZone: "Invalid/Zone" }, send("The label was time zone.")] }),
    ]);
    const c = await devChat("correct-fixed-notice", { model, at: "2099-11-04T10:00" });
    await later(c, "The label I use is time zone.");
    const visible = await later(c, "Use the new label.");
    const notice = "(I couldn't find that time zone, so I kept the one you had.)";

    const refused = replacement === "region" ? "" : "\n(I couldn't make that correction, so what I saved is unchanged.)";

    expect(visible.join("\n")).toContain(notice);
    expect(await sql(c, "SELECT text FROM turn WHERE role = 'note'")).toEqual([{ text: notice + refused }]);
    const label = replacement === "region" ? replacement : "time zone";
    expect(visible).toEqual(["The label was " + label + ".\n" + notice + refused]);
    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: "My label is " + label + "." }]);
  });

  test("corrects identifiable personal and model history written before text sources were stored", async () => {
    const model = scripted([
      turn({ actions: [{ type: "remember", note: "My label is time zone." }, { type: "set_locale", language: "en", timeZone: "Invalid/Zone" }, send("Your label is time zone.")] }),
      turn({ actions: [correct("time zone", "region"), send("Okay.")] }),
    ]);
    const c = await devChat("correct-legacy-history", { model, at: "2099-11-04T10:00" });
    await later(c, "I call it time zone.");
    await sql(c, "UPDATE turn SET correction_spans = NULL");
    await sql(c, "UPDATE outbox SET correction_spans = NULL");

    expect(await later(c, "Change the label.")).toEqual(["Okay."]);
    expect(await sql(c, "SELECT role, text FROM turn ORDER BY seq LIMIT 3")).toEqual([
      { role: "person", text: "I call it region." },
      { role: "agent", text: "Your label is region." },
      { role: "note", text: "(I couldn't find that time zone, so I kept the one you had.)" },
    ]);
  });

  test("replaces the wrong words in every store, and the next prompt carries only the right ones", async () => {
    const model = scripted([...seedSteps, turn({ actions: [correct(WRONG, RIGHT), send(`Thanks, ${RIGHT} it is.`)] }), chat("Hi!")]);
    const c = await devChat("correct-everywhere", { model, at: "2099-11-04T10:00" });
    await seed(c);
    expect(await holding(c.agent, WRONG)).toEqual(expect.arrayContaining(["memory.summary", "memory_note.text", "proposal.text", "task.ref", "task.title", "turn.text", "wakeup.key", "wakeup.note"]));
    await c.received();

    const replies = await later(c, `That's wrong, her name is ${RIGHT}, not ${WRONG}.`);

    expect(await holding(c.agent, WRONG)).toEqual([]);
    expect(replies).toEqual([`Thanks, ${RIGHT} it is.`]);
    expect(await holding(c.agent, RIGHT)).toEqual(expect.arrayContaining([
      "inbox.payload", "memory.summary", "memory_note.text", "outbox.texts", "proposal.text", "task.ref", "task.title", "turn.text", "wakeup.key", "wakeup.note",
    ]));
    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: `Sister ${RIGHT} lives in Hat Yai.` }]);
    expect(await sql(c, "SELECT key, note FROM wakeup WHERE kind = 'reminder'")).toEqual([{ key: "call-mombasa", note: `Call ${RIGHT} about Friday` }]);
    expect(await sql(c, "SELECT ref, title FROM task")).toEqual([{ ref: "mombasa-visit", title: `${RIGHT} visit` }]);

    expect(await later(c, "hi")).toEqual(["Hi!"]);
    const prompt = model.calls.at(-1)?.user ?? "";
    expect(prompt.toLowerCase()).not.toContain(WRONG.toLowerCase());
    expect(prompt).toContain(`Sister ${RIGHT} lives in Hat Yai.`);
    expect(prompt).toContain("call-mombasa");
  });

  test("through the person's box, the next box request starts a new session that holds only the right words", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("correct-box", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();
    box.replies.push(...seedSteps.map((step) => ({ kind: "reply" as const, step })));
    await seed(c);
    box.replies.push({ kind: "reply", step: turn({ actions: [correct(WRONG, RIGHT), send(`Fixed, ${RIGHT} not ${WRONG}.`)] }) });
    await c.received();

    const replies = await later(c, `No, it's ${RIGHT}, not ${WRONG}.`);
    expect(await holding(c.agent, WRONG)).toEqual([]);
    expect(replies).toEqual([`Fixed, ${RIGHT} not ${RIGHT}.`]);
    expect(box.parses.at(-1)?.agent?.tools).toContain("correct");

    box.replies.push({ kind: "reply", step: chat("Hello.") });
    expect(await later(c, "hello")).toEqual(["Hello."]);
    const next = box.parses.at(-1);
    expect(next?.agent?.session).toBeNull();
    expect(next?.user.toLowerCase()).not.toContain(WRONG.toLowerCase());
    expect(next?.agent?.append.toLowerCase()).not.toContain(WRONG.toLowerCase());
    expect(next?.agent?.append).toContain(`Sister ${RIGHT} lives in Hat Yai.`);
  });

  test("changes nothing when the wrong words are too short, the same as the right ones, not in what was saved, or come from a wake-up", async () => {
    const model = scripted([
      turn({ actions: [{ type: "remember", note: `Sister ${WRONG} lives in a flat in Hat Yai.` }, schedule("tea", "2099-11-04T12:00", "Make tea"), send("Noted.")] }),
      turn({ actions: [correct("a", RIGHT), correct(WRONG, WRONG.toLowerCase()), correct("Kilimanjaro", RIGHT), correct(WRONG, " "), send("Okay.")] }),
      turn({ actions: [correct(WRONG, RIGHT), send("Tea time.")] }),
    ]);
    const c = await devChat("correct-refused", { model, at: "2099-11-04T10:00" });
    expect(await later(c, `My sister ${WRONG} lives in Hat Yai. Remind me at noon to make tea.`)).toEqual(["Noted."]);
    expect(await later(c, "Actually that's not right.")).toEqual(["Okay.\n(I couldn't make that correction, so what I saved is unchanged.)"]);
    await c.advanceTo("2099-11-04T12:01");
    expect(await c.received()).toEqual(["Tea time."]);

    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: `Sister ${WRONG} lives in a flat in Hat Yai.` }]);
    expect(await holding(c.agent, RIGHT)).toEqual([]);
  });
});

describe("a short word", () => {
  test("is corrected with the words next to it, and a bare short word tells the person nothing changed", async () => {
    const model = scripted([
      turn({ actions: [{ type: "remember", note: "Nickname is Jo." }, send("Noted.")] }),
      turn({ actions: [correct("Jo", "Joe"), send("Got it, Joe.")] }),
      turn({ actions: [correct("Nickname is Jo", "Nickname is Joe"), send("Got it, Joe.")] }),
    ]);
    const c = await devChat("correct-short", { model, at: "2099-11-04T10:00" });
    expect(await later(c, "Call me Jo.")).toEqual(["Noted."]);
    expect(await later(c, "Sorry, it is Joe, not Jo.")).toEqual(["Got it, Joe.\n(I couldn't make that correction, so what I saved is unchanged.)"]);
    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: "Nickname is Jo." }]);
    expect(await later(c, "It's Joe.")).toEqual(["Got it, Joe."]);
    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: "Nickname is Joe." }]);
  });

  test("says nothing changed only when no correction in the turn went through", async () => {
    const model = scripted([
      turn({ actions: [{ type: "remember", note: "Nickname is Jo." }, send("Noted.")] }),
      turn({ actions: [correct("Jo", "Joe"), correct("Nickname is Jo", "Nickname is Joe"), send("Got it, Joe.")] }),
    ]);
    const c = await devChat("correct-short-mixed", { model, at: "2099-11-04T10:00" });
    await later(c, "Call me Jo.");
    expect(await later(c, "Sorry, it is Joe, not Jo.")).toEqual(["Got it, Joe."]);
    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: "Nickname is Joe." }]);
  });

  test("a Thai person hears in Thai that a refused correction changed nothing", async () => {
    const model = scripted([
      turn({ actions: [{ type: "set_locale", timeZone: "Asia/Bangkok", language: "th" }, { type: "remember", note: "แพ้ปู" }, send("รับทราบค่ะ")] }),
      turn({ actions: [correct("ปู", "กุ้ง"), send("แก้แล้วค่ะ")] }),
    ]);
    const c = await devChat("correct-short-th", { model, at: "2099-11-04T10:00" });
    expect(await later(c, "ฉันแพ้ปู")).toEqual(["รับทราบค่ะ"]);
    expect(await later(c, "ไม่ใช่ปู แพ้กุ้งค่ะ")).toEqual(["แก้แล้วค่ะ\n(แก้ข้อมูลนั้นไม่ได้ สิ่งที่บันทึกไว้ยังเหมือนเดิมค่ะ)"]);
    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: "แพ้ปู" }]);
  });
});

describe("what a correction leaves alone or deletes", () => {
  test("the daily check-in keeps its reserved key when the wrong word is in it", async () => {
    const model = scripted([
      turn({ actions: [{ type: "remember", note: "Takes the pills daily." }, send("Noted.")] }),
      turn({ actions: [correct("daily", "twice a day"), send("Okay, twice a day.")] }),
    ]);
    const c = await devChat("correct-checkin", { model, at: "2099-11-04T10:00" });
    expect(await later(c, "I take my pills daily.")).toEqual(["Noted."]);
    expect(await later(c, "Not daily, twice a day.")).toEqual(["Okay, twice a day."]);
    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: "Takes the pills twice a day." }]);
    expect(await sql(c, "SELECT key FROM wakeup WHERE kind = 'checkin'")).toEqual([{ key: "daily-checkin" }]);
  });

  test("clears a delivered plan receipt that quotes the wrong title", async () => {
    const model = scripted([
      turn({ actions: [{ type: "remember", note: "The destination is Zanzibar." }, send("Here's the itinerary.")], tasks: [propose("visit", "Zanzibar visit", PLAN)] }),
      chat("Booked."),
      turn({ actions: [correct(WRONG, RIGHT), send("Corrected.")] }),
    ]);
    const c = await devChat("correct-plan-receipt", { model, at: "2099-11-04T10:00" });
    await later(c, "Please plan a visit to Zanzibar.");
    await c.tap("a:1.1");
    expect(await c.received()).toEqual(["Booked.\n(Plan accepted: Zanzibar visit.)"]);

    expect(await later(c, "Use Mombasa instead.")).toEqual(["Corrected."]);
    expect(await sql(c, "SELECT text FROM turn WHERE role = 'note'")).toEqual([]);
    expect(await holding(c.agent, WRONG)).toEqual([]);
    expect(await sql(c, "SELECT title FROM task")).toEqual([{ title: "Mombasa visit" }]);
  });

  test("an outside write that mentions the wrong words is deleted with its approval, since its arguments can't change", async () => {
    const model = scripted([
      turn({ actions: [{ type: "remember", note: `Sister ${WRONG} lives in Hat Yai.` }, send("Noted.")] }),
      turn({ actions: [correct(WRONG, RIGHT), send("Fixed.")] }),
    ]);
    const c = await devChat("correct-outside", { model, at: "2099-11-04T10:00" });
    await later(c, `My sister ${WRONG} lives in Hat Yai.`);
    await runInDurableObject<Agent, void>(stubOf(c.agent), (_a, state) => {
      const store = new AgentStore(state.storage);
      const now = c.clock.now();
      for (const [intent, body] of [["mentions", `Hi ${WRONG}`], ["unrelated", "Hi there"]]) {
        const d = prepareOutsideWrite({ intent, provider: "mail", action: "send", args: { body }, epoch: store.forget().epoch, now, approval: { owner: c.agent, expiresAt: (now + 60_000) as EpochMs } });
        if (!d) throw new Error("no draft");
        expect(store.putOutsideWrite(d.write, d.approval).kind).toBe("created");
      }
    });

    expect(await later(c, `It's ${RIGHT}.`)).toEqual(["Fixed."]);
    expect(await holding(c.agent, WRONG)).toEqual([]);
    expect(await sql(c, "SELECT intent FROM outside_write")).toEqual([{ intent: "unrelated" }]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM outside_approval")).toEqual([{ n: 1 }]);
  });
});

describe("don't remember", () => {
  test("migration matches a private reply to its turn even when their write times differ", async () => {
    const script = scripted([turn({ actions: [dontRemember(), send("Got it.")] })]);
    let advance = () => {};
    const model = { ...script, send(req: Parameters<typeof script.send>[0]) {
      advance();
      return script.send(req);
    } };
    const c = await devChat("unsaved-legacy-delivery", {
      model, at: "2099-11-04T10:00", channel: "telegram",
    });
    advance = () => c.clock.set((c.clock.now() + 10) as EpochMs);
    expect(await later(c, "Don't remember this: " + SECRET)).toEqual(["Got it."]);

    await runInDurableObject(stubOf(c.agent), (_, { storage }) => {
      const { sql } = storage;
      expect(sql.exec("SELECT o.created_at - t.at AS delay FROM outbox o JOIN turn t USING (event_key) WHERE t.role = 'agent'").one())
        .toEqual({ delay: 10 });
      rewindQuoteRewrites(sql);
      const beforeBackfill = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN quote_rewrites_before"));
      sql.exec("UPDATE meta SET v = ? WHERE k = 'schema_version'", String(beforeBackfill));
      migrate(storage);
      expect(sql.exec("SELECT transient FROM outbox").one()).toEqual({ transient: 1 });
    });
  });

  test("does not retain a digest of the private message or reply", async () => {
    const text = "Don't remember this: " + SECRET;
    const reply = "Got it.";
    const c = await devChat("unsaved-no-digest", {
      model: scripted([turn({ actions: [dontRemember(), send(reply)] })]),
      at: "2099-11-04T10:00",
      channel: "telegram",
    });
    expect(await later(c, text)).toEqual([reply]);
    for (const value of [text, reply]) {
      expect(await holding(c.agent, createHash("sha256").update(value).digest("hex"))).toEqual([]);
    }
  });

  test("upgrading stored fingerprints is atomic and removes the private digest", async () => {
    const c = await devChat("unsaved-legacy-digest", { model: scripted([]), at: "2099-11-04T10:00" });
    const digest = createHash("sha256").update(SECRET).digest("hex");
    await runInDurableObject(stubOf(c.agent), (_, { storage }) => {
      const { sql } = storage;
      rewindQuoteRewrites(sql);
      const previous = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN quote_rewrites_before"));
      sql.exec(MIGRATIONS[previous]);
      sql.exec("INSERT INTO quote_rewrite (digest) VALUES (?)", digest);
      sql.exec("UPDATE meta SET v = ? WHERE k = 'schema_version'", String(previous + 1));
      sql.exec(`CREATE TRIGGER fail_version BEFORE UPDATE ON meta
        WHEN NEW.k = 'schema_version' BEGIN SELECT RAISE(ABORT, 'checkpoint write failed'); END`);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => migrate(storage)).toThrow("checkpoint write failed");
        expect(sql.exec("SELECT digest FROM quote_rewrite").toArray()).toEqual([{ digest }]);
        expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'private_quote_window'").toArray()).toEqual([]);
      }
      sql.exec("DROP TRIGGER fail_version");
      migrate(storage);
      migrate(storage);
      expect(sql.exec("SELECT digest FROM quote_rewrite").toArray()).toEqual([]);
      expect(sql.exec("SELECT quote_rewrites_before AS at FROM forget").one()).toEqual({ at: expect.any(Number) });
    });
  });

  test("uses Telegram message ids to block private quotes even when their dates differ", async () => {
    const privateId = "81";
    const replyId = "82";
    const model = scripted([turn({ actions: [dontRemember(), send("Got it.")] }), chat("Okay."), chat("I see.")]);
    const c = await devChat("unsaved-telegram-ids", {
      model, at: "2099-11-04T10:00", channel: "telegram",
      deliveries: [{ kind: "sent", providerMessages: [{ id: replyId, position: 0 }] }],
    });
    const at = c.clock.now();
    const original = { kind: "message" as const, messageId: privateId, text: "Don't remember this: " + SECRET };
    await c.event(original);
    c.clock.set((at + 60_000) as EpochMs);
    for (const id of [privateId, replyId]) {
      const quote = { kind: "text" as const, id, at: (at + 10_000) as EpochMs, text: SECRET };
      await c.event({ kind: "message", text: "What about this?", quote });
    }
    expect(model.calls.slice(1).map((call) => call.user.split("## New")[1].includes(SECRET))).toEqual([false, false]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM inbox WHERE payload LIKE ?", "%" + SECRET + "%")).toEqual([{ n: 0 }]);
  });

  test.each(["after the reply", "while the reply is pending"] as const)(
    "keeps private Telegram edits %s out of history and the summary input",
    async (when) => {
      const pending = when === "while the reply is pending";
      const user = pending ? 10512 : 10511;
      const privateTurn = turn({ actions: [dontRemember(), send("Got it.")] });
      const model = scripted(
        [pending ? hold(privateTurn) : privateTurn, chat("Okay."), chat("Okay.")],
        { compaction: [{ kind: "output", value: { summary: "The person chats about the weather." } }] },
      );
      const c = await devChat(String(user), { model, at: "2099-11-04T10:00", channel: "telegram" });
      const original = { chat: { id: user, type: "private" }, message_id: 81, date: c.clock.now() / 1000 };
      const editedText = "The revised hint is " + SECRET;

      expect((await postTelegramUpdate({
        update_id: 1, message: { ...original, text: "Don't remember this: my hint is daisy." },
      })).status).toBe(200);
      try {
        if (pending) await expect.poll(() => model.calls.length).toBe(1);
        else await c.settle();
        c.clock.set(local("2099-11-04T10:01"));
        expect((await postTelegramUpdate({
          update_id: 2, edited_message: { ...original, edit_date: c.clock.now() / 1000, text: editedText },
        })).status).toBe(200);
      } finally {
        model.release();
      }
      await c.settle();
      expect.soft(await c.received()).toEqual(["Got it."]);
      expect.soft((await c.snapshot()).turns.map((t) => t.text).join("\n")).not.toContain(editedText);
      expect.soft(await sql(c, "SELECT payload FROM inbox WHERE payload LIKE ?", `%${SECRET}%`)).toEqual([]);

      await sql(c, `INSERT INTO turn (role, text, at, event_key)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60) SELECT 'person', 'weather chat ' || i, ?, 'dev:filler' FROM n`, c.clock.now());
      await c.alarm();

      const compaction = model.calls.find((call) => call.purpose === "compaction");
      expect(compaction?.user).toContain("weather chat 1");
      expect.soft(compaction?.user).not.toContain(editedText);
      expect(await sql(c, "SELECT summary FROM memory")).toEqual([{ summary: "The person chats about the weather." }]);

      const ordinaryEdit = "Actually, expect rain.";
      expect((await postTelegramUpdate({
        update_id: 3, edited_message: { ...original, message_id: 82, edit_date: c.clock.now() / 1000, text: ordinaryEdit },
      })).status).toBe(200);
      await c.settle();
      expect(model.calls.at(-1)?.user).toContain(ordinaryEdit);
      expect((await c.snapshot()).turns.some((t) => t.text.includes(ordinaryEdit))).toBe(true);
    },
  );

  test("clears the quote on a transient turn and drops a later quote of that message", async () => {
    const model = scripted([turn({ actions: [dontRemember(), send("Got it.")] }), chat("I see.")]);
    const c = await devChat("unsaved-telegram-quote", { model, at: "2099-11-04T10:00", channel: "telegram" });
    const text = "Don't remember this: " + SECRET;
    const at = c.clock.now();
    await c.event({ kind: "message", text, quote: { kind: "text", at: local("2099-11-04T09:59"), text: "An earlier note" } });
    expect(model.calls[0].user).toContain('context, not a request): "An earlier note"');
    expect(await sql(c, "SELECT payload FROM inbox WHERE kind = 'message'")).toEqual([{ payload: "{}" }]);

    c.clock.set((at + 60_000) as EpochMs);
    await c.event({ kind: "message", text: "About that message", quote: { kind: "text", at, text: SECRET } });

    expect(model.calls[1].user.split("## New")[1]).not.toContain(SECRET);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM inbox WHERE payload LIKE ?", "%" + SECRET + "%")).toEqual([{ n: 0 }]);
  });

  test("a LINE reply to the assistant's transient response has no quote", async () => {
    const id = "461230966842064897";
    const model = scripted([turn({ actions: [dontRemember(), send("Got it, " + SECRET + ".")] }), chat("I see.")]);
    const c = await devChat("unsaved-line-quote", {
      model, at: "2099-11-04T10:00", channel: "line",
      deliveries: [{ kind: "sent", providerMessages: [{ id, position: 0 }] }],
    });
    expect(await later(c, "Don't remember this: " + SECRET)).toEqual(["Got it, " + SECRET + "."]);

    await c.event({ kind: "message", text: "About that message", quote: { kind: "reference", id } });

    expect(model.calls[1].user.split("## New")[1]).not.toContain(SECRET);
    expect(await sql(c, "SELECT id FROM line_message WHERE id = ?", id)).toEqual([]);
  });

  test("clears the completed message payload and still deduplicates the same event", async () => {
    const c = await devChat("unsaved-inbox", {
      model: scripted([turn({ actions: [dontRemember(), send("Got it.")] })]),
      at: "2099-11-04T10:00",
    });
    const text = "Don't remember this: my PIN hint is " + SECRET + ".";
    const event = { id: "unsaved-message" };
    await c.say(text, event);
    expect(await c.received()).toEqual(["Got it."]);
    expect(await sql(c, "SELECT status, payload FROM inbox WHERE kind = 'message'")).toEqual([{ status: "done", payload: "{}" }]);

    await c.say(text, event);
    expect(await c.received()).toEqual([]);
    expect(await sql(c, "SELECT status, payload FROM inbox WHERE kind = 'message'")).toEqual([{ status: "done", payload: "{}" }]);
  });

  test("a turn the model flags saves no note, no wake-up or task of its own, and its words never reach the summary", async () => {
    const model = scripted(
      [
        turn({
          actions: [
            dontRemember(),
            { type: "remember", note: `PIN hint: the cat ${SECRET}.` },
            schedule("pin-check", "2099-11-06T09:00", `Ask if the ${SECRET} PIN hint worked`, false),
            send("Got it, I won't keep that."),
          ],
          tasks: [propose("pin-change", `Change the ${SECRET} PIN`, PLAN)],
        }),
      ],
      { compaction: [{ kind: "output", value: { summary: "The person chats about the weather." } }] },
    );
    const c = await devChat("unsaved-turn", { model, at: "2099-11-04T10:00" });

    expect(await later(c, `Don't remember this, but my PIN hint is my cat ${SECRET}.`)).toEqual(["Got it, I won't keep that."]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM memory_note")).toEqual([{ n: 0 }]);
    expect(await sql(c, "SELECT key FROM wakeup WHERE kind = 'reminder'")).toEqual([]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM task")).toEqual([{ n: 0 }]);

    await sql(c, `INSERT INTO turn (role, text, at, event_key)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60) SELECT 'person', 'weather chat ' || i, ?, 'dev:filler' FROM n`, c.clock.now());
    await c.alarm();

    const compaction = model.calls.find((call) => call.purpose === "compaction");
    expect(compaction?.user).toContain("weather chat 1");
    expect(compaction?.user.toLowerCase()).not.toContain(SECRET);
    expect(await sql(c, "SELECT summary FROM memory")).toEqual([{ summary: "The person chats about the weather." }]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM turn WHERE text LIKE ?", `%${SECRET}%`)).toEqual([{ n: 0 }]);
  });

  test("a wake-up the assistant moves in that turn stays where it was, since the move would save a new one", async () => {
    const model = scripted([
      turn({ actions: [schedule("follow-up", "2099-11-06T09:00", "Ask how the week went", false), send("Talk soon.")] }),
      turn({ actions: [dontRemember(), cancel("follow-up"), schedule("follow-up", "2099-11-07T09:00", `Ask about the ${SECRET} PIN`, false), send("Got it.")] }),
    ]);
    const c = await devChat("unsaved-move", { model, at: "2099-11-04T10:00" });
    expect(await later(c, "Busy week ahead.")).toEqual(["Talk soon."]);
    expect(await later(c, `Don't remember this: my PIN hint is ${SECRET}.`)).toEqual(["Got it."]);
    expect(await sql(c, "SELECT key, note, due_at FROM wakeup WHERE kind = 'reminder' AND status = 'pending'")).toEqual([
      { key: "follow-up", note: "Ask how the week went", due_at: local("2099-11-06T09:00") },
    ]);
  });

  test("a reminder the person asks for in the same message is still set", async () => {
    const model = scripted([turn({ actions: [dontRemember(), schedule("bank", "2099-11-04T17:00", "Call the bank"), send("Set for 5.")] })]);
    const c = await devChat("unsaved-asked", { model, at: "2099-11-04T10:00" });
    expect(await later(c, "Don't save this, but remind me at 5 to call the bank about my card.")).toEqual(["Set for 5."]);
    expect(await sql(c, "SELECT key, origin FROM wakeup WHERE kind = 'reminder'")).toEqual([{ key: "bank", origin: "person" }]);
  });

  test("through the box, the turn saves no note, and once compaction drops it the box starts a session without it", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("unsaved-box", { model: scripted([]), at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await c.received();
    box.replies.push({ kind: "reply", step: turn({ actions: [dontRemember(), { type: "remember", note: `PIN hint: ${SECRET}.` }, send("I won't keep that.")] }) });

    expect(await later(c, `Don't remember this: my PIN hint is ${SECRET}.`)).toEqual(["I won't keep that."]);
    expect(box.parses.at(-1)?.agent?.tools).toContain("dont_remember");
    expect(await sql(c, "SELECT COUNT(*) AS n FROM memory_note")).toEqual([{ n: 0 }]);
    expect(await sql(c, "SELECT COUNT(*) AS n FROM box_session WHERE id IS NOT NULL")).toEqual([{ n: 1 }]);

    await sql(c, `INSERT INTO turn (role, text, at, event_key)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60) SELECT 'person', 'weather chat ' || i, ?, 'dev:filler' FROM n`, c.clock.now());
    box.replies.push({ kind: "reply", step: { kind: "output", value: { summary: "The person chats about the weather." } } });
    await c.alarm();
    const folded = box.parses.at(-1);
    expect(folded?.agent).toBeNull();
    expect(folded?.user.toLowerCase()).not.toContain(SECRET);

    box.replies.push({ kind: "reply", step: chat("Hello.") });
    expect(await later(c, "hello")).toEqual(["Hello."]);
    const next = box.parses.at(-1);
    expect(next?.agent?.session).toBeNull();
    expect(next?.user.toLowerCase()).not.toContain(SECRET);
  });
});
