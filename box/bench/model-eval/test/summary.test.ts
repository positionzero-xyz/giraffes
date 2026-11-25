import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render, rows } from "../summary.ts";
import { record, runOf } from "./fixtures.ts";

describe("the summary", () => {
  it("counts a reply the Worker would discard as a failed case, and a harness failure as neither", () => {
    const run = runOf([
      record({ id: "a" }),
      record({ id: "b", status: "cut_off", checks: [] }),
      record({ id: "c", status: "refused", checks: [] }),
      record({ id: "d", status: "harness_error", checks: [] }),
    ]);
    const [row] = rows(run, null, []);
    assert.equal(row.casesPassed, 1);
    assert.equal(row.graded, 3);
    assert.match(render(run, null, []), /\| 1\/3 \|/);
  });

  const cells = (md: string, candidate: string) => md.split("\n").find((l) => l.startsWith(`| ${candidate} |`))?.slice(2, -2).split(" | ") ?? [];

  it("shows a Codex row's missing cost as unknown and its run as a planned contract", () => {
    const codexMeta = { cli: "codex", version: "0.172.0", profile: "pool", provider: "cliproxy", tools: { turn: ["exec", "mcp__giraffe/remember"] } };
    const run = runOf([
      record({ id: "a", costUsd: 0.01 }),
      record({ id: "b", candidate: "codex:gpt-6.2-sol@low", harness: "codex", model: "gpt-6.2-sol", contract: "planned", costUsd: null, otherTools: ["command_execution"] }),
    ]);
    const md = render({ ...run, meta: { ...run.meta, codex: codexMeta } }, null, []);
    assert.equal(cells(md, "haiku@low")[2], "product");
    assert.equal(cells(md, "haiku@low").at(-1), "0.0100 (1/1)");
    assert.equal(cells(md, "codex:gpt-6.2-sol@low")[2], "planned");
    assert.equal(cells(md, "codex:gpt-6.2-sol@low").at(-1), "unknown (0/1)");
    assert.match(md, /Known cost USD 0\.0100 over 1 of 2 runs/);
    assert.match(md, /Codex 0\.172\.0 \(codex\) on profile pool/);
    assert.match(md, /chat, reminder or draft turn .*: exec, mcp__giraffe\/remember\./);
    assert.match(md, /b \(command_execution\)/);
  });

  it("shows an OpenCode row's reported cost, its planned contract and the tools it offered", () => {
    const opencodeMeta = { cli: "opencode.exe", version: "2.4.1", tools: { turn: ["giraffe_remember"], build: ["edit", "read", "write"] } };
    const run = runOf([record({ id: "o", candidate: "opencode:mistral/deepseek-v4-1-flash-1017@low", harness: "opencode", model: "mistral/deepseek-v4-1-flash-1017", contract: "planned", costUsd: 0.0006 })]);
    const md = render({ ...run, meta: { ...run.meta, opencode: opencodeMeta } }, null, []);
    assert.equal(cells(md, "opencode:mistral/deepseek-v4-1-flash-1017@low")[2], "planned");
    assert.equal(cells(md, "opencode:mistral/deepseek-v4-1-flash-1017@low").at(-1), "0.0006 (1/1)");
    assert.match(md, /OpenCode 2\.4\.1 \(opencode\.exe\)/);
    assert.match(md, /chat, reminder or draft turn .*stand-in provider.*: giraffe_remember\./);
    assert.match(md, /build .*: edit, read, write\./);
  });

  it("leaves Codex out of a Claude-only run", () => {
    const claudeOnly = render(runOf([record({})]), null, []);
    assert.doesNotMatch(claudeOnly, /Codex \d/);
    assert.match(claudeOnly, /Claude CLI 1 \(claude\)/);
  });
});

describe("the summary's timing", () => {
  const run = runOf([
    record({ id: "a", wallMs: 12_000 }),
    record({ id: "b", wallMs: 50_000 }),
    record({ id: "c", status: "timeout", wallMs: 119_000, checks: [], usage: null, costUsd: null }),
  ]);

  it("counts a reply at 50 s exactly and a timed-out one as missing LINE's reply window, and timeouts apart", () => {
    const [row] = rows(run, null, []);
    assert.equal(row.missedLineWindow, 2);
    assert.equal(row.timeouts, 1);
    assert.equal(row.medianWallMs, 31_000);
  });

  it("labels the first assistant text as internal and the window as a CLI-time lower bound", () => {
    const md = render(run, null, []);
    assert.match(md, /first internal text s/);
    assert.match(md, /CLI wall ≥ 50 s/);
  });
});

describe("the summary's spend", () => {
  const run = runOf([
    record({ id: "a", costUsd: 0.002 }),
    record({ id: "b", status: "claude_failed", checks: [], usage: null, costUsd: null }),
  ]);

  it("shows unknown cost and tokens as unknown, with how many runs reported them", () => {
    const [row] = rows(run, null, []);
    assert.equal(row.costUsd, 0.002);
    assert.equal(row.costKnown, 1);
    assert.equal(row.usageKnown, 1);
    const md = render(run, null, []);
    assert.match(md, /0\.0020 \(1\/2\)/);
    assert.match(md, /Known cost USD 0\.0020 over 1 of 2 runs/);
  });

  it("shows a cell with no reported cost as unknown, not zero", () => {
    const [row] = rows(runOf([record({ costUsd: null, usage: null })]), null, []);
    assert.equal(row.costUsd, null);
    assert.equal(row.tokens, null);
  });
});
