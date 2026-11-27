import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitest = path.join(app, "node_modules", "vitest", "vitest.mjs");
const probes = ["do-waituntil", "rpc-rejection"];
const failures = [];

for (const name of probes) {
  const source = path.join(app, "test", "runtime-probes", `${name}.probe.ts`);
  const generatedName = `runtime-${name}-${process.pid}.generated.test.ts`;
  const generated = path.join(app, "test", generatedName);
  writeFileSync(generated, readFileSync(source, "utf8").replaceAll("../../src/", "../src/"));
  let result;
  try {
    result = spawnSync(process.execPath, [vitest, "run", path.join("test", generatedName)], {
      cwd: app,
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
      timeout: 120_000,
    });
  } finally {
    rmSync(generated, { force: true });
  }

  const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`;
  const problems = [];
  if (!result) {
    problems.push("the probe process did not run to completion");
  } else {
    if (result.status === 0) problems.push("expected a nonzero exit");
    if (result.status === null) problems.push("the probe process did not exit normally");
    if (result.error) problems.push(String(result.error));
  }
  if (!output.includes("uncaught exception")) problems.push("workerd did not emit the expected runtime probe output");
  if (problems.length) {
    const tail = output.trim().split("\n").slice(-20).join("\n");
    failures.push(`${name}: ${problems.join("; ")}\n${tail}`);
  }
}

if (failures.length) {
  console.error(`runtime guard probes failed:\n${failures.join("\n\n")}`);
  process.exitCode = 1;
} else {
  console.log(`runtime guard probes passed (${probes.length} negative probes rejected)`);
}
