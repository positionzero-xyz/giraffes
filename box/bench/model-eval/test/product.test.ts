import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AgentReply } from "../../../src/claude.ts";
import { CASES } from "../cases.ts";
import { grade, structuralSignals } from "../checks.ts";
import { agentRequest, CONTROL_MODEL, failedTurn, readTurn } from "../product.ts";
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

describe("the request a box turn sends", () => {
  const capture = JSON.parse(readFileSync(new URL("../../../../app/test/fixtures/box-first-turn-line.json", import.meta.url), "utf8"));

  it("is the Worker's own first LINE turn, captured in the app's tests, with only the model and effort swapped", () => {
    assert.equal(CONTROL_MODEL, "claude-haiku-5-5");
    assert.deepEqual(agentRequest({ harness: "claude-code", model: CONTROL_MODEL, effort: "default" }, capture.message, capture.now), capture.request);
    const low = agentRequest({ harness: "claude-code", model: "opus", effort: "low" }, capture.message, capture.now);
    assert.deepEqual(low, { ...capture.request, model: "opus", effort: "low" });
  });
});

function gradedCase(caseId: string, reply: Body, now = NOW) {
  const k = CASES.find((c) => c.id === caseId) ?? assert.fail(caseId);
  const { message, checks } = k.make(now);
  const r = readTurn(reply, message, now, "product", k.setup);
  assert.equal(r.status, "ok");
  return { r, failed: checks.map((c) => grade(c, r.observation)).filter((g) => !g.pass).map((g) => g.check) };
}

const failedChecks = (caseId: string, reply: Body) => gradedCase(caseId, reply).failed;
const schedule = (at: string, extra: { asked?: boolean; repeat?: string } = {}): Body["calls"][number] => ({
  name: "schedule_wakeup", input: { key: "gas-stove", at, note: "ปิดเตาแก๊ส", asked: true, task: "", ...extra },
});

describe("structured reminder grades from the Worker commit", () => {
  it("requires exactly one person-requested wake-up at the right instant with the requested repeat", () => {
    const caseId = "reminder-in-20";
    const at = "2026-11-26T10:20";
    assert.deepEqual(failedChecks(caseId, body({})), []);
    for (const calls of [
      [],
      [schedule("2026-11-26T10:30")],
      [schedule(at, { asked: false })],
      [schedule(at, { repeat: "daily" })],
      [schedule(at), { name: "schedule_wakeup", input: { key: "other", at: "2026-11-26T11:00", note: "อีกเรื่อง", asked: true, task: "" } }],
      [schedule(at), { name: "remember", input: { note: "ชอบอ่านหนังสือ" } }],
    ]) assert.ok(failedChecks(caseId, body({ calls })).includes("due_at"));
    assert.deepEqual(failedChecks("reminder-every-monday", body({ calls: [schedule("2026-11-30T08:00", { repeat: "weekly" })] })), []);
    assert.ok(failedChecks("reminder-every-monday", body({ calls: [schedule("2026-11-30T08:00")] })).includes("due_at"));
  });

  it("leaves both the saved note's meaning and the confirmation's meaning for the judge", () => {
    const calls = [{ name: "schedule_wakeup", input: { key: "gas-stove", at: "2026-11-26T10:20", note: "เปิดเตาแก๊ส", asked: true, task: "" } }];
    assert.deepEqual(failedChecks("reminder-in-20", body({ text: "พรุ่งนี้เตือนตอนสิบโมงยี่สิบหรือสิบโมงครึ่งค่ะ", calls })), []);
  });

  it("accepts clarification and enforces the evening window on committed schedules", () => {
    const caseId = "reminder-vague-evening";
    assert.deepEqual(failedChecks(caseId, body({ calls: [] })), []);
    assert.deepEqual(failedChecks(caseId, body({ calls: [schedule("2026-11-26T17:15")] })), []);
    for (const at of ["2026-11-26T15:59", "2026-11-26T20:00", "2026-11-27T17:15"]) {
      assert.ok(failedChecks(caseId, body({ calls: [schedule(at)] })).includes("asks_or_assumes"));
    }
    const late = "2026-11-26T20:00" as Wall;
    assert.deepEqual(gradedCase(caseId, body({ calls: [schedule("2026-11-27T17:15")] }), late).failed, []);
  });

  it("requires all three multi-action effects and rejects extras", () => {
    const caseId = "reminder-multi-action";
    const calls = [
      schedule("2026-11-27T15:00"),
      { name: "cancel_wakeup", input: { key: "pick-up-parcel" } },
      { name: "remember", input: { note: "เลี่ยงนม" } },
    ];
    const { r, failed } = gradedCase(caseId, body({ calls }));
    assert.deepEqual(failed, []);
    assert.deepEqual(r.observation.workerCommit?.wakeupsCancel, ["pick-up-parcel"]);
    assert.deepEqual(r.observation.workerCommit?.notes, ["เลี่ยงนม"]);
    for (let i = 0; i < calls.length; i++) {
      assert.ok(failedChecks(caseId, body({ calls: calls.filter((_, j) => i !== j) })).includes("due_at"));
    }
  });
});

