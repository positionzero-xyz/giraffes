import { readdirSync, readFileSync } from "node:fs";

function read(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function parents() {
  const map = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const stat = read(`/proc/${name}/stat`);
    if (!stat) continue;
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    map.set(Number(name), Number(fields[1]));
  }
  return map;
}

export function tree(root, includeRoot) {
  const ppid = parents();
  const out = includeRoot && ppid.has(root) ? [root] : [];
  const frontier = [root];
  while (frontier.length) {
    const p = frontier.pop();
    for (const [pid, parent] of ppid) if (parent === p) { out.push(pid); frontier.push(pid); }
  }
  return out;
}

const kb = (text, key) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text ?? "")?.[1] ?? 0);

export function sampleTree(root, includeRoot) {
  let pss = 0, rss = 0, hwm = 0;
  const pids = tree(root, includeRoot);
  const comms = [];
  for (const pid of pids) {
    const rollup = read(`/proc/${pid}/smaps_rollup`);
    if (!rollup) continue;
    pss += kb(rollup, "Pss");
    rss += kb(rollup, "Rss");
    hwm = Math.max(hwm, kb(read(`/proc/${pid}/status`), "VmHWM"));
    comms.push(read(`/proc/${pid}/comm`)?.trim());
  }
  return { pids: pids.length, comms, pssKb: pss, rssKb: rss, maxVmHwmKb: hwm };
}

export function watchTree(root, includeRoot, everyMs = 10) {
  const peak = { pssKb: 0, rssKb: 0, maxVmHwmKb: 0, pids: 0, samples: 0, comms: new Set() };
  const timer = setInterval(() => {
    const s = sampleTree(root, includeRoot);
    peak.samples++;
    peak.pssKb = Math.max(peak.pssKb, s.pssKb);
    peak.rssKb = Math.max(peak.rssKb, s.rssKb);
    peak.maxVmHwmKb = Math.max(peak.maxVmHwmKb, s.maxVmHwmKb);
    peak.pids = Math.max(peak.pids, s.pids);
    for (const c of s.comms) peak.comms.add(c);
  }, everyMs);
  return () => {
    clearInterval(timer);
    return { ...peak, comms: [...peak.comms] };
  };
}
