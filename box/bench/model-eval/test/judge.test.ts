import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CASES } from "../cases.ts";
import { grade } from "../checks.ts";
import { CALIBRATION, CALIBRATION_CASE, calibrationGate, ingestScores, readScores, writeJudgeBatch, type JudgeKey } from "../judge.ts";
import type { RunRecord, Wall } from "../types.ts";

const record = (id: string, reply: string): RunRecord => ({
  id,
  candidate: "haiku@low",
  harness: "claude-code",
  model: "haiku",
  effort: "low",
  shape: "chat",
  caseId: "chat-advice",
  rep: 1,
  contract: "product",
  now: "2026-11-29T10:00" as Wall,
  machineDate: "2026-11-29",
  dateMismatch: false,
  status: "ok",
  message: "",
  reply,
  overReplyCap: false,
  calls: [],
  refusedCalls: [],
  rejected: [],
  wakeups: [],
  checks: [],
  wallMs: 1,
  firstTextMs: 1,
  usage: null,
  costUsd: 0,
  models: [],
  buildDir: null,
});

function batch() {
  const dir = mkdtempSync(join(tmpdir(), "judge-test-"));
  writeJudgeBatch(dir, [record("haiku@low:chat-advice:1", "ลองยืดคอค้างไว้ 10 วินาที")]);
  const key = JSON.parse(readFileSync(join(dir, "judge-key.json"), "utf8")) as JudgeKey;
  const level = (l: string) => Object.entries(key).find(([, e]) => "calibration" in e && e.calibration === l)?.[0] as string;
  const chat = Object.entries(key).find(([, e]) => "record" in e)?.[0] as string;
  return { dir, key, level, chat };
}

const draftScores = (good: number, flat: number, bad: number, b: ReturnType<typeof batch>) => ({
  [b.chat]: { helpful: 4, natural_thai: 4 },
  [b.level("good")]: { natural_thai: good, persuasive: good, fits_channel: good },
  [b.level("flat")]: { natural_thai: flat, persuasive: flat, fits_channel: flat },
  [b.level("bad")]: { natural_thai: bad, persuasive: bad, fits_channel: bad },
});

describe("the judge hand-off", () => {
  it("keeps the key outside the folder judges read, and no candidate name inside it", () => {
    const b = batch();
    assert.deepEqual(readdirSync(join(b.dir, "judge")).sort(), ["batch.md", "scores.template.json"]);
    const seen = readFileSync(join(b.dir, "judge", "batch.md"), "utf8") + readFileSync(join(b.dir, "judge", "scores.template.json"), "utf8");
    assert.doesNotMatch(seen, /haiku|calibration|good|flat/i);
    assert.equal(Object.keys(b.key).length, 4);
  });

  it("proves a judge that ranks the trio good over flat over bad", () => {
    const b = batch();
    assert.equal(calibrationGate(b.key, readScores(b.key, draftScores(5, 3, 1, b))).proven, true);
  });

  it("doesn't prove a judge that ties or flips the trio", () => {
    const b = batch();
    assert.equal(calibrationGate(b.key, readScores(b.key, draftScores(4, 4, 1, b))).proven, false);
    assert.equal(calibrationGate(b.key, readScores(b.key, draftScores(2, 3, 1, b))).proven, false);
  });

  it("refuses a score file that misses an item or scores outside 1 to 5", () => {
    const b = batch();
    const { [b.chat]: _, ...missing } = draftScores(5, 3, 1, b);
    assert.throws(() => readScores(b.key, missing), /has no scores/);
    assert.throws(() => readScores(b.key, { ...draftScores(5, 3, 1, b), [b.chat]: { helpful: 6, natural_thai: 4 } }), /helpful is 6/);
  });

  it("stores ingested scores per judge", () => {
    const b = batch();
    const file = join(b.dir, "in.json");
    writeFileSync(file, JSON.stringify(draftScores(5, 3, 1, b)));
    assert.equal(ingestScores(b.dir, "sonnet-judge", file).proven, true);
    assert.ok(readdirSync(join(b.dir, "scores")).includes("sonnet-judge.json"));
  });
});

describe("the calibration trio against the deterministic checks", () => {
  const facts = CASES.find((c) => c.id === CALIBRATION_CASE)?.make("2026-11-29T10:00" as Wall).checks.find((c) => c.kind === "facts");
  const passes = (text: string) => grade(facts!, { text, wakeups: [], rejected: [], files: {}, page: null }).pass;
  it("the good and the flat draft carry every fact", () => {
    assert.equal(passes(CALIBRATION.good), true);
    assert.equal(passes(CALIBRATION.flat), true);
  });
  it("the bad draft gets facts wrong", () => assert.equal(passes(CALIBRATION.bad), false));
  it("buy one get one passes however the free cup is phrased", () => {
    const rest = "บ้านดอยคอฟฟี่ ลาเต้เย็น ปกติแก้วละ 65 บาท 1–7 ธันวาคม เฉพาะหน้าร้าน สาขานิมมาน";
    for (const deal of ["ซื้อ 1 แถม 1", "ซื้อลาเต้เย็น 1 แก้ว (ปกติแก้วละ 65 บาท) แถมอีก 1 แก้ว!", "ซื้อ 1 แก้ว ได้ฟรีอีก 1 แก้ว"]) assert.equal(passes(`${deal} ${rest}`), true, deal);
    assert.equal(passes(`ลด 10% ${rest}`), false);
  });
});
