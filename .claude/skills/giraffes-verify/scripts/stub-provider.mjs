// A local stand-in for an OpenAI-compatible provider, for verify sessions on mvp/model-access and later. It never calls out.
// Usage: node stub-provider.mjs <port> <expected key> <log file> <compaction dump file>
// The newest message picks the behaviour: "NOUSAGE" answers without usage, "HANGNOW" never answers (once), "REMEMBER <note>" also remembers <note>.
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const [port, expected, logFile, dumpFile] = process.argv.slice(2);
writeFileSync(`${logFile}.pid`, String(process.pid));
const log = (o) => appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...o })}\n`);
const bytes = (s) => Buffer.byteLength(s, "utf8");
let hung = false;
let turns = 0;
let compactions = 0;

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = JSON.parse(raw || "{}");
    const keyOk = req.headers.authorization === `Bearer ${expected}`;
    const messages = body.messages ?? [];
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.filter((m) => m.role === "user")[0]?.content ?? "";
    const purpose = (body.max_tokens ?? 0) <= 64 ? "probe" : system.startsWith("You maintain the long-term memory") ? "compaction" : "turn";
    const newest = user.split("## New").at(-1) ?? "";
    const entry = { path: req.url, keyOk, purpose, model: body.model ?? null, affinity: req.headers["x-affinity"] ?? null, promptBytes: bytes(system) + bytes(user), format: body.response_format?.type ?? null, trimmed: /earlier lines? left out/.test(user) };
    if (!keyOk || !req.url.endsWith("/chat/completions")) {
      log({ ...entry, answer: "401" });
      res.writeHead(keyOk ? 404 : 401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "no" } }));
      return;
    }
    if (purpose === "turn" && newest.includes("HANGNOW") && !hung) {
      hung = true;
      log({ ...entry, answer: "hang" });
      req.socket.on("close", () => log({ purpose, answer: "client closed the hung request" }));
      return;
    }
    let value;
    if (purpose === "probe") value = { ok: true };
    else if (purpose === "compaction") {
      compactions++;
      appendFileSync(dumpFile, `${JSON.stringify({ n: compactions, user })}\n`);
      value = { summary: `สรุปความจำ ครั้งที่ ${compactions}` };
    } else {
      const note = newest.match(/REMEMBER (\S+)/)?.[1];
      value = { actions: [...(note ? [{ type: "remember", note }] : []), { type: "send", text: `Stub reply ${++turns}.` }], tasks: [], about: "" };
    }
    const noUsage = purpose === "turn" && newest.includes("NOUSAGE");
    const reply = { choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }] };
    if (!noUsage) reply.usage = { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 0 } };
    log({ ...entry, answer: noUsage ? "ok, no usage" : "ok" });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
}).listen(Number(port), "127.0.0.1", () => log({ listening: Number(port) }));
