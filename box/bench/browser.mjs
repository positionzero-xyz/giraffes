import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { sampleTree, watchTree } from "./proc-tree.mjs";

const [runs, outFile, sandbox, ...urls] = [Number(process.argv[2]), process.argv[3], process.argv[4], ...process.argv.slice(5)];
const QUIET_MS = 2000;
const CAP_MS = 45_000;
const AFTER_LOAD_MS = 15_000;

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    else for (const l of listeners) l(msg);
  };
  return {
    send: (method, params = {}) => new Promise((resolve) => { const n = ++id; waiting.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); }),
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

async function load(url, port) {
  const dir = mkdtempSync("/tmp/chrome-");
  const args = ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--disable-dev-shm-usage", "--no-first-run", "--disable-gpu", ...(sandbox === "nosandbox" ? ["--no-sandbox"] : []), "about:blank"];
  const chrome = spawn("chromium", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", (c) => (stderr += c));
  const stop = watchTree(chrome.pid, true, 100);
  const t0 = Date.now();
  try {
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      target = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((ts) => ts.find((t) => t.type === "page")).catch(() => null);
      if (!target) await sleep(100);
    }
    if (!target) throw new Error(`chromium never served CDP: ${stderr.slice(0, 500)}`);
    const page = await cdp(target.webSocketDebuggerUrl);
    let inflight = 0, lastActivity = Date.now(), loadedAt = 0, requests = 0, failed = 0, docStatus = null, docError = null, docId = null;
    page.on((m) => {
      if (m.method === "Network.requestWillBeSent") { inflight++; requests++; lastActivity = Date.now(); }
      if (m.method === "Network.loadingFinished") { inflight--; lastActivity = Date.now(); }
      if (m.method === "Network.loadingFailed") { inflight--; failed++; lastActivity = Date.now(); if (m.params.requestId === docId) docError = m.params.errorText; }
      if (m.method === "Network.requestWillBeSent" && m.params.type === "Document" && docId === null) docId = m.params.requestId;
      if (m.method === "Network.responseReceived" && m.params.type === "Document" && docStatus === null) docStatus = m.params.response.status;
      if (m.method === "Page.loadEventFired" && !loadedAt) loadedAt = Date.now();
    });
    await page.send("Network.enable");
    await page.send("Page.enable");
    await page.send("Page.navigate", { url });
    while (Date.now() - t0 < CAP_MS && !(loadedAt && ((inflight <= 0 && Date.now() - lastActivity > QUIET_MS) || Date.now() - loadedAt > AFTER_LOAD_MS))) await sleep(100);
    const settleMs = Date.now() - t0;
    const quiet = loadedAt > 0 && inflight <= 0 && Date.now() - lastActivity > QUIET_MS;
    const settled = [];
    for (let i = 0; i < 5; i++) { settled.push(sampleTree(chrome.pid, true)); await sleep(200); }
    const info = await page.send("Runtime.evaluate", { expression: "JSON.stringify({title: document.title, href: location.href, ready: document.readyState, bytes: document.documentElement.outerHTML.length})", returnByValue: true });
    page.close();
    const peak = stop();
    const pss = settled.map((s) => s.pssKb).sort((a, b) => a - b)[2];
    return { ok: loadedAt > 0 && docStatus === 200, settleMs, loadMs: loadedAt ? loadedAt - t0 : null, quiet, timedOut: settleMs >= CAP_MS, docStatus, docError, requests, failed, page: JSON.parse(info.result.result.value ?? "{}"), processes: settled[2].pids, settledTreePssKb: pss, settledTreeRssKb: settled[2].rssKb, peakTreePssKb: peak.pssKb };
  } finally {
    chrome.kill("SIGKILL");
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
}

let port = 9300;
for (let i = 0; i < runs; i++) {
  for (const url of urls) {
    const timeout = sleep(CAP_MS + 20_000).then(() => { throw new Error("run timed out"); });
    const r = await Promise.race([load(url, port++), timeout]).catch((e) => ({ ok: false, error: String(e) }));
    const row = { plan: "browser", run: i + 1, side: new URL(url).host, sandbox, ...r };
    appendFileSync(outFile, JSON.stringify(row) + "\n");
    console.log(JSON.stringify(row));
  }
}
