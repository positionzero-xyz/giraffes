import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readAgentRequest } from "../src/claude.ts";
import { createBox } from "../src/server.ts";

const CLI = fileURLToPath(new URL("../node_modules/@anthropic-ai/claude-code/bin/claude.exe", import.meta.url));
const MOCK = fileURLToPath(new URL("../mock-api.mjs", import.meta.url));
const TOKEN = "b-agent-test-token-0123456789abcdefghijklmnop";
const MOCK_PORT = 18791;

const dir = mkdtempSync(join(tmpdir(), "box-agent-"));
const script = join(dir, "script.json");
const mockLog = join(dir, "mock.log");
const sessionFile = join(dir, "session");

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
const turnBody = (turn: string, more: Record<string, unknown> = {}) => ({ model: "claude-haiku-5-5", append: "You are Giraffe, a personal assistant.", turn, tools: [SCHEDULE, REMEMBER], ...more });
const requests = () => readFileSync(mockLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.path === "/v1/messages" && r.tools.some((t: string) => t.startsWith("mcp__giraffe__")));

let mock: ChildProcess;
let base = "";
const server = createBox({ token: TOKEN, cli: [CLI], sessionFile });

async function agent(turn: string, auth = `Bearer ${TOKEN}`, more: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/agent`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(turnBody(turn, more)) });
  return { status: res.status, body: await res.json() };
}

describe("an agent turn through the real Claude Code CLI", { skip: existsSync(CLI) ? false : "the pinned CLI is not installed (npm ci in box/)" }, () => {
  before(async () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC")) delete process.env[k];
    Object.assign(process.env, { CLAUDE_CONFIG_DIR: join(dir, "config"), ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, ANTHROPIC_API_KEY: "sk-ant-api03-mock-not-a-key" });
    writeFileSync(script, JSON.stringify({ calls: [], text: "" }));
    mock = spawn(process.execPath, [MOCK, mockLog, String(MOCK_PORT), "", script], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => mock.stdout?.once("data", () => resolve()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    mock.kill();
  });

  it("returns the reply text and the tool calls Giraffe's server accepted, in order, and keeps the session", async () => {
    writeFileSync(script, JSON.stringify({
      calls: [
        { name: "schedule_wakeup", input: { key: "call-clinic", at: "2026-11-27T09:00", note: "Call the clinic", asked: true, task: "" } },
        { name: "remember", input: { note: "Beam is allergic to peanuts." } },
      ],
      text: "Set for Friday at 9.",
    }));
    const r = await agent("New\nPerson: remind me Friday 9 am to call the clinic");
    assert.equal(r.status, 200);
    assert.equal(r.body.text, "Set for Friday at 9.");
    assert.deepEqual(r.body.calls, [
      { name: "schedule_wakeup", input: { key: "call-clinic", at: "2026-11-27T09:00", note: "Call the clinic", asked: true, task: "" } },
      { name: "remember", input: { note: "Beam is allergic to peanuts." } },
    ]);
    assert.match(readFileSync(sessionFile, "utf8"), /^[0-9a-f-]{36}$/);
  });

  it("leaves out a call the tool server refused, so the model can fix it in the same turn", async () => {
    writeFileSync(script, JSON.stringify({
      calls: [
        { name: "schedule_wakeup", input: { key: "water", at: "2026-11-20T15:00" } },
        { name: "schedule_wakeup", input: { key: "water", at: "2026-11-20T15:00", note: "Drink water", asked: true, task: "" } },
      ],
      text: "Water at 3.",
    }));
    writeFileSync(sessionFile, "");
    const r = await agent("New\nPerson: remind me at 3 to drink water");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.calls, [{ name: "schedule_wakeup", input: { key: "water", at: "2026-11-20T15:00", note: "Drink water", asked: true, task: "" } }]);
  });

  it("returns refused tool calls with their original input and validation problems", async () => {
    const input = { key: "water", at: 15, asked: true, task: "" };
    writeFileSync(script, JSON.stringify({
      calls: [{ name: "schedule_wakeup", input }, { name: "remember", input: { note: "Prefers morning reminders." } }],
      text: "Water at 3.",
    }));
    writeFileSync(sessionFile, "");
    const r = await agent("New\nPerson: remind me at 3 to drink water");
    assert.equal(r.status, 200);
    assert.equal(r.body.text, "Water at 3.");
    assert.deepEqual(r.body.refusedCalls, [{ name: "schedule_wakeup", input, problems: ["missing note", "at has the wrong type or value"] }]);
    assert.deepEqual(r.body.calls, [{ name: "remember", input: { note: "Prefers morning reminders." } }]);
  });

  it("resumes the same session on the next turn, so the model sees the earlier turns", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "First." }));
    writeFileSync(sessionFile, "");
    await agent("New\nPerson: first message");
    const session = readFileSync(sessionFile, "utf8");
    const firstSize = requests().at(-1).messages;
    writeFileSync(script, JSON.stringify({ calls: [], text: "Second." }));
    const r = await agent("New\nPerson: second message");
    assert.equal(r.body.text, "Second.");
    assert.equal(readFileSync(sessionFile, "utf8"), session);
    assert.ok(requests().at(-1).messages > firstSize, "the second turn carries the first");
  });

  it("starts a new session when the saved one is gone", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Fresh." }));
    writeFileSync(sessionFile, "11111111-2222-3333-4444-555555555555");
    const r = await agent("New\nPerson: hello again");
    assert.equal(r.status, 200);
    assert.equal(r.body.text, "Fresh.");
    assert.notEqual(readFileSync(sessionFile, "utf8"), "11111111-2222-3333-4444-555555555555");
  });

  it("sends the requested effort to the API", async () => {
    writeFileSync(script, JSON.stringify({ calls: [], text: "Low." }));
    writeFileSync(sessionFile, "");
    const r = await agent("New\nPerson: hi", `Bearer ${TOKEN}`, { effort: "low" });
    assert.equal(r.status, 200);
    assert.equal(requests().at(-1).effort, "low");
  });

  it("refuses an effort the CLI doesn't know", async () => {
    assert.equal((await agent("New\nPerson: hi", `Bearer ${TOKEN}`, { effort: "turbo" })).status, 400);
  });

  it("refuses a turn without the box token", async () => {
    assert.equal((await agent("New\nPerson: hi", "Bearer wrong")).status, 401);
  });
});

describe("an agent request's effort", () => {
  it("is optional, so a Worker that sends none keeps the CLI's own choice", () => {
    const req = readAgentRequest(turnBody("New\nPerson: hi"));
    assert.ok(req);
    assert.equal("effort" in req, false);
  });

  it("is kept when it is one the CLI takes", () => assert.equal(readAgentRequest(turnBody("New\nPerson: hi", { effort: "max" }))?.effort, "max"));

  it("refuses anything else", () => {
    for (const effort of ["turbo", "", 3, null]) assert.equal(readAgentRequest(turnBody("New\nPerson: hi", { effort })), null, String(effort));
  });
});
