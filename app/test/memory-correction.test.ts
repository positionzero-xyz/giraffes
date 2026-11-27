import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { prepareOutsideWrite } from "../src/action/writes";
import type { Agent } from "../src/agent/agent";
import { AgentStore } from "../src/agent/store";
import type { AgentKey, EpochMs } from "../src/domain";
import type { ScriptStep } from "../src/model/scripted";
import { cancel, chat, devChat, fakeBox, holding, local, propose, schedule, scripted, send, turn, type DevChat } from "./testkit";

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
    expect(await later(c, "Actually that's not right.")).toEqual(["Okay."]);
    await c.advanceTo("2099-11-04T12:01");
    expect(await c.received()).toEqual(["Tea time."]);

    expect(await sql(c, "SELECT text FROM memory_note")).toEqual([{ text: `Sister ${WRONG} lives in a flat in Hat Yai.` }]);
    expect(await holding(c.agent, RIGHT)).toEqual([]);
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
