import http from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const LOG = process.argv[2];
const PORT = Number(process.argv[3] ?? 8788);
const DUMP_DIR = process.argv[4];
const SCRIPT_FILE = process.argv[5];
let seq = 0;

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.end();
}

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

function lastPersonLine(body) {
  const user = [...body.messages].reverse().find((m) => m.role === "user" && textOf(m.content).trim());
  const lines = textOf(user?.content).split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.findLast((l) => /^person\b/i.test(l) || /says?:/i.test(l)) ?? lines.at(-1) ?? "").slice(0, 120);
}

function sample(schema, defs, ctx) {
  if (schema.$ref) return sample(defs[schema.$ref.split("/").pop()], defs, ctx);
  if ("const" in schema) return schema.const;
  if (schema.enum) return schema.enum[0];
  const branches = schema.oneOf ?? schema.anyOf;
  if (branches) return sample(branches[0], defs, ctx);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const out = {};
      for (const key of schema.required ?? []) out[key] = sample(schema.properties[key], defs, { ...ctx, key });
      return out;
    }
    case "array":
      return [sample(schema.items ?? {}, defs, ctx)];
    case "boolean":
      return false;
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "string": {
      if (schema.pattern) return ["chat", "mock", "a"].find((s) => new RegExp(schema.pattern).test(s)) ?? "a";
      if (ctx.key === "text" || ctx.key === "summary") return ctx.reply;
      return "mock".padEnd(schema.minLength ?? 1, "x");
    }
    default:
      return null;
  }
}

function structuredAnswer(tool, body) {
  const reply = `mock reply to: ${lastPersonLine(body)}`;
  return sample(tool.input_schema, tool.input_schema.$defs ?? tool.input_schema.definitions ?? {}, { reply });
}

function reply(body) {
  const sawTool = body.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result"));
  const tools = body.tools ?? [];
  const structured = tools.find((t) => t.name === "StructuredOutput");
  const hasBash = tools.some((t) => t.name === "Bash");
  // Tool results since this turn's message: a resumed session also carries every earlier turn's.
  const turnStart = body.messages.findLastIndex((m) => m.role === "user" && textOf(m.content).trim() && !(Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result")));
  const results = body.messages.slice(turnStart + 1).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === "tool_result") : [])).length;
  const SCRIPT = SCRIPT_FILE ? JSON.parse(readFileSync(SCRIPT_FILE, "utf8")) : null;
  const scripted = SCRIPT && tools.some((t) => t.name.startsWith("mcp__giraffe__"));
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const start = ["message_start", { message: { id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage } }];
  const toolCall = (name, input) => [start,
    ["content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_mock${seq}`, name, input: {} } }],
    ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }],
    ["message_stop", {}]];
  const holdMs = scripted ? (SCRIPT.holdMs ?? 0) : 0;
  if (scripted && results < SCRIPT.calls.length) {
    const call = SCRIPT.calls[results];
    return { events: toolCall(`mcp__giraffe__${call.name}`, call.input), holdMs };
  }
  const finalText = scripted ? SCRIPT.text : "ok";
  if (structured && !sawTool) {
    const input = structuredAnswer(structured, body);
    return { events: toolCall("StructuredOutput", input), answered: input };
  }
  if (hasBash && !sawTool) return { events: toolCall("Bash", { command: "echo hi", description: "Print hi" }) };
  return { events: [start,
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: finalText } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
    ["message_stop", {}]], holdMs };
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const t = Date.now();
    const n = ++seq;
    const path = req.url.split("?")[0];
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    if (DUMP_DIR) writeFileSync(`${DUMP_DIR}/req-${t}-${n}.json`, raw);
    const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
    const out = path === "/v1/messages" && body.stream ? reply(body) : null;
    appendFileSync(LOG, JSON.stringify({
      t, n, path, bytes: Buffer.byteLength(raw), systemChars: system.length, toolsChars: JSON.stringify(body.tools ?? []).length,
      tools: (body.tools ?? []).map((x) => x.name), messages: (body.messages ?? []).length, model: body.model, stream: body.stream,
      ...(out?.answered ? { answered: out.answered } : {}),
    }) + "\n");
    if (out) return out.holdMs ? setTimeout(() => sse(res, out.events), out.holdMs) : sse(res, out.events);
    if (path === "/v1/messages") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "msg_mock", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } }));
    }
    if (path.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: 100 })); }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock" } }));
  });
});
server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  console.log(`mock on ${typeof address === "object" && address !== null ? address.port : PORT}`);
});
