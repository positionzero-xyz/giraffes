import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "split-utf8-"));

/** A CLI that writes each stream-json line in two pieces, cut inside the first Thai character's bytes. */
export function splittingCli(events: readonly unknown[]): string {
  const file = join(dir, `cli-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    file,
    `for await (const _ of process.stdin) {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const e of ${JSON.stringify(events)}) {
  const line = Buffer.from(JSON.stringify(e) + "\\n");
  const thai = line.findIndex((b) => b === 0xe0);
  const cut = thai === -1 ? line.length : thai + 1;
  await new Promise((r) => process.stdout.write(line.subarray(0, cut), r));
  await sleep(60);
  await new Promise((r) => process.stdout.write(line.subarray(cut), r));
}`,
  );
  return file;
}

export const THAI_TURN = [
  { type: "system", subtype: "init" },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__giraffe__schedule_wakeup", input: { key: "plants", at: "2026-11-26T17:00", note: "รดน้ำต้นไม้", asked: true, task: "" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "noted" }] } },
  { type: "result", subtype: "success", is_error: false, result: "ตั้งเตือนรดน้ำต้นไม้ไว้ห้าโมงเย็นแล้ว", stop_reason: "end_turn", total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 } },
];
