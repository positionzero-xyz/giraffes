import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TAP = fileURLToPath(new URL("../tap.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "tap-test-"));

function fake(name: string, body: string): string {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, body);
  return file;
}

function run(child: string, timeoutMs: number, stdin = ""): Promise<{ code: number | null; stdout: string; record: any }> {
  const record = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TAP, record, String(timeoutMs), process.execPath, child], { stdio: ["pipe", "pipe", "inherit"] });
    let stdout = "";
    p.stdout.on("data", (c: Buffer) => (stdout += c));
    p.on("close", (code) => resolve({ code, stdout, record: JSON.parse(readFileSync(record, "utf8").trim()) }));
    p.stdin.end(stdin);
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the timing tap", () => {
  it("passes stdin and stdout through and times the first reply text", async () => {
    const child = fake(
      "stream",
      `let input = "";
for await (const c of process.stdin) input += c;
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
out({ type: "system" });
await new Promise((r) => setTimeout(r, 300));
out({ type: "assistant", message: { content: [{ type: "text", text: "echo " + input }] } });
out({ type: "result", total_cost_usd: 0.002, modelUsage: { "claude-haiku-5-5": {} } });`,
    );
    const r = await run(child, 10_000, "hi");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /"echo hi"/);
    assert.ok(r.record.firstTextMs >= 250, `first text at ${r.record.firstTextMs}ms`);
    assert.equal(r.record.costUsd, 0.002);
    assert.deepEqual(r.record.models, ["claude-haiku-5-5"]);
    assert.equal(r.record.killed, false);
  });

  it("kills a CLI that hangs past the timeout, with its own children", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const child = fake(
      "hang",
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
setTimeout(() => {}, 60000);`,
    );
    const r = await run(child, 1_000);
    assert.equal(r.record.killed, true);
    assert.equal(r.code, 124);
    assert.equal(r.record.firstTextMs, null);
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "the CLI's own child is gone too");
  });
});

describe("the tap on a failed result", () => {
  it("keeps the usage and cost of a billed error result", async () => {
    const child = fake(
      "billed-error",
      `process.stdout.write(JSON.stringify({ type: "result", is_error: true, subtype: "error_during_execution", total_cost_usd: 0.004, usage: { input_tokens: 900, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } }) + "\n");
process.exitCode = 1;`,
    );
    const r = await run(child, 10_000);
    assert.equal(r.record.costUsd, 0.004);
    assert.deepEqual(r.record.usage, { input_tokens: 900, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 });
  });

  it("records no usage or cost, rather than zero, when the CLI never reached a result", async () => {
    const r = await run(fake("silent", "process.exitCode = 1;"), 10_000);
    assert.equal(r.record.costUsd, null);
    assert.equal(r.record.usage, null);
  });
});
