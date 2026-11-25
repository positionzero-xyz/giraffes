import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readTicket, verifyBearer, type SigninTicket } from "./auth.ts";
import { agentTurn, authStatus, cliVersion, parseTurn, readAgentRequest, readParseRequest, spawnClaude, type Cli } from "./claude.ts";
import { diagnostic } from "./diagnostics.ts";
import { readJson, readSigninJson, sendJson } from "./http.ts";

export type BoxOptions = { readonly token: string; readonly cli: Cli; readonly sessionFile: string; readonly now?: () => number };

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
type Login = { readonly proc: ChildProcessWithoutNullStreams; readonly ticket: string; readonly expiresAt: number; output: string; exited: boolean; completing: boolean };

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

export function createBox({ token, cli, sessionFile, now = Date.now }: BoxOptions): Server {
  let login: Login | null = null;
  const usedTickets = new Map<string, number>();
  let turns: Promise<unknown> = Promise.resolve();
  let version: string | null = null;

  function oneTurnAtATime<R>(run: () => Promise<R>): Promise<R> {
    const next = turns.then(run);
    turns = next.catch(() => {});
    return next;
  }

  function stopLogin(): void {
    login?.proc.kill("SIGKILL");
    login = null;
  }

  function startLogin(ticket: SigninTicket): Login {
    stopLogin();
    const proc = spawnClaude(cli, ["auth", "login", "--claudeai"], { ...process.env, BROWSER: "true" });
    const started: Login = { proc, ticket: ticket.value, expiresAt: now() + SIGNIN_TTL_MS, output: "", exited: false, completing: false };
    const append = (c: Buffer) => (started.output += c.toString("utf8"));
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);
    const exited = () => {
      started.exited = true;
      if (login === started && !started.completing) login = null;
    };
    proc.on("error", exited);
    proc.on("close", (code) => {
      exited();
      diagnostic({ code: "signin_exit", exit: code });
    });
    const timeout = setTimeout(() => proc.kill("SIGKILL"), SIGNIN_TTL_MS).unref();
    proc.once("close", () => clearTimeout(timeout));
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
    const abandoned = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abandoned.abort();
    });
    const reply = await oneTurnAtATime(() => parseTurn(cli, parsed, abandoned.signal));
    sendJson(res, reply.status, reply.body);
  }

  async function agent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = readAgentRequest(await readJson(req));
    if (!parsed) return sendJson(res, 400, { error: "bad_request" });
    const abandoned = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abandoned.abort();
    });
    const reply = await oneTurnAtATime(async () => {
      if (parsed.session !== undefined) {
        const named = await agentTurn(cli, parsed, abandoned.signal);
        if (named.status === 200 && parsed.session !== null) writeFileSync(sessionFile, named.body.session.id);
        return named;
      }
      const session = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8").trim() || null : null;
      const result = await agentTurn(cli, { ...parsed, session }, abandoned.signal);
      if (result.status === 200 && !result.body.session.resumed) writeFileSync(sessionFile, result.body.session.id);
      return result;
    });
    sendJson(res, reply.status, reply.body);
  }

  async function signinStart(ticket: SigninTicket, res: ServerResponse): Promise<void> {
    if (login?.completing) return sendJson(res, 409, { error: "busy" });
    const at = now();
    for (const [used, expiresAt] of usedTickets) if (expiresAt <= at) usedTickets.delete(used);
    if (usedTickets.has(ticket.value)) return sendJson(res, 409, { error: "used_ticket" });
    usedTickets.set(ticket.value, ticket.expiresAt);
    const started = startLogin(ticket);
    diagnostic({ code: "signin_started" });
    await waitUntil(() => signinUrl(started.output) !== undefined || started.exited, URL_WAIT_MS);
    const url = signinUrl(started.output);
    if (login !== started || url === undefined) {
      if (login === started) stopLogin();
      return sendJson(res, 502, { error: "signin_failed" });
    }
    sendJson(res, 200, { url });
  }

  async function signinCode(ticket: SigninTicket, raw: unknown, res: ServerResponse): Promise<void> {
    const code = typeof raw === "string" ? raw.trim() : "";
    if (!code || code.length > MAX_CODE_LENGTH || /[\r\n]/.test(code)) return sendJson(res, 400, { error: "bad_code" });
    const pending = login;
    if (!pending || pending.ticket !== ticket.value) return sendJson(res, 409, { error: "no_signin" });
    if (pending.completing) return sendJson(res, 409, { error: "busy" });
    if (now() >= pending.expiresAt) {
      stopLogin();
      return sendJson(res, 409, { error: "no_signin" });
    }
    pending.completing = true;
    try {
      const mark = pending.output.length;
      pending.proc.stdin.write(`${code}\n`);
      // A code the CLI can't read makes it ask again instead of exiting.
      await waitUntil(() => pending.exited || pending.output.includes("Invalid code", mark), CODE_EXIT_WAIT_MS);
      if (!pending.exited) pending.proc.kill("SIGKILL");
      await waitUntil(() => pending.exited, KILL_WAIT_MS);
      const signedIn = (await authStatus(cli))?.loggedIn === true;
      diagnostic({ code: "signin_complete", signedIn });
      sendJson(res, 200, { signedIn });
    } finally {
      if (login === pending) stopLogin();
    }
  }

  const withBearer =
    (handler: Handler): Handler =>
    (req, res) =>
      verifyBearer(req.headers.authorization, token) ? handler(req, res) : sendJson(res, 401, { error: "unauthorized" });

  const withTicket =
    (handler: (ticket: SigninTicket, fields: Record<string, unknown>, res: ServerResponse) => Promise<void>): Handler =>
    async (req, res) => {
      const result = await readSigninJson(req);
      if (result.kind !== "json") {
        res.setHeader("connection", "close");
        return result.kind === "too_large" ? sendJson(res, 413, { error: "body_too_large" }) : sendJson(res, 408, { error: "request_timeout" });
      }
      const { body } = result;
      const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      const ticket = readTicket(fields.ticket, token, now());
      if (!ticket) return sendJson(res, 401, { error: "unauthorized" });
      await handler(ticket, fields, res);
    };

  const routes = new Map<string, Handler>([
    ["GET /health", withBearer((_, res) => health(res))],
    ["POST /parse", withBearer(parse)],
    ["POST /agent", withBearer(agent)],
    ["GET /signin", (_, res) => void res.writeHead(200, PAGE_HEADERS).end(PAGE)],
    ["POST /signin/start", withTicket((ticket, _, res) => signinStart(ticket, res))],
    ["POST /signin/code", withTicket((ticket, fields, res) => signinCode(ticket, fields.code, res))],
  ]);

  const server = createServer((req, res) => {
    const target = URL.parse(req.url ?? "/", "http://box");
    if (!target) return sendJson(res, 400, { error: "bad_request" });
    const handler = routes.get(`${req.method} ${target.pathname}`);
    if (!handler) return sendJson(res, 404, { error: "not_found" });
    Promise.resolve().then(() => handler(req, res)).catch(() => {
      diagnostic({ code: "route_failed" });
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    });
  });
  server.on("close", stopLogin);
  return server;
}
