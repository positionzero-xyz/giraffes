import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startMock } from "./mock.ts";

const dir = mkdtempSync(join(tmpdir(), "box-mock-api-"));
const dumps = join(dir, "dumps");
const script = join(dir, "script.json");
const log = join(dir, "mock.log");

const tools = [{ name: "mcp__giraffe__remember" }, { name: "mcp__giraffe__schedule_wakeup" }];
const firstUser = { role: "user", content: [{ type: "text", text: "Person: first" }] };
const firstToolUse = { role: "assistant", content: [{ type: "tool_use", id: "toolu_old", name: "mcp__giraffe__remember", input: { note: "old" } }] };
const resumedUser = {
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: "toolu_old", content: "noted" },
    { type: "text", text: "Person: second" },
  ],
};

async function ask(port: number, messages: readonly unknown[]): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", stream: true, tools, messages }),
  });
  assert.equal(res.status, 200);
  return res.text();
}

test("a resumed session counts only tool results after its newest text", async () => {
  mkdirSync(dumps);
  writeFileSync(script, JSON.stringify({
    calls: [
      { name: "remember", input: { note: "first scripted call" } },
      { name: "schedule_wakeup", input: { key: "second-scripted-call", at: "2026-11-27T09:00", note: "Second", asked: true, task: "" } },
    ],
    text: "done",
  }));
  const mock = await startMock(log, dumps, script);
  try {
    const resumed = await ask(mock.port, [firstUser, firstToolUse, resumedUser]);
    assert.match(resumed, /mcp__giraffe__remember/);
    assert.doesNotMatch(resumed, /mcp__giraffe__schedule_wakeup/);

    const answeredFirst = { role: "assistant", content: [{ type: "tool_use", id: "toolu_new", name: "mcp__giraffe__remember", input: { note: "first scripted call" } }] };
    const firstResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_new", content: "noted" }] };
    const followUp = await ask(mock.port, [firstUser, firstToolUse, resumedUser, answeredFirst, firstResult]);
    assert.match(followUp, /mcp__giraffe__schedule_wakeup/);
  } finally {
    mock.proc.kill();
  }
});
