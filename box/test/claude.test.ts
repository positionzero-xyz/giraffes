import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentArgs, type AgentRequest } from "../src/claude.ts";

const SESSION = { id: "123e4567-e89b-42d3-a456-426614174000", resume: false };
const request: AgentRequest = {
  model: "claude-haiku-5-5",
  append: "You are Giraffe.",
  session: null,
  turn: "New\nPerson: hi",
  fresh: "New\nPerson: hi",
  tools: [],
  at: null,
};

describe("agent CLI arguments", () => {
  it("uses no-session-persistence only for one-off turns", () => {
    assert.equal(agentArgs({ ...request, ephemeral: true }, "tools.json", SESSION).includes("--no-session-persistence"), true);
    assert.equal(agentArgs(request, "tools.json", SESSION).includes("--no-session-persistence"), false);
  });
});
