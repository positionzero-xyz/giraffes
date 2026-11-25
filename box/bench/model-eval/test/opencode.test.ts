import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { giraffeMcp } from "../codex.ts";
import { findOpencode, inventoryOf, opencodeArgs, opencodeConfig, opencodeEnv, parseOpencodeJsonl, writeLane } from "../opencode.ts";

const fixture = (name: string) => readFileSync(new URL(`./opencode/${name}.jsonl`, import.meta.url), "utf8");
const line = (e: object) => JSON.stringify({ sessionID: "ses_1", timestamp: 1, ...e });
const finish = (reason: string, tokens = { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost = 0.001) => line({ type: "step_finish", part: { type: "step-finish", reason, cost, tokens } });
const tool = (name: string, state: object) => line({ type: "tool_use", part: { type: "tool", tool: name, state } });

describe("opencode arguments", () => {
  it("runs one standalone, archived JSON turn on the candidate's model and variant, with the prompt left for stdin", () => {
    const args = opencodeArgs("mistral/deepseek-v4-1-flash-1017", "low");
    assert.deepEqual(args.slice(0, 4), ["run", "--standalone", "--format", "json"]);
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "mistral/deepseek-v4-1-flash-1017#low"]);
    assert.deepEqual(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2), ["--agent", "giraffe"]);
    assert.ok(args.includes("--archived"));
    assert.ok(!args.some((a) => a.includes("\n")));
  });

  it("leaves the variant to OpenCode for default", () => {
    const args = opencodeArgs("mistral/mistral-small-latest", "default");
    assert.equal(args[args.indexOf("--model") + 1], "mistral/mistral-small-latest");
  });
});

describe("the isolated opencode config", () => {
  const mcp = giraffeMcp("C:/run/tools.json");

  it("gives a turn only Giraffe's tool server, every other action denied", () => {
    const config = opencodeConfig("turn", "Be Giraffe.", mcp);
    assert.equal(config.plugins[0], "-*");
    assert.ok(config.plugins.includes("opencode.config.mcp"));
    assert.ok(!config.plugins.some((p) => p.startsWith("opencode.tool.")));
    assert.deepEqual(config.mcp?.servers.giraffe, { type: "local", command: [mcp.command, ...mcp.args] });
    const agent = config.agents.giraffe;
    assert.equal(agent.system, "Be Giraffe.");
    assert.deepEqual(agent.permissions, [
      { action: "*", resource: "*", effect: "deny" },
      { action: "giraffe_*", resource: "*", effect: "allow" },
    ]);
    assert.equal(config.providers, undefined);
    assert.equal(config.model, undefined);
  });

  it("gives a build read, write and edit inside its folder and nothing outside it", () => {
    const config = opencodeConfig("build", "Build it.", null);
    for (const p of ["opencode.tool.read", "opencode.tool.write", "opencode.tool.edit"]) assert.ok(config.plugins.includes(p));
    assert.ok(!config.plugins.includes("opencode.tools"));
    assert.equal(config.mcp, undefined);
    assert.deepEqual(config.agents.giraffe.permissions.at(-1), { action: "external_directory", resource: "*", effect: "deny" });
    assert.deepEqual(config.agents.giraffe.permissions[0], { action: "*", resource: "*", effect: "deny" });
  });

  it("points the inventory at a stand-in provider on a local server and keeps everything else", () => {
    const real = opencodeConfig("turn", "x", mcp);
    const local = opencodeConfig("turn", "x", mcp, "http://127.0.0.1:9/v1");
    assert.equal(local.providers?.inventory.settings.baseURL, "http://127.0.0.1:9/v1");
    assert.deepEqual(local.model, { providerID: "inventory", model: "probe" });
    assert.deepEqual({ ...local, providers: undefined, model: undefined }, { ...real, providers: undefined, model: undefined });
  });

  it("writes a private config folder and turns the shared background service off", () => {
    const lane = writeLane(join(mkdtempSync(join(tmpdir(), "oc-lane-test-")), "turn"), opencodeConfig("build", "x", null));
    assert.deepEqual(JSON.parse(readFileSync(join(lane, "config", "service.json"), "utf8")), { disabled: true });
    assert.equal(JSON.parse(readFileSync(join(lane, "config", "opencode.json"), "utf8")).agents.giraffe.system, "x");
  });

  it("gives the child the private folders, no OpenCode or search variables, and the run's folder", () => {
    process.env.OPENCODE_CONFIG = "should-not-leak";
    process.env.EXA_API_KEY = "should-not-leak";
    const env = opencodeEnv("C:/lane", "C:/work");
    delete process.env.OPENCODE_CONFIG;
    delete process.env.EXA_API_KEY;
    assert.equal(env.OPENCODE_CONFIG, undefined);
    assert.equal(env.EXA_API_KEY, undefined);
    assert.equal(env.OPENCODE_CONFIG_DIR, join("C:/lane", "config"));
    assert.equal(env.OPENCODE_CONFIG_PROJECT_DISABLE, "1");
    assert.equal(env.PWD, "C:/work");
  });
});

describe("finding the opencode executable", () => {
  it("prefers the real executable behind an npm shim on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-path-test-"));
    const bin = join(dir, "node_modules", "@opencode", "cli", "bin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, process.platform === "win32" ? "opencode.exe" : "opencode");
    writeFileSync(exe, "");
    writeFileSync(join(dir, "opencode.cmd"), "");
    assert.equal(findOpencode(null, dir), exe);
    assert.equal(findOpencode("C:/my/opencode.exe", dir), "C:/my/opencode.exe");
    assert.equal(findOpencode(null, mkdtempSync(join(tmpdir(), "oc-empty-test-"))), "opencode");
  });
});

