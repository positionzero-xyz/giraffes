import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PageReport, PersistReport } from "./types.ts";

const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
];

export function findChrome(given?: string): string | null {
  if (given) return existsSync(given) ? given : null;
  return CANDIDATES.find((c) => existsSync(c)) ?? null;
}

const MARK = "ทดสอบ7319";

const FILL_AND_SUBMIT = `(() => {
  const mark = ${JSON.stringify(MARK)};
  const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const skip = new Set(["hidden", "submit", "button", "reset", "checkbox", "radio", "file", "image"]);
  const fields = [...document.querySelectorAll("input, textarea, select")].filter((el) => visible(el) && !skip.has((el.type || "").toLowerCase()) && !el.disabled);
  if (fields.length === 0) return { ok: false, reason: "no fields to fill" };
  let texts = 0;
  for (const el of fields) {
    const type = (el.type || "text").toLowerCase();
    let value = mark;
    if (el.tagName === "SELECT") value = el.options[el.options.length > 1 ? 1 : 0]?.value ?? "";
    else if (type === "date") value = "2026-12-20";
    else if (type === "time") value = "14:30";
    else if (type === "datetime-local") value = "2026-12-20T14:30";
    else if (type === "number" || type === "range") value = "123";
    else if (type === "tel") value = "0812345678";
    else if (type === "email") value = "test@example.com";
    else texts++;
    const proto = el.tagName === "SELECT" ? HTMLSelectElement : el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (texts === 0) return { ok: false, reason: "no text field for the marker" };
  const buttons = [...document.querySelectorAll("button, input[type=submit], input[type=button]")].filter(visible);
  const label = (b) => (b.innerText || b.value || "").trim();
  const button =
    buttons.find((b) => b.type === "submit" && b.form) ??
    buttons.find((b) => /จอง|บันทึก|เพิ่ม|ยืนยัน|ส่ง|save|add|book|submit/i.test(label(b))) ??
    buttons[0];
  if (!button) return { ok: false, reason: "no button to press" };
  button.click();
  return { ok: true, reason: "pressed " + JSON.stringify(label(button).slice(0, 30)) + " after filling " + fields.length + " fields" };
})()`;

const AFTER_RELOAD = `(() => {
  const mark = ${JSON.stringify(MARK)};
  const stored = Object.keys(localStorage).some((k) => (localStorage.getItem(k) || "").includes(mark));
  return { stored, shown: document.body.innerText.includes(mark) };
})()`;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class Page {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, Pending>();
  #waiters: { method: string; resolve: () => void }[] = [];
  readonly errors: string[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (m) => this.#on(JSON.parse(String(m.data))));
  }

  static async open(wsUrl: string): Promise<Page> {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("devtools socket failed")), { once: true });
    });
    const page = new Page(ws);
    await Promise.all(["Runtime.enable", "Log.enable", "Page.enable"].map((m) => page.send(m)));
    return page;
  }

  #on(msg: { id?: number; method?: string; params?: any; result?: any; error?: { message: string } }) {
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") this.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") this.errors.push(msg.params.args.map((a: any) => a.value ?? a.description ?? "").join(" "));
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") this.errors.push(msg.params.entry.text);
    for (const w of this.#waiters.filter((w) => w.method === msg.method)) w.resolve();
    this.#waiters = this.#waiters.filter((w) => w.method !== msg.method);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  event(method: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.#waiters.push({ method, resolve: () => (clearTimeout(timer), resolve(true)) });
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  close() {
    this.#ws.close();
  }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function launch(chrome: string, profile: string): Promise<{ proc: ChildProcess; port: number }> {
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => reject(new Error(`browser did not start: ${err.slice(0, 200)}`)), 20_000);
    proc.stderr?.on("data", (c: Buffer) => {
      err += c;
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, port: Number(m[1]) });
      }
    });
    proc.on("error", (e) => reject(e));
  });
}

async function stop(proc: ChildProcess, profile: string) {
  const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once("exit", r));
  if (process.platform === "win32" && proc.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(proc.pid)]);
  else proc.kill("SIGKILL");
  await exited;
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
  }
}

export async function inspect(chrome: string, file: string, drive: boolean): Promise<PageReport> {
  const profile = mkdtempSync(join(tmpdir(), "eval-chrome-"));
  const { proc, port } = await launch(chrome, profile);
  try {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const target = targets.find((t) => t.type === "page");
    if (!target) return { loaded: false, errors: ["no page target"], text: "", persist: null };
    const page = await Page.open(target.webSocketDebuggerUrl);
    try {
      const url = pathToFileURL(file).href;
      const loadedEvent = page.event("Page.loadEventFired", 15_000);
      await page.send("Page.navigate", { url });
      if (!(await loadedEvent)) return { loaded: false, errors: ["load timed out"], text: "", persist: null };
      await settle(500);
      const text = await page.eval<string>("document.body ? document.body.innerText : ''");
      let persist: PersistReport | null = null;
      if (drive) {
        const pressed = await page.eval<{ ok: boolean; reason: string }>(FILL_AND_SUBMIT);
        if (!pressed.ok) persist = { ok: false, shown: false, reason: pressed.reason };
        else {
          await settle(800);
          const reloaded = page.event("Page.loadEventFired", 15_000);
          await page.send("Page.navigate", { url });
          await reloaded;
          await settle(500);
          const after = await page.eval<{ stored: boolean; shown: boolean }>(AFTER_RELOAD);
          persist = { ok: after.stored, shown: after.shown, reason: after.stored ? `${pressed.reason}; kept after reload` : `${pressed.reason}; nothing saved` };
        }
      }
      return { loaded: true, errors: [...page.errors], text, persist };
    } finally {
      page.close();
    }
  } finally {
    await stop(proc, profile);
  }
}
