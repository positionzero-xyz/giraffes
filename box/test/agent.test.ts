import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createBox } from "../src/server.ts";
import { mockPort } from "./mock-port.ts";

const CLI = fileURLToPath(new URL("../node_modules/@anthropic-ai/claude-code/bin/claude.exe", import.meta.url));
const MOCK = fileURLToPath(new URL("../mock-api.mjs", import.meta.url));
const TOKEN = "b-agent-test-token-0123456789abcdefghijklmnop";
const APPEND = "You are Giraffe, a personal assistant.";
const GONE = "11111111-2222-3333-4444-555555555555";
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

const transcriptExists = (id: string): boolean => {
  const projects = join(dir, "config", "projects");
  return existsSync(projects) && readdirSync(projects).some((project) => existsSync(join(projects, project, `${id}.jsonl`)));
};

let mock: ChildProcess;
let base = "";
const stateDir = join(dir, "state");
mkdirSync(stateDir, { recursive: true });
const server = createBox({ token: TOKEN, cli: [CLI], sessionFile: join(dir, ".giraffe-session"), home: join(dir, "home"), configDir: join(dir, "config"), scratchDirs: [join(dir, "tmp")], stateFile: join(stateDir, "erase.json") });

async function postAgent(body: object, auth = `Bearer ${TOKEN}`): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/agent`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const agent = (t: Turn, auth?: string) => postAgent(turnBody(t), auth);

describe("an agent turn through the real Claude Code CLI", { skip: existsSync(CLI) ? false : "the pinned CLI is not installed (npm ci in box/)" }, () => {
  before(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC")) delete process.env[k];
    writeFileSync(script, JSON.stringify({ calls: [], text: "" }));
    mkdirSync(dumps);
    mock = spawn(process.execPath, [MOCK, mockLog, "0", dumps, script], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await mockPort(mock);
    Object.assign(process.env, { CLAUDE_CONFIG_DIR: join(dir, "config"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-ant-api03-mock-not-a-key" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    mock.kill();
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

  it("resumes the same session when an old Worker omits session and fresh", async () => {
    rmSync(join(dir, ".giraffe-session"), { force: true });
    writeFileSync(script, JSON.stringify({ calls: [], text: "Legacy reply." }));
    const legacyTurn = { model: "claude-haiku-5-5", append: APPEND, tools: [SCHEDULE, REMEMBER] };
    const first = await postAgent({ ...legacyTurn, turn: "New\nPerson: first legacy message" });
    const second = await postAgent({ ...legacyTurn, turn: "New\nPerson: second legacy message" });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.match(first.body.session.id, UUID);
    assert.equal(first.body.session.resumed, false);
    assert.deepEqual(second.body.session, { id: first.body.session.id, resumed: true });
    assert.deepEqual(userTexts(sent().at(-1)!), ["New\nPerson: first legacy message", "New\nPerson: second legacy message"]);
  });

  it("keeps the session the new Worker named for an old Worker after a rollback", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Named reply." }));
    const started = await agent({ session: null, turn: "New\nPerson: NAMED-ONE", fresh: "New\nPerson: NAMED-ONE" });
    const resumed = await agent({ session: started.body.session.id, turn: "New\nPerson: NAMED-TWO" });
    const legacy = await postAgent({ model: "claude-haiku-5-5", append: APPEND, tools: [SCHEDULE, REMEMBER], turn: "New\nPerson: AFTER-ROLLBACK" });

    assert.equal(resumed.status, 200);
    assert.deepEqual(legacy.body.session, { id: started.body.session.id, resumed: true });
    assert.deepEqual(userTexts(sent().at(-1)!), ["New\nPerson: NAMED-ONE", "New\nPerson: NAMED-TWO", "New\nPerson: AFTER-ROLLBACK"]);
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

    writeFileSync(script, JSON.stringify({ calls: [], text: "After group." }));
    const legacyTurn = { model: "claude-haiku-5-5", append: APPEND, tools: [SCHEDULE, REMEMBER] };
    const afterGroup = await postAgent({ ...legacyTurn, turn: "New\nPerson: after group" });
    assert.equal(afterGroup.status, 200);
    assert.deepEqual(afterGroup.body.session, { id: personal.body.session.id, resumed: true });
  });

  it("cleans the replaced chat session when a later named turn repairs a failed pointer write", async () => {
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
    assert.equal(transcriptExists(first.body.session.id), true);
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

  it("answers a good turn when the rollback pointer can't be written", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Still good." }));
    rmSync(join(dir, ".giraffe-session"), { recursive: true, force: true });
    mkdirSync(join(dir, ".giraffe-session"));
    try {
      const r = await agent({ session: GONE, turn: "New\nPerson: write failure", fresh: "New\nPerson: write failure" });
      assert.equal(r.status, 200);
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

  it("refuses a turn without the box token", async () => {
    assert.equal((await agent({ turn: "New\nPerson: hi" }, "Bearer wrong")).status, 401);
  });
});
