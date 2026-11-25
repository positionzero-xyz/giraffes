import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { CASES, selectCases } from "../cases.ts";
import { CONTROL_MODEL, readTurn } from "../product.ts";
import { regradeRun } from "../regrade.ts";
import { dryProduct, runSession, SWITCH } from "../sessions.ts";
import { rows } from "../summary.ts";
import { record, runOf } from "./fixtures.ts";

it("reuses the saved commit and stop without needing the original CLI", async () => {
  const caseId = "reminder-in-20";
  const raw = " อีกยี่สิบนาทีจะเตือนปิดเตาแก๊สให้ค่ะ ";
  const calls = [{ name: "schedule_wakeup", input: { key: "stove", at: "2026-11-26T10:20", note: "ปิดเตาแก๊ส", asked: true, task: "" } }];
  const r = record({ shape: "reminder", caseId, reply: raw.trim(), rawOutput: raw, stopReason: "end_turn", calls });
  const c = CASES.find((c) => c.id === caseId);
  assert.ok(c);
  const { message } = c.make(r.now);
  const read = readTurn({ text: raw, calls, refusedCalls: [], usage: null, costUsd: null, stop: "end" }, message, r.now);
  assert.ok(read.observation.workerCommit);
  const source = runOf([{ ...r, message, workerCommit: read.observation.workerCommit, calls: [] }]);
  const result = await regradeRun(source, "no-original-artifacts", null);
  assert.equal(result.records[0].rawOutput, raw);
  assert.deepEqual(result.records[0].workerCommit, read.observation.workerCommit);
  assert.ok(result.records[0].checks.every((c) => c.pass));
  assert.equal(rows(result, null, [])[0].qualityGraded, 0);
});

it("labels a replayed legacy turn with no original stop or commit as incomplete", async () => {
  const old = record({ reply: "ลองยืดคอค้างไว้สิบวินาทีค่ะ" });
  const result = await regradeRun(runOf([old]), "no-original-artifacts", null);
  const [r] = result.records;
  assert.ok(r.replay?.includes("original stop reason absent"));
  assert.ok(r.replay?.includes("Worker commit reconstructed from saved reply and calls"));
  assert.equal(r.workerCommit, null);
  assert.equal(r.checks.find((c) => c.check === "stops_clean")?.available, false);
  assert.equal(rows(result, null, [])[0].graded, 0);
});

it("rechecks a legacy result with a recorded refusal as a discarded turn", async () => {
  const result = await regradeRun(runOf([record({ reply: "ขอให้ลองนั่งตัวตรงนะคะ", stopReason: "refusal" })]), "no-original-artifacts", null);
  assert.equal(result.records[0].status, "refused");
  assert.deepEqual(result.records[0].structuralSignals, ["stop_reason"]);
});

it("keeps session cases opt-in and plans the Haiku-to-Sonnet resume and history seed", () => {
  assert.ok(selectCases(["chat"], null).every((c) => c.setup !== "long" && c.setup !== "switch"));
  assert.deepEqual(selectCases(["chat"], ["chat-switch-model", "chat-long-resume"], true).map((c) => c.setup), ["long", "switch"]);
  const now = record({}).now;
  const switched = dryProduct(SWITCH, "นัดกันที่ไหน", now, "switch");
  const model = (args: string[]) => args[args.indexOf("--model") + 1];
  assert.deepEqual(switched.map((s) => model(s.args)), ["haiku", "sonnet"]);
  assert.ok(switched[0].args.includes("--session-id") && switched[1].args.includes("--resume"));
  const long = dryProduct({ ...SWITCH, model: CONTROL_MODEL }, "แมวชื่ออะไร", now, "long");
  assert.equal(long.length, 3);
  assert.match(long[1].description ?? "", /90000/);
  assert.ok(long.slice(1).every((s) => s.args.includes("--resume")));
});

it("records the same session ID, actual model, wall time and cache usage on the switch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "session-evidence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "fixture.mjs");
  writeFileSync(cli, `
    for await (const _ of process.stdin) {}
    const args = process.argv.slice(2);
    const arg = (key) => args[args.indexOf(key) + 1];
    const resume = args.includes("--resume");
    const model = "claude-" + arg("--model") + "-5-5";
    console.log(JSON.stringify({ type: "assistant", message: { model, content: [{ type: "text", text: "รับทราบ" }] } }));
    console.log(JSON.stringify({
      type: "result", is_error: false, result: "รับทราบ", stop_reason: "end_turn",
      session_id: arg(resume ? "--resume" : "--session-id"),
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: resume ? 440 : 0, cache_creation_input_tokens: resume ? 0 : 440 },
    }));
  `);
  const tap = fileURLToPath(new URL("../tap.ts", import.meta.url));
  const session = await runSession((file) => [process.execPath, tap, file, "10000", process.execPath, cli], join(dir, "tap.jsonl"), SWITCH, "ขอเวลานัดอีกที", record({}).now, "switch");
  if ("error" in session) assert.fail(session.error);
  assert.equal(session.reply.status, 200);
  assert.deepEqual(session.stages.map((stage) => [stage.resumed, stage.tap?.reportedModel]), [[false, "claude-haiku-5-5"], [true, "claude-sonnet-5-5"]]);
  const [first, final] = session.stages;
  assert.ok(first.tap?.sessionId);
  assert.equal(final.tap?.sessionId, first.tap.sessionId);
  assert.equal(first.tap.usage?.cache_creation_input_tokens, 440);
  assert.equal(final.tap.usage?.cache_read_input_tokens, 440);
  assert.ok(session.stages.every((stage) => (stage.tap?.wallMs ?? 0) > 0));
});
