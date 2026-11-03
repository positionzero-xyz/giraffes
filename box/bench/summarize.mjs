import { readFileSync } from "node:fs";

const METRICS = ["wallMs", "launchToFirstRequestMs", "peakTreePssKb", "peakTreeRssKb", "maxVmHwmKb", "settledTreePssKb", "peakTreePssKb", "firstRequestBytes", "totalBytes", "requests", "processes"];
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

for (const file of process.argv.slice(2)) {
  const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .map((r) => ({ ...r, firstRequestBytes: r.bytes?.[0], totalBytes: r.bytes?.reduce((a, b) => a + b, 0) }));
  const bySide = Object.groupBy(rows, (r) => r.side);
  console.log(`# ${file}`);
  for (const [side, rs] of Object.entries(bySide)) {
    const errors = rs.filter((r) => !r.ok).length;
    const parts = [...new Set(METRICS)].filter((m) => rs.every((r) => typeof r[m] === "number"))
      .map((m) => { const xs = rs.map((r) => r[m]); return `${m} ${median(xs)} [${Math.min(...xs)}..${Math.max(...xs)}]`; });
    console.log(`${side}: n=${rs.length} errors=${errors} ${parts.join(", ")}`);
  }
}
