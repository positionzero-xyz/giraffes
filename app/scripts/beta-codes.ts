import { COHORTS, HALVES, newInviteCode, type Cohort, type Half } from "../src/domain.ts";
import { betaStartSql } from "../src/ledger/beta-start.ts";

const [cohort, half, count, ...rest] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const usage = "usage: node scripts/beta-codes.ts <recruit|staff> <th_line|intl_telegram|-> <count> [--start <ISO time> [--force]]";
if (!COHORTS.some((c) => c === cohort) || cohort === "joiner") fail(`${usage}\nJoiner codes come from /invite.`);
if (half !== "-" && !HALVES.some((h) => h === half)) fail(usage);
const n = Number(count);
if (!Number.isInteger(n) || n < 1 || n > 500) fail(`${usage}\ncount is a whole number from 1 to 500`);

const now = Date.now();
const sql = (v: string | null) => (v === null ? "NULL" : `'${v}'`);
const values = Array.from({ length: n }, () => `(${sql(newInviteCode())}, ${sql(cohort as Cohort)}, ${sql(half === "-" ? null : (half as Half))}, 'operator', ${now})`);
console.log(`INSERT INTO invite_code (code, cohort, half, issuer, created_at) VALUES\n  ${values.join(",\n  ")};`);

const at = rest.indexOf("--start");
if (at !== -1) {
  const start = Date.parse(rest[at + 1] ?? "");
  if (Number.isNaN(start)) fail("--start takes an ISO time, such as 2026-11-16T00:00:00+07:00");
  const force = rest.includes("--force");
  console.log(betaStartSql(start, force).join("\n"));
  if (!force) console.error("--start keeps a start that is already set; the first statement's result shows the old and new dates. Pass --force to move it.");
}
