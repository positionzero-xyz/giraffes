import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { COMPACTION } from "../src/agent/compaction";
import { AGENT_SYSTEM, COMPACTION_SYSTEM } from "../src/agent/prompt";
import { TURN } from "../src/agent/turn";
import { routeFor } from "../src/model/routes";
import { bytesOf } from "../src/model/prompt";
import type { AgentKey } from "../src/domain";
import { NOTICES } from "../src/notices";
import { chat, devChat, fakeBox, fakeProvider, giveKey, local, propose, scripted, send, turn, type FakeBox } from "./testkit";

const NOTICE = NOTICES.en;
const UNSEEN = "## Conversation you haven't seen";
const MEMORY_UPDATE = "## Memory (replaces the memory you had)";
const remember = (note: string) => ({ type: "remember", note });
const keyReply = (text: string, actions: unknown[] = []) => ({ kind: "output" as const, value: { actions: [...actions, { type: "send", text }], tasks: [], about: "" } });

async function boxChat(user: string, opts: { readonly keyReplies?: Parameters<typeof fakeProvider>[0]; readonly backup?: boolean } = {}) {
  const box = fakeBox({ signedIn: true });
  const provider = fakeProvider(opts.keyReplies ?? []);
  const c = await devChat(user, { model: scripted([]), provider, at: "2099-11-04T10:00", box: box.deps });
  await c.say("/claude");
  if (opts.backup) await giveKey(c.agent, { backup: true });
  await c.received();
  return { box, provider, c };
}

const lastBox = (box: FakeBox) => {
  const p = box.parses.at(-1);
  if (!p?.agent) throw new Error("no box turn yet");
  return { user: p.user, ...p.agent };
};

