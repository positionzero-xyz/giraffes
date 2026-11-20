// Giraffe's tool server for the box's Claude Code session, over stdio: `node giraffe-mcp.ts <tools.json>`.
// It applies nothing. It answers "noted" to a call whose arguments fit the tool's schema, so the model can fix a bad
// call in the same turn. The Worker checks and applies accepted calls and records refusals.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
type Tool = { readonly name: string; readonly description: string; readonly inputSchema: Json };

const tools = JSON.parse(readFileSync(process.argv[2], "utf8")) as Tool[];
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function typeOk(type: unknown, value: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number" || type === "integer") return typeof value === "number";
  if (type === "null") return value === null;
  return true;
}

/** Shallow: required keys, each property's type and enum, and no unknown keys. Deeper rules are the Worker's. */
function problems(schema: Json, args: Json): string[] {
  const props = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const out = required.filter((k) => !(k in args)).map((k) => `missing ${k}`);
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!isObject(p)) {
      out.push(`unknown field ${k}`);
      continue;
    }
    const branches = Array.isArray(p.anyOf) ? p.anyOf.filter(isObject) : [p];
    const fits = branches.some((b) => typeOk(b.type, v) && (!Array.isArray(b.enum) || b.enum.includes(v)));
    if (!fits) out.push(`${k} has the wrong type or value`);
  }
  return out;
}

const send = (msg: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

// The CLI exposes error content as text in its tool result. Keep each problem intact through that encoding.
const refused = (problems: string[]): Json => ({ content: [{ type: "text", text: JSON.stringify({ problems }) }], isError: true });

function answer(method: string, params: Json): Json {
  switch (method) {
    case "initialize":
      return { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "giraffe", version: "1" } };
    case "tools/list":
      return { tools };
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return refused([`No tool named ${String(params.name)}.`]);
      const wrong = problems(tool.inputSchema, isObject(params.arguments) ? params.arguments : {});
      if (wrong.length > 0) return refused(wrong);
      return { content: [{ type: "text", text: "Noted. Giraffe applies it when your reply is sent, and tells the person if code refuses it." }] };
    }
    default:
      return {};
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!isObject(msg) || typeof msg.method !== "string" || msg.id === undefined) return;
  send({ id: msg.id, result: answer(msg.method, isObject(msg.params) ? msg.params : {}) });
});
