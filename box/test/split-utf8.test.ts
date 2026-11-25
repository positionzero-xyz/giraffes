import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentTurn } from "../src/claude.ts";
import { splittingCli, THAI_TURN } from "./split-cli.ts";

describe("a box turn whose output arrives with Thai characters cut across chunks", () => {
  it("keeps the reply and the tool call's arguments whole", async () => {
    const reply = await agentTurn([process.execPath, splittingCli(THAI_TURN)], { model: "haiku", append: "", turn: "hi", tools: [] }, { get: () => null, set: () => {} });
    assert.equal(reply.status, 200);
    if (reply.status !== 200) return;
    assert.equal(reply.body.text, "ตั้งเตือนรดน้ำต้นไม้ไว้ห้าโมงเย็นแล้ว");
    assert.equal(reply.body.calls[0]?.input.note, "รดน้ำต้นไม้");
  });
});