describe("the Durable Object is the one record of the chat for the box session", () => {
  test("a turn the backup key answered reaches the box session on its next turn", async () => {
    const { box, c } = await boxChat("rec", { keyReplies: [keyReply("From your key.")], backup: true });
    box.replies.push({ kind: "reply", step: chat("Hi from your box.") });
    await c.say("hello");
    expect(await c.received()).toEqual(["Hi from your box."]);

    box.replies.push({ kind: "status", status: 503 });
    await c.say("what's on Friday?");
    expect(await c.received()).toEqual(["From your key."]);

    c.clock.set(local("2099-11-04T10:10"));
    box.replies.push({ kind: "reply", step: chat("Back on your box.") });
    await c.say("thanks");
    expect(await c.received()).toEqual(["Back on your box."]);

    const last = box.parses.at(-1)?.user ?? "";
    expect(last).toContain("Person: what's on Friday?");
    expect(last).toContain("You: From your key.");
    expect(last).not.toContain("Hi from your box.");
  });

  test("a key connected while the box is answering reaches the next resumed turn", async () => {
    const box = fakeBox({ signedIn: true });
    let connectKey: (() => void) | undefined;
    const client = {
      ...box.deps.client,
      agent: (...args: Parameters<typeof box.deps.client.agent>) => {
        const write = connectKey;
        connectKey = undefined;
        write?.();
        return box.deps.client.agent(...args);
      },
    };
    const c = await devChat("side-key", { model: scripted([]), at: "2099-11-04T10:00", box: { ...box.deps, client } });
    await c.say("/claude");
    await c.received();
    box.replies.push({ kind: "reply", step: chat("Initial reply.") });
    await c.say("hello");
    const connected = NOTICE.keyConnected("OpenCode Go", "claude-haiku-5-5");
    const offer = NOTICE.backupAsk("OpenCode Go");
    const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
    await runInDurableObject(stub, (_agent, state) => {
      connectKey = () => {
        for (const notice of [connected, offer]) {
          state.storage.sql.exec("INSERT INTO turn (role, text, at, event_key) VALUES ('note', ?, ?, 'key-connect')", notice, c.clock.now());
        }
      };
    });
    box.replies.push({ kind: "reply", step: chat("Reply in flight.") }, { kind: "reply", step: chat("Follow-up reply.") });
    await c.say("question in flight");
    expect(lastBox(box).user).not.toContain(connected);
    const { turns } = await c.snapshot();
    expect(turns.slice(-4).map((row) => row.text)).toEqual([connected, offer, "question in flight", "Reply in flight."]);
    await c.say("follow-up question");

    const next = lastBox(box);
    expect(next.resumed).toBe(true);
    expect(next.user).toContain("Person: follow-up question");
    expect(next.user).toContain(connected);
    expect(next.user).toContain(offer);
    expect(next.user).not.toContain("Reply in flight.");
    expect(next.user).not.toContain("Person: question in flight");
  });

  test("a plan the session proposed isn't sent back to it as conversation it hasn't seen", async () => {
    const { box, c } = await boxChat("plan");
    const plan = "Fri 18:30 overnight train from Bangkok\nSat Doi Suthep at 7 before the heat, Nimman cafes after\nSun 16:00 flight back";
    box.replies.push({ kind: "reply", step: turn({ actions: [send("Here is a trip plan.")], tasks: [propose("chiang-mai-trip", "Chiang Mai long weekend", plan)] }) });
    await c.say("plan me a Chiang Mai weekend");
    await c.received();
    expect((await c.snapshot()).turns.map((row) => row.text)).toContain(plan);

    box.replies.push({ kind: "reply", step: chat("Sure.") });
    await c.say("looks good");
    const next = lastBox(box);
    expect(next.resumed).toBe(true);
    expect(next.user).not.toContain(UNSEEN);
    expect(next.user).not.toContain("overnight train");
  });

  test("the next resumed turn gets the reminder correction without repeating the box reply", async () => {
    const { box, c } = await boxChat("correction");
    box.replies.push({
      kind: "reply",
      step: chat("I set the clinic reminder."),
      refusedCalls: [{ name: "schedule_wakeup", input: { key: "clinic", asked: true }, problems: ["missing at"] }],
    });
    await c.say("Remind me to call the clinic");
    expect(await c.received()).toEqual([`I set the clinic reminder.\n${NOTICE.reminderNotSet}`]);

    box.replies.push({ kind: "reply", step: chat("Let me check.") });
    await c.say("Was the reminder set?");
    const next = lastBox(box);
    expect(next.resumed).toBe(true);
    expect(next.user).toContain(NOTICE.reminderNotSet);
    expect(next.user).not.toContain("I set the clinic reminder.");
  });

  test("a box turn that is unavailable, or answers with a refusal, leaves the mark, so the next one that works carries every turn it missed", async () => {
    const { box, c } = await boxChat("flk");
    box.replies.push({ kind: "reply", step: chat("Hi.") });
    await c.say("hello");
    expect(await c.received()).toEqual(["Hi."]);
    const [session] = box.sessions;

    box.replies.push({ kind: "status", status: 503 });
    await c.say("lost one");
    await c.advanceTo("2099-11-04T10:04");
    expect(await c.received()).toEqual([NOTICE.failed]);

    c.clock.set(local("2099-11-04T10:10"));
    box.replies.push({ kind: "refusal" });
    await c.say("lost two");
    expect(c.logs("turn").at(-1)?.outcome).toBe("model_failed");

    c.clock.set(local("2099-11-04T10:20"));
    box.replies.push({ kind: "reply", step: chat("Back.") });
    await c.say("here again");
    expect((await c.received()).at(-1)).toBe("Back.");

    expect(c.logs("model_call").map((r) => [r.backend, r.status])).toEqual([
      ["box", "settled"],
      ["box", "unavailable"],
      ["box", "settled"],
      ["box", "settled"],
    ]);
    const last = lastBox(box);
    expect(last.resumed).toBe(true);
    expect(last.session).toBe(session);
    expect(last.user).toContain("Person: lost one");
    expect(last.user).toContain("Person: lost two");
    expect(last.user).not.toContain("Person: hello");
    expect(last.user).not.toContain("You: Hi.");
  });

  test("a new box starts its session with the conversation the DO already holds, as the key lane saw it", async () => {
    const box = fakeBox({ signedIn: true });
    const provider = fakeProvider([keyReply("From your key.", [remember("Lives in Chiang Mai.")])]);
    const c = await devChat("nbx", { model: scripted([]), provider, at: "2099-11-04T10:00", box: box.deps });
    await giveKey(c.agent);
    await c.say("hi, I live in Chiang Mai");
    expect(await c.received()).toEqual(["From your key."]);

    await c.say("/claude");
    await c.received();
    box.replies.push({ kind: "reply", step: chat("Hello from your box.") });
    await c.say("now on my plan");
    expect(await c.received()).toEqual(["Hello from your box."]);

    const first = lastBox(box);
    expect(first.session).toBeNull();
    expect(first.resumed).toBe(false);
    expect(first.user).toContain(UNSEEN);
    expect(first.user).toContain("Person: hi, I live in Chiang Mai");
    expect(first.user).toContain("You: From your key.");
    expect(first.user).toContain("Person: now on my plan");
    expect(first.append).toBe(`${AGENT_SYSTEM}\n\n## Memory\n- Lives in Chiang Mai.`);
    expect(first.user).not.toContain("Memory");
    expect(provider.seen.filter((s) => (s.body.messages as { content: string }[])[0].content !== COMPACTION_SYSTEM)).toHaveLength(1);
  });

  test("a session the box lost is started again with the recent turns, and the one after resumes it with only what is new", async () => {
    const { box, c } = await boxChat("lst");
    box.replies.push({ kind: "reply", step: chat("One.") });
    await c.say("first");
    box.replies.push({ kind: "reply", step: chat("Two.") });
    await c.say("second");
    expect(await c.received()).toEqual(["One.", "Two."]);
    const before = lastBox(box).session;
    expect(lastBox(box).resumed).toBe(true);

    box.sessions.clear();
    box.replies.push({ kind: "reply", step: chat("Three.") });
    await c.say("third");
    expect(await c.received()).toEqual(["Three."]);
    const restarted = lastBox(box);
    expect(restarted.session).toBe(before);
    expect(restarted.resumed).toBe(false);
    for (const line of ["Person: first", "You: One.", "Person: second", "You: Two.", "Person: third"]) expect(restarted.user).toContain(line);

    box.replies.push({ kind: "reply", step: chat("Four.") });
    await c.say("fourth");
    const next = lastBox(box);
    expect(next.resumed).toBe(true);
    expect(next.session).not.toBe(before);
    expect(next.user).not.toContain(UNSEEN);
    expect(next.user).toContain("Person: fourth");
  });

  test("with no memory there is no memory block in the system prompt and no memory heading in the message", async () => {
    const { box, c } = await boxChat("nom");
    box.replies.push({ kind: "reply", step: chat("Hi.") });
    await c.say("hello");
    box.replies.push({ kind: "reply", step: chat("Again.") });
    await c.say("again");
    expect(await c.received()).toEqual(["Hi.", "Again."]);
    for (const p of box.parses) {
      expect(p.agent?.append).toBe(AGENT_SYSTEM);
      expect(p.user).not.toContain("Memory");
      expect(p.agent?.fresh).not.toContain("Memory");
    }
  });

  test("a memory change the session didn't make reaches the resumed session once, in its next message, and the system prompt for a new one carries it", async () => {
    const { box, c } = await boxChat("mem", { keyReplies: [keyReply("Noted, durian.", [remember("Loves durian.")])], backup: true });
    box.replies.push({ kind: "reply", step: turn({ actions: [remember("Allergic to peanuts."), send("Got it.")] }) });
    await c.say("I'm allergic to peanuts");
    box.replies.push({ kind: "reply", step: chat("Hi.") });
    await c.say("hi");
    expect(await c.received()).toEqual(["Got it.", "Hi."]);
    expect(lastBox(box).user).not.toContain(MEMORY_UPDATE);
    expect(lastBox(box).append).toContain("- Allergic to peanuts.");

    box.replies.push({ kind: "status", status: 503 });
    await c.say("I love durian");
    expect(await c.received()).toEqual(["Noted, durian."]);

    c.clock.set(local("2099-11-04T10:10"));
    box.replies.push({ kind: "reply", step: chat("Yum.") });
    await c.say("what do I like?");
    const changed = lastBox(box);
    expect(changed.resumed).toBe(true);
    expect(changed.user).toContain(`${MEMORY_UPDATE}\n- Allergic to peanuts.\n- Loves durian.`);
    expect(changed.append).toBe(`${AGENT_SYSTEM}\n\n## Memory\n- Allergic to peanuts.\n- Loves durian.`);
    expect(changed.fresh).not.toContain("Memory");

    box.replies.push({ kind: "reply", step: chat("Sure.") });
    await c.say("ok");
    expect(lastBox(box).user).not.toContain(MEMORY_UPDATE);
  });

  test("memory at its caps that changes under a resumed session still fits the box route, though it travels in the system prompt and the message", async () => {
    const { box, c } = await boxChat("cap");
    box.replies.push({ kind: "reply", step: chat("Hi.") });
    await c.say("hello");
    const summary = "ส".repeat(COMPACTION.maxSummaryBytes / 3);
    const note = (i: number) => `${String(i).padStart(2, "0")} ${"ข".repeat((TURN.maxNoteBytes - 3) / 3)}`;
    await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(c.agent)), (_a, state) => {
      state.storage.sql.exec("UPDATE memory SET summary = ?", summary);
      for (let i = 0; i < COMPACTION.maxNotes; i++) state.storage.sql.exec("INSERT INTO memory_note (text, created_at, event_key) VALUES (?, 0, 'test')", note(i));
    });

    box.replies.push({ kind: "reply", step: chat("Still here.") });
    await c.say("are you there?");
    expect(await c.received()).toEqual(["Hi.", "Still here."]);

    const resumed = lastBox(box);
    expect(resumed.resumed).toBe(true);
    expect(resumed.user).toContain(`${MEMORY_UPDATE}\n${summary}\n- ${note(0)}`);
    expect(resumed.append).toContain(`- ${note(COMPACTION.maxNotes - 1)}`);
    expect(bytesOf(resumed.append)).toBeGreaterThan(COMPACTION.maxSummaryBytes + COMPACTION.maxNotes * TURN.maxNoteBytes);
    expect(bytesOf(resumed.append) + bytesOf(resumed.user)).toBeLessThanOrEqual(routeFor({ kind: "box", provider: "claude" }, "turn").promptBytes);
  });

  test("a backfill bigger than the box route drops its oldest turns, says so in the turn log, and still marks the newest turn it sent as seen", async () => {
    const say = (i: number) => `${i} ${"ก".repeat(1_200)}`;
    const keyTurns = 24;
    const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      if (body.messages[0].content === COMPACTION_SYSTEM) return Response.json({ error: "down" }, { status: 500 });
      const value = { actions: [send("From your key.")], tasks: [], about: "" };
      return Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
    };
    const box = fakeBox({ signedIn: true });
    const c = await devChat("big", { model: scripted([]), provider: fetch, at: "2099-11-04T10:00", box: box.deps });
    await c.say("/claude");
    await giveKey(c.agent, { backup: true });
    await c.received();
    box.replies.push({ kind: "reply", step: chat("Hi.") });
    await c.say("hello");

    box.replies.push({ kind: "status", status: 503 });
    for (let i = 0; i < keyTurns; i++) await c.say(say(i));
    c.clock.set(local("2099-11-04T10:10"));
    box.replies.push({ kind: "refusal" }, { kind: "reply", step: chat("Caught up.") });
    await c.say("back on my box");
    expect(await c.received()).toContain("Caught up.");
    expect(box.parses.slice(-2).map((p) => (p.agent ? "agent" : "compaction"))).toEqual(["compaction", "agent"]);

    const caught = lastBox(box);
    const budget = routeFor({ kind: "box", provider: "claude" }, "turn").promptBytes;
    expect(caught.resumed).toBe(true);
    expect(bytesOf(caught.append) + bytesOf(caught.user)).toBeLessThanOrEqual(budget);
    expect(caught.user).toMatch(/\(\d+ earlier lines left out\)/);
    expect(caught.user).toContain(`Person: ${say(keyTurns - 1)}`);
    expect(caught.user).not.toContain(`Person: ${say(0)}`);
    expect(caught.user).toContain("Person: back on my box");
    expect(c.logs("turn").at(-1)?.historyTrimmed).toBe(true);

    box.replies.push({ kind: "reply", step: chat("Fine.") });
    await c.say("next");
    expect(await c.received()).toEqual(["Fine."]);
    expect(lastBox(box).user).not.toContain(UNSEEN);
    expect(c.logs("turn").at(-1)?.historyTrimmed).toBe(false);
  });

  test("a group turn its owner's box serves runs in a session of its own and leaves the owner's session record alone", async () => {
    const { box, c } = await boxChat("own");
    box.replies.push({ kind: "reply", step: chat("Hi.") });
    await c.say("hello");
    const [mine] = box.sessions;
    const owner = env.AGENT.get(env.AGENT.idFromName(c.agent));
    const group = "g:telegram:-100123" as AgentKey;
    await owner.recordGroup(group, 1);

    box.replies.push({ kind: "reply", step: chat("For the group.") });
    const prompt = { sections: [{ title: "New", keep: ["Person: hi from the group"], trim: [], dropRank: 0 }] };
    expect(await owner.serve({ group, ownershipVersion: 1, purpose: "turn", system: "s", prompt })).toMatchObject({ kind: "ok", call: { lane: "box" } });
    expect(lastBox(box)).toMatchObject({ session: null, resumed: false, append: AGENT_SYSTEM, user: "## New\nPerson: hi from the group" });

    box.replies.push({ kind: "reply", step: chat("Hi again.") });
    await c.say("me again");
    expect(lastBox(box)).toMatchObject({ session: mine, resumed: true });
    expect(lastBox(box).user).not.toContain("hi from the group");
  });

  test("an old box that ignores the session fields and reports none gets the recent turns once, then only what it hasn't seen", async () => {
    const { box, c } = await boxChat("old", { keyReplies: [keyReply("From your key.")], backup: true });
    box.ignoresSession = true;
    box.replies.push({ kind: "reply", step: chat("One.") });
    await c.say("first");
    box.replies.push({ kind: "reply", step: chat("Two.") });
    await c.say("second");
    expect(await c.received()).toEqual(["One.", "Two."]);
    expect(box.parses.map((p) => p.agent?.session)).toEqual([null, null]);
    expect(box.parses[1].user).not.toContain("Person: first");
    expect(box.parses[1].user).not.toContain(UNSEEN);

    box.replies.push({ kind: "status", status: 503 });
    await c.say("third");
    expect(await c.received()).toEqual(["From your key."]);
    c.clock.set(local("2099-11-04T10:10"));
    box.replies.push({ kind: "reply", step: chat("Four.") });
    await c.say("fourth");
    const old = lastBox(box);
    expect(old.user).toContain("Person: third");
    expect(old.user).toContain("You: From your key.");
    expect(old.user).not.toContain("Person: second");

    box.ignoresSession = false;
    box.replies.push({ kind: "reply", step: chat("Five.") });
    await c.say("fifth");
    const upgraded = lastBox(box);
    expect(upgraded.session).toBeNull();
    expect(upgraded.resumed).toBe(false);
    for (const line of ["Person: first", "You: One.", "Person: third", "You: Four.", "Person: fifth"]) expect(upgraded.user).toContain(line);
  });
});
