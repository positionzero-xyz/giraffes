import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** The parsed body, or undefined when it is not JSON or is too large. */
export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes <= MAX_BODY_BYTES) chunks.push(c);
    });
    req.on("end", () => {
      if (bytes > MAX_BODY_BYTES) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