describe("what the person would receive", () => {
  it("fails an unrequested locale change even when Bangkok sees the right due time", () => {
    const changed = body({ calls: [
      { name: "set_locale", input: { timeZone: "Asia/Yangon", language: "th" } },
      { name: "schedule_wakeup", input: { key: "gas-stove", at: "2026-11-26T09:50", note: "ปิดเตาแก๊ส", asked: true, task: "" } },
    ] });
    const r = readTurn(changed, CASES.find((c) => c.id === "reminder-in-20")!.make(NOW).message, NOW);
    assert.equal(r.observation.wakeups[0]?.at, "2026-11-26T10:20");
    assert.ok(failedChecks("reminder-in-20", changed).length);
  });

  it("fails a chat turn that stays quiet", () => assert.ok(failedChecks("chat-advice", body({ text: "", calls: [] })).includes("replies")));

  it("passes a reminder set on the second try, and keeps the refused first call as a diagnostic", () => {
    const repaired = body({
      refusedCalls: [{ name: "schedule_wakeup", input: { key: "gas-stove", at: "10:20", asked: true }, problems: ["at: Invalid"] }],
    });
    assert.deepEqual(failedChecks("reminder-in-20", repaired), []);
    const r = readTurn(repaired, "อีก 20 นาทีเตือนให้ไปปิดเตาแก๊สด้วยนะ", NOW);
    assert.ok(r.observation.rejected.length > 0);
    assert.notEqual(r.observation.text, r.observation.raw, "the Worker's own notice is part of what the person reads");
    assert.ok(r.observation.text.startsWith(r.observation.raw));
  });

  it("grades a chat reply on what the Worker delivers, cut to the reply limit, and flags the overlong draft", () => {
    const long = `ลองยืดคอค้างไว้ 10 วินาทีนะ ${"ค่อยๆ หายใจเข้าออกช้าๆ ".repeat(40)}`;
    const r = readTurn(body({ text: long, calls: [] }), "นั่งทำงานหน้าคอมทั้งวันจนปวดคอกับไหล่มากเลย", NOW);
    assert.ok(r.observation.text.length <= 600);
    assert.equal(r.observation.raw, long);
    assert.ok(failedChecks("chat-advice", body({ text: long, calls: [] })).includes("fits_reply"));
  });
});

it("records structural fallback signals without inferring them from a quality failure", () => {
  const quiet = { status: "ok", refusedCalls: [], rejected: [], overReplyCap: false };
  assert.deepEqual(structuralSignals(quiet), []);
  assert.deepEqual(structuralSignals({ ...quiet, status: "invalid_output", refusedCalls: [{}], overReplyCap: true }), ["tool_rejection", "reply_cap", "schema_failure"]);
  assert.deepEqual(structuralSignals({ ...quiet, stopReason: "refusal" }), ["stop_reason"]);
});

describe("a box turn that failed", () => {
  it("keeps the usage and cost the tap saw on the failed result", () => {
    const usage = { input_tokens: 900, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 };
    const r = failedTurn(502, { firstTextMs: null, wallMs: 4_000, killed: false, costUsd: 0.004, models: [], usage });
    assert.equal(r.status, "claude_failed");
    assert.deepEqual(r.usage, usage);
    assert.equal(r.costUsd, 0.004);
  });

  it("calls a run the tap killed a timeout, with nothing known about its spend", () => {
    const r = failedTurn(502, { firstTextMs: null, wallMs: 119_000, killed: true, costUsd: null, models: [], usage: null });
    assert.equal(r.status, "timeout");
    assert.equal(r.costUsd, null);
  });
});