describe("opencode run --format json", () => {
  it("reads a recorded turn's final reply, its accepted and refused giraffe calls, and its summed tokens and cost", () => {
    const turn = parseOpencodeJsonl(fixture("turn"));
    assert.equal(turn.failure, null);
    assert.equal(turn.stop, "end");
    assert.match(turn.text, /done$/);
    assert.deepEqual(turn.calls, [{ name: "remember", input: { note: "likes iced coffee" } }]);
    assert.equal(turn.refusedCalls.length, 1);
    assert.deepEqual(turn.refusedCalls[0].input, { note: "" });
    assert.match(turn.refusedCalls[0].problems[0], /length of at least 1/);
    assert.deepEqual(turn.otherTools, []);
    assert.deepEqual(turn.usage, { input_tokens: 129 + 97 + 114, output_tokens: 191 + 63 + 133, cache_creation_input_tokens: 0, cache_read_input_tokens: 1280 + 1536 + 1664 });
    assert.ok(Math.abs((turn.costUsd ?? 0) - (0.00027686 + 0.000115452 + 0.000205448)) < 1e-12);
    assert.equal(turn.session, "ses_def5001eeffeQfHzcWZealhATI");
  });

  it("reports a recorded failed turn as failed, with no usage or cost", () => {
    const failed = parseOpencodeJsonl(fixture("failed"));
    assert.equal(failed.failure?.kind, "failed");
    assert.match(failed.failure?.message ?? "", /Variant unavailable/);
    assert.equal(failed.usage, null);
    assert.equal(failed.costUsd, null);
  });

  it("reports a rate-limit error (synthetic, shaped like the recorded failure) as a usage limit and a rejected key as signed out", () => {
    assert.equal(parseOpencodeJsonl(fixture("usage-limit")).failure?.kind, "usage_limit");
    assert.equal(parseOpencodeJsonl(line({ type: "error", error: { type: "provider.quota", message: "out of credits" } })).failure?.kind, "usage_limit");
    assert.equal(parseOpencodeJsonl(line({ type: "error", error: { type: "provider.auth", message: "Unauthorized", status: 401 } })).failure?.kind, "signed_out");
  });

  it("counts a call the tool server itself refused as refused, and names any tool that isn't Giraffe's", () => {
    const turn = parseOpencodeJsonl([
      tool("giraffe_task", { status: "completed", input: { op: "x" }, output: JSON.stringify({ problems: ["op has the wrong type or value"] }) }),
      tool("giraffe_set_locale", { status: "error", input: {}, error: JSON.stringify({ problems: ["missing locale"] }) }),
      tool("read", { status: "completed", input: { path: "a" }, output: "x" }),
      line({ type: "text", part: { type: "text", text: "ok" } }),
      finish("stop"),
    ].join("\n"));
    assert.deepEqual(turn.calls, []);
    assert.deepEqual(turn.refusedCalls, [
      { name: "task", input: { op: "x" }, problems: ["op has the wrong type or value"] },
      { name: "set_locale", input: {}, problems: ["missing locale"] },
    ]);
    assert.deepEqual(turn.otherTools, ["read"]);
  });

  it("reads an output cut as max_tokens, and a stream with no finished step or one left calling tools as failed", () => {
    assert.equal(parseOpencodeJsonl([line({ type: "text", part: { type: "text", text: "half" } }), finish("length")].join("\n")).stop, "max_tokens");
    assert.equal(parseOpencodeJsonl(line({ type: "text", part: { type: "text", text: "hi" } })).failure?.message, "no step_finish event");
    assert.match(parseOpencodeJsonl(finish("tool-calls")).failure?.message ?? "", /tool-calls/);
  });

  it("adds reasoning to output tokens, as Claude's output count includes thinking", () => {
    const turn = parseOpencodeJsonl(finish("stop", { input: 5, output: 3, reasoning: 4, cache: { read: 1, write: 2 } }));
    assert.deepEqual(turn.usage, { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 1 });
  });
});

describe("the tool inventory", () => {
  it("reads the tool names and the system text from OpenCode's first request", () => {
    const body = {
      model: "probe",
      messages: [{ role: "system", content: "Be Giraffe.\n# Your Model" }, { role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "giraffe_remember" } }, { type: "function", function: { name: "giraffe_task" } }],
    };
    assert.deepEqual(inventoryOf(body), { tools: ["giraffe_remember", "giraffe_task"], system: "Be Giraffe.\n# Your Model" });
    assert.deepEqual(inventoryOf({}), { tools: [], system: "" });
  });
});

describe("an opencode candidate", () => {
  it("parses with a provider-qualified model and dry-prints the exact run without spending", () => {
    const eval_ = fileURLToPath(new URL("../eval.ts", import.meta.url));
    const out = execFileSync(process.execPath, [eval_, "--candidates", "opencode:mistral/deepseek-v4-1-flash-1017@low", "--shapes", "chat", "--cases", "1", "--dry", "--opencode", "opencode"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    assert.match(out, /# opencode:mistral\/deepseek-v4-1-flash-1017@low chat-/);
    assert.match(out, /opencode run --standalone --format json --model 'mistral\/deepseek-v4-1-flash-1017#low' --agent giraffe/);
    assert.match(out, /"giraffe_\*"/);
  });
});
