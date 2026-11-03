import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { verifyBearer, verifyTicket } from "./auth.ts";
import { authStatus, cliVersion, parseTurn, readParseRequest, spawnClaude, type Cli, type TurnReply } from "./claude.ts";
import { readJson, sendJson } from "./http.ts";

export type BoxOptions = { readonly token: string; readonly cli: Cli; readonly now?: () => number };

const SIGNIN_TTL_MS = 10 * 60_000;
const URL_WAIT_MS = 30_000;
const CODE_EXIT_WAIT_MS = 60_000;
const KILL_WAIT_MS = 5_000;
const SIGNIN_HOSTS = new Set(["claude.com", "claude.ai", "platform.claude.com"]);
const MAX_CODE_LENGTH = 1024;
const PAGE = readFileSync(new URL("./signin.html", import.meta.url));
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
type Login = { readonly proc: ChildProcessWithoutNullStreams; readonly expiresAt: number; output: string; exited: boolean; completing: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(50);
}

function signinUrl(output: string): string | undefined {
  for (const [link] of output.matchAll(/https:\/\/[^\s"'<>\x1b]+(?=\s)/g)) {
    if (URL.canParse(link) && SIGNIN_HOSTS.has(new URL(link).hostname)) return link;
  }
  return undefined;
}

export function createBox({ token, cli, now = Date.now }: BoxOptions): Server {
  let login: Login | null = null;
  let turns: Promise<unknown> = Promise.resolve();
  let version: string | null = null;

  function oneTurnAtATime(run: () => Promise<TurnReply>): Promise<TurnReply> {
    const next = turns.then(run);
    turns = next.catch(() => {});
    return next;
  }

  function stopLogin(): void {
    login?.proc.kill("SIGKILL");
    login = null;
  }

  function startLogin(): Login {
    stopLogin();
    const proc = spawnClaude(cli, ["auth", "login", "--claudeai"], { ...process.env, BROWSER: "true" });
    const started: Login = { proc, expiresAt: now() + SIGNIN_TTL_MS, output: "", exited: false, completing: false };
    const append = (c: Buffer) => (started.output += c.toString("utf8"));
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);
    const exited = () => {
      started.exited = true;
      if (login === started) login = null;
    };
    proc.on("error", exited);
    proc.on("close", (code) => {
      exited();
      console.log(`sign-in process exited (${code})`);
    });
    setTimeout(() => proc.kill("SIGKILL"), SIGNIN_TTL_MS).unref();
    login = started;
    return started;
  }

  async function health(res: ServerResponse): Promise<void> {
    const status = await authStatus(cli);
    if (!status) return sendJson(res, 502, { error: "claude_failed" });
    version ??= await cliVersion(cli);
    sendJson(res, 200, { ok: true, signedIn: status.loggedIn, authMethod: status.authMethod, version: version ?? "unknown" });
  }

  async function parse(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = readParseRequest(await readJson(req));
    if (!parsed) return sendJson(res, 400, { error: "bad_request" });
    const reply = await oneTurnAtATime(() => parseTurn(cli, parsed));
    sendJson(res, reply.status, reply.body);
  }

  async function signinStart(res: ServerResponse): Promise<void> {
    if (login?.completing) return sendJson(res, 409, { error: "busy" });
    const started = startLogin();
    console.log("sign-in started");
    await waitUntil(() => signinUrl(started.output) !== undefined || started.exited, URL_WAIT_MS);
    const url = signinUrl(started.output);
    if (url === undefined) {
      if (login === started) stopLogin();
      return sendJson(res, 502, { error: "signin_failed" });
    }
    sendJson(res, 200, { url });
  }

  async function signinCode(raw: unknown, res: ServerResponse): Promise<void> {
    const code = typeof raw === "string" ? raw.trim() : "";
    if (!code || code.length > MAX_CODE_LENGTH || /[\r\n]/.test(code)) return sendJson(res, 400, { error: "bad_code" });
    const pending = login;
    if (pending?.completing) return sendJson(res, 409, { error: "busy" });
    if (!pending || now() >= pending.expiresAt) {
      stopLogin();
      return sendJson(res, 409, { error: "no_signin" });
    }
    pending.completing = true;
    const mark = pending.output.length;
    pending.proc.stdin.write(`${code}\n`);
    // A code the CLI can't read makes it ask again instead of exiting.
    await waitUntil(() => pending.exited || pending.output.includes("Invalid code", mark), CODE_EXIT_WAIT_MS);
    if (!pending.exited) pending.proc.kill("SIGKILL");
    await waitUntil(() => pending.exited, KILL_WAIT_MS);
    const signedIn = (await authStatus(cli))?.loggedIn === true;
    console.log(`sign-in code sent, signed in: ${signedIn}`);
    sendJson(res, 200, { signedIn });
  }

  const withBearer =
    (handler: Handler): Handler =>
    (req, res) =>
      verifyBearer(req.headers.authorization, token) ? handler(req, res) : sendJson(res, 401, { error: "unauthorized" });

  const withTicket =
    (handler: (fields: Record<string, unknown>, res: ServerResponse) => Promise<void>): Handler =>
    async (req, res) => {
      const body = await readJson(req);
      const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      if (!verifyTicket(fields.ticket, token, now())) return sendJson(res, 401, { error: "unauthorized" });
      await handler(fields, res);
    };

  const routes = new Map<string, Handler>([
    ["GET /health", withBearer((_, res) => health(res))],
    ["POST /parse", withBearer(parse)],
    ["GET /signin", (_, res) => void res.writeHead(200, PAGE_HEADERS).end(PAGE)],
    ["POST /signin/start", withTicket((_, res) => signinStart(res))],
    ["POST /signin/code", withTicket((fields, res) => signinCode(fields.code, res))],
  ]);

  const server = createServer((req, res) => {
    const handler = routes.get(`${req.method} ${new URL(req.url ?? "/", "http://box").pathname}`);
    if (!handler) return sendJson(res, 404, { error: "not_found" });
    Promise.resolve(handler(req, res)).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    });
  });
  server.on("close", stopLogin);
  return server;
}
