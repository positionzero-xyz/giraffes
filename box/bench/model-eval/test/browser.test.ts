import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findChrome, inspect } from "../browser.ts";
import { PLANTS } from "../calibration.ts";
import { CASES } from "../cases.ts";
import { formEvidence } from "../browser-dom.ts";
import { grade } from "../checks.ts";
import { parseWall } from "../when.ts";
import type { Check, Observation } from "../types.ts";

const chrome = findChrome(process.env.CHROME);
const pageFile = (name: string) => fileURLToPath(new URL(`./pages/${name}.html`, import.meta.url));

async function graded(name: string, check: Check) {
  assert.ok(chrome);
  const drive = check.kind === "persists" ? check.drive : check.kind === "total_adds" ? "expense" : null;
  const page = await inspect(chrome, pageFile(name), drive);
  const o: Observation = { text: "", raw: "", answered: true, wakeups: [], rejected: [], files: {}, page };
  return grade(check, o);
}

describe("build checks against a real headless browser", { skip: chrome ? false : "no Chrome or Edge found (set CHROME)" }, () => {
  const booking = { kind: "persists", drive: "booking", shown: false } as const;
  const expense = { kind: "persists", drive: "expense", shown: true } as const;
  it("a form with a time select persists all four entered values", async () => assert.equal((await graded("form-saves", booking)).pass, true));

  it("requires four working booking controls, not static labels", async () => {
    const r = await graded("booking-no-controls", booking);
    assert.equal(r.pass, false, r.detail);
  });

  it("buttons with no form that save and redraw persist and show the entry", async () => {
    const r = await graded("buttons-list", expense);
    assert.equal(r.pass, true, r.detail);
  });

  it("a page that keeps nothing fails and says why", async () => {
    const r = await graded("forgets", expense);
    assert.equal(r.pass, false);
    assert.match(r.detail, /nothing saved/);
  });

  it("a booking form that keeps only the name fails and names what it dropped", async () => {
    const r = await graded("saves-name-only", booking);
    assert.equal(r.pass, false);
    assert.match(r.detail, /complete entry/);
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

  it("binds decimal prices to the rendered menu item", async (t) => {
    const html = PLANTS.find((p) => p.id === "build-noodle-menu-clear")?.html;
    assert.ok(chrome && html);
    const dir = mkdtempSync(join(tmpdir(), "menu-evidence-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "index.html");
    const now = parseWall("2026-11-26T10:00");
    assert.ok(now);
    const check = CASES.find((c) => c.id === "build-noodle-menu")?.make(now).checks.find((c) => c.kind === "priced");
    assert.ok(check);
    for (const [markup, pass] of [[html, true], [html.replace("50 บาท", "50.50 บาท"), false]] as const) {
      writeFileSync(file, markup);
      const page = await inspect(chrome, file, null);
      const r = grade(check, { text: "", raw: "", answered: true, wakeups: [], rejected: [], files: {}, page });
      assert.equal(r.pass, pass, r.detail);
    }
  });

  it("drives two linked menu and order views and rejects an order view with a stuck total", async (t) => {
    const html = PLANTS.find((p) => p.id === "build-menu-order-clear")?.html;
    assert.ok(chrome && html);
    const dir = mkdtempSync(join(tmpdir(), "order-evidence-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "index.html");
    for (const [markup, pass] of [[html, true], [html.replace("total+=Number(b.dataset.price)", "total=0"), false]] as const) {
      writeFileSync(file, markup);
      const page = await inspect(chrome, file, "order");
      assert.equal(page.order?.ok, pass, page.order?.detail ?? "no order report");
    }
  });
});

it("does not assemble a booking from separate localStorage values or separate rows", () => {
  const entered = [
    { field: "name", value: "สมชาย", label: "" },
    { field: "phone", value: "0812345678", label: "" },
    { field: "date", value: "2026-12-20", label: "" },
    { field: "time", value: "slot-3", label: "15:30" },
  ];
  const fragments = entered.map(({ field, value }) => JSON.stringify({ [field]: value }));
  const split = formEvidence(entered, fragments, ["สมชาย 0812345678", "2026-12-20 15:30"]);
  assert.equal(split.complete, false);
  assert.equal(split.shown, false);
  const row = { name: "สมชาย", phone: "0812345678", date: "2026-12-20", time: "slot-3" };
  assert.equal(formEvidence(entered, [JSON.stringify([row])], []).complete, true);
});
