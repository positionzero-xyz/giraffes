import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AFTER_RELOAD, SNAPSHOT, clickItem, fillAndSubmit, formEvidence, switchView, type Submit } from "./browser-dom.ts";
import { ORDER_MENU } from "./cases.ts";
import { totalIn } from "./page-text.ts";
import type { FormDrive, PageDrive, PageReport, PersistReport } from "./types.ts";

export { AMOUNT } from "./browser-dom.ts";
export { totalIn } from "./page-text.ts";

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

type Message = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message: string };
  params?: {
    exceptionDetails?: { exception?: { description?: string }; text: string };
    type?: string;
    args?: { value?: unknown; description?: string }[];
    entry?: { level: string; text: string };
  };
};
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Evaluation<T> = { result: { value: T }; exceptionDetails?: { exception?: { description: string }; text: string } };

class Page {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, Pending>();
  #waiters = new Map<string, () => void>();
  readonly errors: string[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (m) => this.#on(JSON.parse(String(m.data))));
    ws.addEventListener("close", () => {
      for (const p of this.#pending.values()) p.reject(new Error("devtools socket closed"));
      this.#pending.clear();
    });
  }

  static async open(wsUrl: string): Promise<Page> {
    const ws = new WebSocket(wsUrl);
    try {
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new Error("devtools socket failed")), { once: true });
      });
      const page = new Page(ws);
      await Promise.all(["Runtime.enable", "Log.enable", "Page.enable"].map((m) => page.send(m)));
      return page;
    } catch (error) {
      ws.close();
      throw error;
    }
  }

  #on(msg: Message) {
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    const details = msg.params?.exceptionDetails;
    if (msg.method === "Runtime.exceptionThrown" && details) this.errors.push(details.exception?.description ?? details.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") this.errors.push(msg.params.args?.map((a) => a.value ?? a.description).join(" ") ?? "console error");
    if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") this.errors.push(msg.params.entry.text);
    this.#waiters.get(msg.method)?.();
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async load(method: "Page.navigate" | "Page.reload", params: Record<string, unknown> = {}): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 15_000);
      this.#waiters.set("Page.loadEventFired", () => resolve(true));
    });
    try {
      await this.send(method, params);
      return await loaded;
    } finally {
      clearTimeout(timer);
      this.#waiters.delete("Page.loadEventFired");
    }
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }) as Evaluation<T>;
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  close() {
    this.#ws.close();
  }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function launch(proc: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => reject(new Error(`browser did not start: ${err.slice(0, 200)}`)), 20_000);
    proc.stderr?.on("data", (c: Buffer) => {
      err += c;
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err);
      if (!m) return;
      clearTimeout(timer);
      resolve(Number(m[1]));
    });
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited ${code}: ${err.slice(0, 200)}`));
    });
  });
}

async function stop(proc: ChildProcess, profile: string) {
  if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise((r) => proc.once("exit", r));
    if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(proc.pid)]);
    else proc.kill("SIGKILL");
    await exited;
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

type Snapshot = { text: string; groups: string[] };

async function driveForm(page: Page, drive: FormDrive, totalBefore: number | null): Promise<PersistReport> {
  const failure = (reason: string) => ({ ok: false, shown: false, reason, missing: [], totalBefore, totalAfter: null });
  const submitted = await page.eval<Submit>(fillAndSubmit(drive));
  if (!submitted.ok) return failure(submitted.reason);
  await settle(350);
  if (!await page.load("Page.reload")) return failure("reload did not finish");
  await settle(250);
  const after = await page.eval<{ stored: string[]; rows: string[]; groups: string[] }>(AFTER_RELOAD);
  const facts = formEvidence(submitted.entered, after.stored, after.rows);
  return {
    ok: facts.complete, shown: facts.shown, reason: facts.reason,
    missing: facts.complete ? [] : facts.missing, totalBefore, totalAfter: totalIn(after.groups),
  };
}

async function driveOrder(page: Page): Promise<NonNullable<PageReport["order"]>> {
  let expected = 0;
  const chosen: (typeof ORDER_MENU)[number][] = [];
  for (const dish of ORDER_MENU) {
    if (chosen.length) {
      if (!await page.eval<boolean>(switchView("menu"))) return { ok: false, detail: "no link back to the menu" };
      await settle(150);
    }
    if (!await page.eval<boolean>(clickItem(dish.any))) return { ok: false, detail: `no add action for ${dish.label}` };
    const menu = await page.eval<Snapshot>(SNAPSHOT);
    if (!await page.eval<boolean>(switchView("order"))) return { ok: false, detail: "no link to the order view" };
    await settle(150);
    chosen.push(dish);
    expected += dish.price;
    const view = await page.eval<Snapshot>(SNAPSHOT);
    const total = totalIn(view.groups);
    if (view.text === menu.text || total !== expected || !chosen.every((item) => item.any.some((name) => view.text.includes(name)))) {
      return { ok: false, detail: `order view after adding ${dish.label}: total ${total ?? "missing"}, expected ${expected} with all selected items` };
    }
  }
  return { ok: true, detail: `order view shows both items and a running total of ${expected}` };
}

export async function inspect(chrome: string, file: string, drive: PageDrive | null): Promise<PageReport> {
  const profile = mkdtempSync(join(tmpdir(), "giraffe-chrome-"));
  const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
  });
  try {
    const port = await launch(proc);
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const target = targets.find((t) => t.type === "page");
    if (!target) return { loaded: false, errors: ["no page target"], text: "", persist: null };
    const page = await Page.open(target.webSocketDebuggerUrl);
    try {
      if (!await page.load("Page.navigate", { url: pathToFileURL(file).href })) {
        return { loaded: false, errors: ["load timed out"], text: "", persist: null };
      }
      await settle(250);
      const { text, groups } = await page.eval<Snapshot>(SNAPSHOT);
      const order = drive === "order" ? await driveOrder(page) : undefined;
      const persist = drive && drive !== "order" ? await driveForm(page, drive, totalIn(groups)) : null;
      return { loaded: true, errors: [...page.errors], text, priceGroups: groups, persist, order };
    } finally {
      page.close();
    }
  } finally {
    await stop(proc, profile);
  }
}
