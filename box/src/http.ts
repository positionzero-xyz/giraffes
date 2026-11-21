import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_SIGNIN_BYTES = 4096;
const SIGNIN_READ_MS = 10_000;

function parseJson(chunks: Buffer[]): unknown {
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes <= MAX_BODY_BYTES) chunks.push(c);
    });
    req.on("end", () => {
      resolve(bytes > MAX_BODY_BYTES ? undefined : parseJson(chunks));
    });
    req.on("error", reject);
  });
}

type SigninBody = { readonly kind: "json"; readonly body: unknown } | { readonly kind: "too_large" | "timed_out" };

export function readSigninJson(req: IncomingMessage): Promise<SigninBody> {
  if (Number(req.headers["content-length"]) > MAX_SIGNIN_BYTES) return Promise.resolve({ kind: "too_large" });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_SIGNIN_BYTES) finish({ kind: "too_large" });
      else chunks.push(chunk);
    };
    const onEnd = () => finish({ kind: "json", body: parseJson(chunks) });
    const cleanup = () => {
      clearTimeout(timer);
      req.pause().off("data", onData).off("end", onEnd);
    };
    const finish = (result: SigninBody) => {
      cleanup();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: "timed_out" }), SIGNIN_READ_MS);
    req.on("data", onData).once("end", onEnd).once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
