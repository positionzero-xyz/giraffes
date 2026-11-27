import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createBox } from "../src/server.ts";
import { startMock, type RunningMock } from "./mock.ts";

// BOX_TEST_CLI points at the Linux CLI inside the box image; the default is the sibling npm install.
const CLI = process.env.BOX_TEST_CLI ?? fileURLToPath(new URL("../node_modules/@anthropic-ai/claude-code/bin/claude.exe", import.meta.url));
const TOKEN = "b-agent-test-token-0123456789abcdefghijklmnop";
const APPEND = "You are Giraffe, a personal assistant.";
const GONE = "11111111-2222-3333-4444-555555555555";
const OWNER_A = "a".repeat(32);
const OWNER_B = "b".repeat(32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const dir = mkdtempSync(join(tmpdir(), "box-agent-"));
const script = join(dir, "script.json");
const mockLog = join(dir, "mock.log");
const dumps = join(dir, "dumps");

const SCHEDULE = {
  name: "schedule_wakeup",
  description: "Schedule a wake-up.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" }, at: { type: "string" }, note: { type: "string" }, asked: { type: "boolean" }, task: { type: "string" }, repeat: { anyOf: [{ type: "string", enum: ["daily", "weekdays", "weekly"] }, { type: "null" }] } },
    required: ["key", "at", "note", "asked", "task"],
  },
};
const REMEMBER = { name: "remember", description: "Remember a fact.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } };
const TASK = {
  name: "task",
  description: "Open a task, propose its plan, or close it.",
  inputSchema: {
    type: "object",
    properties: { op: { enum: ["open", "propose", "close"] }, ref: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$" }, kind: { type: "string" }, title: { type: "string" }, plan: { type: "string" } },
    required: ["op", "ref", "kind", "title", "plan"],
  },
};

type Turn = { readonly turn: string; readonly session?: string | null; readonly fresh?: string | null; readonly append?: string };
const turnBody = (t: Turn) => ({ model: "claude-haiku-5-5", append: t.append ?? APPEND, session: t.session ?? null, turn: t.turn, fresh: t.fresh ?? null, tools: [SCHEDULE, REMEMBER] });

type Sent = { readonly system: string; readonly messages: readonly { role: string; content: unknown }[] };
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";
function sent(): Sent[] {
  return readdirSync(dumps)
    .map((f) => ({ n: Number(f.match(/-(\d+)\.json$/)?.[1]), body: JSON.parse(readFileSync(join(dumps, f), "utf8") || "{}") }))
    .sort((a, b) => a.n - b.n)
    .map((d) => d.body)
    .filter((b) => Array.isArray(b.tools) && b.tools.some((t: { name: string }) => t.name.startsWith("mcp__giraffe__")))
    .map((b) => ({ system: textOf(b.system), messages: b.messages }));
}
const userTexts = (s: Sent): string[] => s.messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).filter((t) => t.trim());

let mock: RunningMock | undefined;
let base = "";
const stateDir = join(dir, "state");
mkdirSync(stateDir, { recursive: true });
const server = createBox({ token: TOKEN, cli: [CLI], sessionFile: join(dir, ".giraffe-session"), home: join(dir, "home"), configDir: join(dir, "config"), scratchDirs: [join(dir, "tmp")], stateFile: join(stateDir, "erase.json") });

async function postAgent(body: object, auth = `Bearer ${TOKEN}`, path = "agent"): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/${path}`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const agent = (t: Turn, auth?: string) => postAgent(turnBody(t), auth);

describe("an agent turn through the real Claude Code CLI", { skip: existsSync(CLI) ? false : "the pinned CLI is not installed (npm ci in box/)" }, () => {
  before(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC")) delete process.env[k];
    writeFileSync(script, JSON.stringify({ calls: [], text: "" }));
    mkdirSync(dumps);
    mock = await startMock(mockLog, dumps, script);
    Object.assign(process.env, { CLAUDE_CONFIG_DIR: join(dir, "config"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`, ANTHROPIC_API_KEY: "sk-ant-api03-mock-not-a-key" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    mock?.proc.kill();
  });

  it("keeps only the live transcript when the Worker rolls a chat session", async () => {
    const pendingPointer = join(dir, ".giraffe-session.next");
    writeFileSync(script, JSON.stringify({ calls: [], text: "Before the roll." }));
    mkdirSync(pendingPointer);
    const first = await agent({ turn: "New\nPerson: before the roll" }).finally(() => rmSync(pendingPointer, { recursive: true, force: true }));
    assert.equal(first.status, 200);
    assert.equal(transcriptExists(first.body.session.id), true);

    writeFileSync(script, JSON.stringify({ calls: [], text: "After the roll." }));
    const fresh = "Conversation\nPerson: before the roll\n\nNew\nPerson: after the roll";
    const rolled = await agent({ session: null, turn: "New\nPerson: after the roll", fresh });
    assert.equal(rolled.status, 200);
    assert.equal(rolled.body.session.resumed, false);
    assert.notEqual(rolled.body.session.id, first.body.session.id);
    assert.deepEqual(userTexts(sent().at(-1)!), [fresh]);
    const transcripts = readdirSync(join(dir, "config", "projects"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name);
    assert.deepEqual(transcripts, [`${rolled.body.session.id}.jsonl`]);
  });

  it("returns the reply text, the tool calls Giraffe's server accepted, in order, and the new session it started", async () => {
    writeFileSync(script, JSON.stringify({
      calls: [
        { name: "schedule_wakeup", input: { key: "call-clinic", at: "2026-11-27T09:00", note: "Call the clinic", asked: true, task: "" } },
        { name: "remember", input: { note: "Beam is allergic to peanuts." } },
      ],
      text: "Set for Friday at 9.",
    }));
    const r = await agent({ turn: "New\nPerson: remind me Friday 9 am to call the clinic" });
    assert.equal(r.status, 200);
    assert.equal(r.body.text, "Set for Friday at 9.");
    assert.deepEqual(r.body.calls, [
      { name: "schedule_wakeup", input: { key: "call-clinic", at: "2026-11-27T09:00", note: "Call the clinic", asked: true, task: "" } },
      { name: "remember", input: { note: "Beam is allergic to peanuts." } },
    ]);
    assert.equal(r.body.session.resumed, false);
    assert.match(r.body.session.id, UUID);
  });

  it("leaves out a call the tool server refused, so the model can fix it in the same turn", async () => {
    writeFileSync(script, JSON.stringify({
      calls: [
        { name: "schedule_wakeup", input: { key: "water", at: "2026-11-20T15:00" } },
        { name: "schedule_wakeup", input: { key: "water", at: "2026-11-20T15:00", note: "Drink water", asked: true, task: "" } },
      ],
      text: "Water at 3.",
    }));
    const r = await agent({ turn: "New\nPerson: remind me at 3 to drink water" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.calls, [{ name: "schedule_wakeup", input: { key: "water", at: "2026-11-20T15:00", note: "Drink water", asked: true, task: "" } }]);
  });

  it("returns refused tool calls with their original input and validation problems", async () => {
    const input = { key: "water", at: 15, asked: true, task: "" };
    writeFileSync(script, JSON.stringify({
      calls: [{ name: "schedule_wakeup", input }, { name: "remember", input: { note: "Prefers morning reminders." } }],
      text: "Water at 3.",
    }));
    const r = await agent({ turn: "New\nPerson: remind me at 3 to drink water" });
    assert.equal(r.status, 200);
    assert.equal(r.body.text, "Water at 3.");
    assert.deepEqual(r.body.refusedCalls, [{ name: "schedule_wakeup", input, problems: ["missing note", "at has the wrong type or value"] }]);
    assert.deepEqual(r.body.calls, [{ name: "remember", input: { note: "Prefers morning reminders." } }]);
  });

  it("refuses a bad task ref so the model can fix it in the same turn", async () => {
    const input = { op: "open", ref: "Bad ref", kind: "other", title: "Book a train", plan: "" };
    const corrected = { ...input, ref: "book-train" };
    writeFileSync(script, JSON.stringify({
      calls: [{ name: "task", input }, { name: "task", input: corrected }],
      text: "Noted.",
    }));
    const r = await postAgent({ ...turnBody({ turn: "New\nPerson: I need to book a train" }), tools: [TASK] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.calls, [{ name: "task", input: corrected }]);
    assert.deepEqual(r.body.refusedCalls, [{ name: "task", input, problems: ["ref has the wrong type or value"] }]);
  });

  it("resumes the session the Worker names, which keeps the system prompt it started with, so a memory change has to travel in the message", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "First." }));
    const first = await agent({ turn: "New\nPerson: first message", append: `${APPEND}\n\n## Memory\nLikes tea.` });
    writeFileSync(script, JSON.stringify({ calls: [], text: "Second." }));
    const r = await agent({ session: first.body.session.id, turn: "New\nPerson: second message", fresh: "FRESH\nPerson: second message", append: `${APPEND}\n\n## Memory\nLikes coffee now.` });
    assert.equal(r.body.text, "Second.");
    assert.deepEqual(r.body.session, { id: first.body.session.id, resumed: true });
    const last = sent().at(-1);
    assert.ok(last);
    assert.deepEqual(userTexts(last), ["New\nPerson: first message", "New\nPerson: second message"]);
    assert.match(last.system, /Likes tea\./);
    assert.doesNotMatch(last.system, /Likes coffee now\./);
  });

  it("starts a new session with the fresh message when the one the Worker names is gone, and says so", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Fresh." }));
    const r = await agent({ session: GONE, turn: "New\nPerson: hello again", fresh: "Conversation\nPerson: earlier\n\nNew\nPerson: hello again" });
    assert.equal(r.status, 200);
    assert.equal(r.body.text, "Fresh.");
    assert.equal(r.body.session.resumed, false);
    assert.notEqual(r.body.session.id, GONE);
    const last = sent().at(-1);
    assert.ok(last);
    assert.deepEqual(userTexts(last), ["Conversation\nPerson: earlier\n\nNew\nPerson: hello again"]);
  });

  it("uses the fresh message for a turn that names no session", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "New one." }));
    const r = await agent({ session: null, turn: "New\nPerson: hi", fresh: "Conversation\nPerson: before\n\nNew\nPerson: hi" });
    assert.equal(r.body.session.resumed, false);
    assert.deepEqual(userTexts(sent().at(-1)!), ["Conversation\nPerson: before\n\nNew\nPerson: hi"]);
  });

  it("keeps each person's rollback session on a shared box", async () => {
    for (const name of readdirSync(dir).filter((n) => n.startsWith(".giraffe-session"))) rmSync(join(dir, name), { force: true });
    const ownedTurn = (owner: string, text: string, session: string | null = null) => ({
      ...turnBody({ session, turn: `New\nPerson: ${text}`, fresh: `New\nPerson: ${text}` }),
      sessionOwner: owner,
    });

    writeFileSync(script, JSON.stringify({ calls: [], text: "First person." }));
    const firstA = await postAgent(ownedTurn(OWNER_A, "alpha one"));
    assert.equal(firstA.status, 200);
    assert.equal(firstA.body.session.resumed, false);

    writeFileSync(script, JSON.stringify({ calls: [], text: "Second person." }));
    const firstB = await postAgent(ownedTurn(OWNER_B, "beta one"));
    assert.equal(firstB.status, 200);
    assert.equal(firstB.body.session.resumed, false);
    assert.notEqual(firstB.body.session.id, firstA.body.session.id);
    assert.equal(transcriptExists(firstA.body.session.id), true);
    assert.equal(transcriptExists(firstB.body.session.id), true);
    assert.equal(readFileSync(join(dir, `.giraffe-session.${OWNER_A}`), "utf8"), firstA.body.session.id);
    assert.equal(readFileSync(join(dir, `.giraffe-session.${OWNER_B}`), "utf8"), firstB.body.session.id);

    writeFileSync(script, JSON.stringify({ calls: [], text: "First person again." }));
    const resumedA = await postAgent(ownedTurn(OWNER_A, "alpha two", firstA.body.session.id));
    assert.equal(resumedA.status, 200);
    assert.deepEqual(resumedA.body.session, { id: firstA.body.session.id, resumed: true });
    assert.deepEqual(userTexts(sent().at(-1)!), ["New\nPerson: alpha one", "New\nPerson: alpha two"]);
  });

  it("refuses a turn from an old Worker, which names no session, so a group's turn can't land in the person's session", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Named reply." }));
    const started = await agent({ session: null, turn: "New\nPerson: NAMED-ONE", fresh: "New\nPerson: NAMED-ONE" });
    const resumed = await agent({ session: started.body.session.id, turn: "New\nPerson: NAMED-TWO" });
    assert.equal(resumed.status, 200);
    const requests = sent().length;

    writeFileSync(script, JSON.stringify({ calls: [], text: "Group reply." }));
    const oldWorker = await postAgent({ model: "claude-haiku-5-5", append: APPEND, tools: [SCHEDULE, REMEMBER], turn: "New\nPerson: GROUP-MESSAGE" });

    assert.deepEqual(oldWorker, { status: 400, body: { error: "bad_request" } });
    assert.equal(sent().length, requests);
    assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), started.body.session.id);
    const next = await agent({ session: started.body.session.id, turn: "New\nPerson: NAMED-THREE" });
    assert.deepEqual(next.body.session, { id: started.body.session.id, resumed: true });
    assert.deepEqual(userTexts(sent().at(-1)!), ["New\nPerson: NAMED-ONE", "New\nPerson: NAMED-TWO", "New\nPerson: NAMED-THREE"]);
  });

  it("writes the rollback pointer on a fresh start and deletes the chat session it replaced", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "First fresh." }));
    const first = await agent({ session: null, turn: "New\nPerson: first fresh", fresh: "New\nPerson: first fresh" });
    assert.equal(first.status, 200);
    assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), first.body.session.id);
    assert.equal(transcriptExists(first.body.session.id), true);

    writeFileSync(script, JSON.stringify({ calls: [], text: "Second fresh." }));
    const second = await agent({ session: null, turn: "New\nPerson: second fresh", fresh: "New\nPerson: second fresh" });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.session.id, first.body.session.id);
    assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), second.body.session.id);
    assert.equal(transcriptExists(first.body.session.id), false);
    assert.equal(transcriptExists(second.body.session.id), true);
  });

  it("deletes a one-off session's transcript after the turn", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Once." }));
    const r = await postAgent({ ...turnBody({ session: null, turn: "New\nPerson: one-off", fresh: "New\nPerson: one-off" }), ephemeral: true });
    assert.equal(r.status, 200);
    assert.equal(transcriptExists(r.body.session.id), false);
  });

  it("keeps a one-off out of the rollback pointer and preserves the live personal session", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Personal fresh." }));
    const personal = await agent({ session: null, turn: "New\nPerson: personal fresh", fresh: "New\nPerson: personal fresh" });
    assert.equal(personal.status, 200);
    assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), personal.body.session.id);
    assert.equal(transcriptExists(personal.body.session.id), true);

    writeFileSync(script, JSON.stringify({ calls: [], text: "Group once." }));
    const once = await postAgent({ ...turnBody({ session: null, turn: "New\nPerson: group one-off", fresh: "New\nPerson: group one-off" }), ephemeral: true });
    assert.equal(once.status, 200);
    assert.notEqual(once.body.session.id, personal.body.session.id);
    assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), personal.body.session.id);
    assert.equal(transcriptExists(personal.body.session.id), true);
    assert.equal(transcriptExists(once.body.session.id), false);
  });

  it("runs a turn on the one-off route in a session nothing keeps, even when the body doesn't say so", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Personal." }));
    const personal = await agent({ session: null, turn: "New\nPerson: PERSONAL-ONE", fresh: "New\nPerson: PERSONAL-ONE" });
    assert.equal(personal.status, 200);

    writeFileSync(script, JSON.stringify({ calls: [], text: "For the group." }));
    const once = await postAgent(turnBody({ session: null, turn: "New\nPerson: GROUP-ONE", fresh: "New\nPerson: GROUP-ONE" }), `Bearer ${TOKEN}`, "agent/once");
    assert.equal(once.status, 200);
    assert.equal(once.body.text, "For the group.");
    assert.equal(once.body.session.resumed, false);
    assert.notEqual(once.body.session.id, personal.body.session.id);
    assert.equal(transcriptExists(once.body.session.id), false);
    assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), personal.body.session.id);
    assert.deepEqual(userTexts(sent().at(-1)!), ["New\nPerson: GROUP-ONE"]);

    writeFileSync(script, JSON.stringify({ calls: [], text: "Personal again." }));
    const next = await agent({ session: personal.body.session.id, turn: "New\nPerson: PERSONAL-TWO" });
    assert.deepEqual(next.body.session, { id: personal.body.session.id, resumed: true });
    assert.deepEqual(userTexts(sent().at(-1)!), ["New\nPerson: PERSONAL-ONE", "New\nPerson: PERSONAL-TWO"]);
  });

  it("refuses a one-off route turn that names a session or names none", async () => {
    const named = await postAgent(turnBody({ session: GONE, turn: "New\nPerson: hi" }), `Bearer ${TOKEN}`, "agent/once");
    assert.deepEqual(named, { status: 400, body: { error: "bad_request" } });
    const unnamed = await postAgent({ model: "claude-haiku-5-5", append: APPEND, tools: [SCHEDULE, REMEMBER], turn: "New\nPerson: hi" }, `Bearer ${TOKEN}`, "agent/once");
    assert.deepEqual(unnamed, { status: 400, body: { error: "bad_request" } });
  });

  it("repairs a failed rollback pointer write on a later named turn", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Old live." }));
    const first = await agent({ session: null, turn: "New\nPerson: old live", fresh: "New\nPerson: old live" });
    assert.equal(first.status, 200);
    assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), first.body.session.id);

    mkdirSync(join(dir, ".giraffe-session.next"));
    writeFileSync(script, JSON.stringify({ calls: [], text: "New live." }));
    const second = await agent({ session: null, turn: "New\nPerson: new live", fresh: "New\nPerson: new live" });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.session.id, first.body.session.id);
    assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), first.body.session.id);
    assert.equal(transcriptExists(first.body.session.id), false);
    assert.equal(transcriptExists(second.body.session.id), true);
    rmSync(join(dir, ".giraffe-session.next"), { recursive: true, force: true });

    writeFileSync(script, JSON.stringify({ calls: [], text: "Resumed new." }));
    const resumed = await agent({ session: second.body.session.id, turn: "New\nPerson: resume new", fresh: "New\nPerson: resume new" });
    assert.equal(resumed.status, 200);
    assert.deepEqual(resumed.body.session, { id: second.body.session.id, resumed: true });
    assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), second.body.session.id);
    assert.equal(transcriptExists(first.body.session.id), false);
    assert.equal(transcriptExists(second.body.session.id), true);
  });

  it("makes a superseded rollback session unavailable when its pointer write fails", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Original live." }));
    const first = await agent({ session: null, turn: "New\nPerson: original live", fresh: "New\nPerson: original live" });
    assert.equal(first.status, 200);
    assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), first.body.session.id);
    assert.equal(transcriptExists(first.body.session.id), true);

    mkdirSync(join(dir, ".giraffe-session.next"));
    try {
      writeFileSync(script, JSON.stringify({ calls: [], text: "Replacement live." }));
      const replacement = await agent({ session: null, turn: "New\nPerson: replacement live", fresh: "New\nPerson: replacement live" });
      assert.equal(replacement.status, 200);
      assert.notEqual(replacement.body.session.id, first.body.session.id);
      assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), first.body.session.id);
      assert.equal(transcriptExists(first.body.session.id), false);
    } finally {
      rmSync(join(dir, ".giraffe-session.next"), { recursive: true, force: true });
    }
  });

  it("fails a replacement turn when neither the pointer write nor transcript removal succeeds", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Original live." }));
    const first = await agent({ session: null, turn: "New\nPerson: original live" });
    assert.equal(first.status, 200);

    const pendingPointer = join(dir, ".giraffe-session.next");
    const blockedProject = join(dir, "config", "projects", "blocked-cleanup");
    mkdirSync(join(blockedProject, `${first.body.session.id}.jsonl`), { recursive: true });
    mkdirSync(pendingPointer);
    try {
      const replacement = await agent({ session: null, turn: "New\nPerson: replacement live" });
      assert.deepEqual(replacement, { status: 502, body: { error: "claude_failed" } });
      assert.equal(readFileSync(join(dir, ".giraffe-session"), "utf8"), first.body.session.id);
      assert.equal(transcriptExists(first.body.session.id), true);
    } finally {
      rmSync(pendingPointer, { recursive: true, force: true });
      rmSync(blockedProject, { recursive: true, force: true });
    }
  });

  it("answers a good turn when the rollback pointer can't be written", async (t) => {
    const info = t.mock.method(console, "info", () => {});
    writeFileSync(script, JSON.stringify({ calls: [], text: "Still good." }));
    rmSync(join(dir, ".giraffe-session"), { recursive: true, force: true });
    mkdirSync(join(dir, ".giraffe-session"));
    try {
      const r = await agent({ session: GONE, turn: "New\nPerson: write failure", fresh: "New\nPerson: write failure" });
      assert.equal(r.status, 200);
      const writeErrors = info.mock.calls
        .map(({ arguments: [event] }) => event)
        .filter((event) => event?.code === "legacy_session_write_failed");
      assert.equal(writeErrors.length, 1);
      assert.ok(["EISDIR", "EPERM"].includes(writeErrors[0].error), `unexpected error ${writeErrors[0].error}`);
    } finally {
      rmSync(join(dir, ".giraffe-session"), { recursive: true, force: true });
    }
  });

  it("passes a memory-sized system prompt through the command line whole", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Noted." }));
    const notes = Array.from({ length: 50 }, (_, i) => `- note ${i} ${"ข".repeat(98)}`).join("\n");
    const append = `${APPEND}\n${"x".repeat(6_000)}\n\n## Memory\n${"สรุป".repeat(333)}\n${notes}\n(end of memory)`;
    assert.ok(Buffer.byteLength(append) > 25_000);
    const r = await agent({ turn: "New\nPerson: hi", append });
    assert.equal(r.status, 200);
    assert.ok(sent().at(-1)!.system.includes(append));
  });

  it("refuses a session id that isn't one the box could have made", async () => {
    assert.equal((await agent({ session: "../../etc/passwd", turn: "New\nPerson: hi" })).status, 400);
  });

  it("refuses a named session marked as a one-off", async () => {
    const r = await postAgent({ ...turnBody({ session: "123e4567-e89b-42d3-a456-426614174000", turn: "New\nPerson: hi" }), ephemeral: true });
    assert.equal(r.status, 400);
  });

  it("refuses a session owner that is not an opaque key", async () => {
    const r = await postAgent({ ...turnBody({ turn: "New\nPerson: hi" }), sessionOwner: "../shared" });
    assert.equal(r.status, 400);
  });

  it("refuses a turn without the box token", async () => {
    assert.equal((await agent({ turn: "New\nPerson: hi" }, "Bearer wrong")).status, 401);
  });
});

function transcriptExists(id: string): boolean {
  const projects = join(dir, "config", "projects");
  return existsSync(projects) && readdirSync(projects).some((project) => existsSync(join(projects, project, `${id}.jsonl`)));
}
