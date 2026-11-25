import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentReply } from "../../../src/claude.ts";
import { readTurn } from "../product.ts";
import type { Wall } from "../types.ts";

const NOW = "2026-11-26T10:00" as Wall;
type Body = Extract<AgentReply, { status: 200 }>["body"];

const body = (more: Partial<Body>): Body => ({
  text: "ได้เลย อีก 20 นาทีจะเตือนให้ไปปิดเตาแก๊สนะ",
  calls: [{ name: "schedule_wakeup", input: { key: "gas-stove", at: "2026-11-26T10:20", note: "เตือนปิดเตาแก๊ส", asked: true, task: "" } }],
  refusedCalls: [],
  usage: { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 900 },
  stop: "end",
  costUsd: 0.0031,
  ...more,
});

describe("a box turn reply read the way the Worker reads it", () => {
  it("grades a clean reply as a served turn with its reminder", () => {
    const r = readTurn(body({}), "อีก 20 นาทีเตือนให้ไปปิดเตาแก๊สด้วยนะ", NOW);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.observation.wakeups.map((w) => w.at), ["2026-11-26T10:20"]);
  });

  for (const [stop, status] of [["max_tokens", "cut_off"], ["refusal", "refused"]] as const) {
    it(`fails a reply that stopped on ${stop}, however valid its text and calls, and keeps its usage`, () => {
      const r = readTurn(body({ stop }), "อีก 20 นาทีเตือนให้ไปปิดเตาแก๊สด้วยนะ", NOW);
      assert.equal(r.status, status);
      assert.deepEqual(r.observation.wakeups, []);
      assert.equal(r.usage?.output_tokens, 80);
      assert.equal(r.costUsd, 0.0031);
    });
  }
});
