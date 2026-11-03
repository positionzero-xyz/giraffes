/** A Worker can't spawn processes, so the Worker's `bridgeModel` POSTs here. It runs the same turn as the box's /parse, without auth. */
import { createServer } from "node:http";
import { parseTurn, readParseRequest, type Cli } from "../../box/src/claude.ts";
import { readJson, sendJson } from "../../box/src/http.ts";

const PORT = Number(process.env.BRIDGE_PORT ?? 8789);
const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const CLI: Cli = [process.env.CLAUDE_BIN ?? "claude"];

createServer((req, res) => {
  void (async () => {
    if (req.method !== "POST" || req.url !== "/parse") return sendJson(res, 404, { error: "POST /parse only" });
    const parsed = readParseRequest(await readJson(req));
    if (!parsed) return sendJson(res, 400, { error: "bad_request" });
    const reply = await parseTurn(CLI, parsed);
    sendJson(res, reply.status, reply.body);
  })().catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: String(err) });
  });
}).listen(PORT, HOST, () => console.log(`claude bridge on http://${HOST}:${PORT}`));
