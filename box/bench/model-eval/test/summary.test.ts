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
