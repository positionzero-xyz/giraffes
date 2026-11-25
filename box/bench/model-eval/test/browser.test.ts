import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findChrome, inspect } from "../browser.ts";
import { grade } from "../checks.ts";
import type { Check, Observation } from "../types.ts";

const chrome = findChrome(process.env.CHROME);
const pageFile = (name: string) => fileURLToPath(new URL(`./pages/${name}.html`, import.meta.url));

async function graded(name: string, check: Check) {
  const page = await inspect(chrome as string, pageFile(name), check.kind === "persists" || check.kind === "total_adds");
  const o: Observation = { text: "", raw: "", answered: true, wakeups: [], rejected: [], files: {}, page };
  return grade(check, o);
}

describe("build checks against a real headless browser", { skip: chrome ? false : "no Chrome or Edge found (set CHROME)" }, () => {
  it("a form that saves on submit persists", async () => assert.equal((await graded("form-saves", { kind: "persists", shown: false })).pass, true));

  it("requires four working booking controls, not static labels", async () => {
    const r = await graded("booking-no-controls", { kind: "persists", shown: false });
    assert.equal(r.pass, false, r.detail);
  });

  it("buttons with no form that save and redraw persist and show the entry", async () => {
    const r = await graded("buttons-list", { kind: "persists", shown: true });
    assert.equal(r.pass, true, r.detail);
  });

  it("a page that keeps nothing fails and says why", async () => {
    const r = await graded("forgets", { kind: "persists", shown: false });
    assert.equal(r.pass, false);
    assert.match(r.detail, /nothing saved/);
  });

  it("a booking form that keeps only the name fails and names what it dropped", async () => {
    const r = await graded("saves-name-only", { kind: "persists", shown: false });
    assert.equal(r.pass, false);
    assert.match(r.detail, /0812345678/);
  });

  it("an expense page passes when its total grows by the amount entered, and fails when the total stays put", async () => {
    const good = await graded("buttons-list", { kind: "total_adds" });
    assert.equal(good.pass, true, good.detail);
    assert.equal((await graded("total-stuck", { kind: "total_adds" })).pass, false);
  });

  it("a clean page loads clean and a throwing one doesn't", async () => {
    assert.equal((await graded("buttons-list", { kind: "loads_clean" })).pass, true);
    const r = await graded("throws", { kind: "loads_clean" });
    assert.equal(r.pass, false);
    assert.match(r.detail, /items is not defined/);
  });

  it("reads the rendered text, not the source", async () => {
    assert.equal((await graded("buttons-list", { kind: "page_has", items: [{ label: "total", any: ["รวม 0 บาท"] }] })).pass, true);
    assert.equal((await graded("throws", { kind: "page_has", items: [{ label: "the script's template", any: ["${i}"] }] })).pass, false);
  });
});
