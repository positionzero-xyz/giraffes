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
