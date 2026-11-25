import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";
import { codexArgs, codexEnv, giraffeMcp, homeConfig, inventoryOf, KEY_ENV, parseCodexJsonl, readPool, toolsOfRequest } from "../codex.ts";

const fixture = (name: string) => readFileSync(new URL(`./codex/${name}.jsonl`, import.meta.url), "utf8");

function personHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-home-test-"));
  writeFileSync(join(dir, "pool.config.toml"), 'model_provider = "proxy"\n');
  writeFileSync(
    join(dir, "config.toml"),
    `model = "gpt-6.2-sol"
[mcp_servers.node_repl]
command = "repl.exe"

[model_providers.proxy]
name = "Proxy"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"
supports_websockets = true
experimental_bearer_token = "secret-token-123"

[model_providers.other]
base_url = "http://elsewhere/v1"
`,
  );
  return dir;
}

describe("codex arguments", () => {
  it("always runs on the pool profile with the candidate's model and effort", () => {
    const args = codexArgs("gpt-6.2-sol", "low", "turn", "C:/work");
    assert.deepEqual(args.slice(0, 5), ["--profile", "pool", "exec", "-m", "gpt-6.2-sol"]);
    assert.ok(args.includes('model_reasoning_effort="low"'));
    assert.deepEqual(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2), ["-s", "read-only"]);
    assert.ok(args.includes("--json") && args.includes("--ephemeral"));
    assert.equal(args.at(-1), "-");
  });

  it("leaves the effort to Codex for default and lets a build write its folder", () => {
    const args = codexArgs("gpt-6.2-sol", "default", "build", "C:/work");
    assert.ok(!args.some((a) => a.startsWith("model_reasoning_effort")));
    assert.deepEqual(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2), ["-s", "workspace-write"]);
    assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2), ["-C", "C:/work"]);
  });
});

describe("the isolated codex home", () => {
  it("copies only the pool's provider and moves its token into the environment", () => {
    const pool = readPool(personHome());
    assert.equal(pool.provider, "proxy");
    assert.equal(pool.secretToken, "secret-token-123");
    const config = homeConfig(pool, "Be Giraffe.", null);
    assert.ok(!config.includes("secret-token-123"));
    assert.match(config, /\[model_providers\.proxy\]\nenv_key = "GIRAFFE_EVAL_CODEX_KEY"/);
    assert.ok(!config.includes("node_repl") && !config.includes("elsewhere"));
    assert.match(config, /network_access = false/);
    assert.match(config, /shell_tool = false/);
    if (process.platform === "win32") assert.match(config, /\[windows\]\nsandbox = "unelevated"\n$/);
    assert.doesNotMatch(homeConfig(pool, "x", giraffeMcp("t.json")), /\[windows\]/);
  });

  it("points the provider at a plain HTTP server only when asked", () => {
    const pool = readPool(personHome());
    const real = homeConfig(pool, "x", null);
    assert.match(real, /base_url = "http:\/\/127\.0\.0\.1:8317\/v1"/);
    assert.match(real, /supports_websockets = true/);
    const local = homeConfig(pool, "x", null, "http://127.0.0.1:9/v1");
    assert.match(local, /base_url = "http:\/\/127\.0\.0\.1:9\/v1"/);
    assert.match(local, /supports_websockets = false/);
  });

  it("gives the child an empty user folder and only the pool key", () => {
    process.env.OPENAI_API_KEY = "should-not-leak";
    process.env.CODEX_THREAD_ID = "parent";
    const user = join(mkdtempSync(join(tmpdir(), "codex-env-test-")), "user");
    const env = codexEnv("C:/home", user, "k");
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_THREAD_ID;
    assert.equal(env.CODEX_HOME, "C:/home");
    assert.equal(env[KEY_ENV], "k");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_THREAD_ID, undefined);
    assert.equal(env.USERPROFILE, user);
    assert.equal(env.HOME, user);
  });
});

describe("the giraffe tool server attachment", () => {
  it("starts the box's tool server from the config Codex reads and serves the turn's tools", async () => {
    const toolsFile = join(mkdtempSync(join(tmpdir(), "codex-mcp-test-")), "tools.json");
    writeFileSync(toolsFile, JSON.stringify([{ name: "remember", description: "Save a fact", inputSchema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] } }]));
    const config = homeConfig(readPool(personHome()), "x", giraffeMcp(toolsFile));
    assert.match(config, /omit_tools_from = \["code_mode", "deferred"\]/);
    const command = JSON.parse(/^command = (.*)$/m.exec(config)![1]);
    const args = JSON.parse(/^args = (.*)$/m.exec(config)![1]);
    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    const replies = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
    const ask = async (id: number, method: string, params: object) => {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return JSON.parse((await replies.next()).value).result;
    };
    await ask(1, "initialize", { protocolVersion: "2025-06-18" });
    assert.deepEqual((await ask(2, "tools/list", {})).tools.map((t: { name: string }) => t.name), ["remember"]);
    assert.equal((await ask(3, "tools/call", { name: "remember", arguments: {} })).isError, true);
    proc.kill();
  });
});

describe("codex exec --json", () => {
  it("reads a recorded turn's reply, its accepted and refused giraffe calls, and its tokens", () => {
    const turn = parseCodexJsonl(fixture("turn"));
    assert.equal(turn.failure, null);
    assert.equal(turn.text, "done");
    assert.deepEqual(turn.calls, [{ name: "remember", input: { fact: "likes iced coffee" } }]);
    assert.deepEqual(turn.refusedCalls, [{ name: "remember", input: {}, problems: ["missing fact"] }]);
    assert.deepEqual(turn.otherTools, []);
    assert.deepEqual(turn.usage, { input_tokens: 24726 - 16128, output_tokens: 65, cache_creation_input_tokens: 0, cache_read_input_tokens: 16128 });
  });

  it("reports a failed turn as failed and a usage limit as a usage limit", () => {
    const failed = parseCodexJsonl(fixture("failed"));
    assert.equal(failed.failure?.kind, "failed");
    assert.equal(failed.usage, null);
    const limited = parseCodexJsonl(fixture("usage-limit"));
    assert.equal(limited.failure?.kind, "usage_limit");
    assert.match(limited.failure?.message ?? "", /usage limit/);
  });

  it("treats a cut-off stream as failed and names any tool that isn't Giraffe's", () => {
    const cut = parseCodexJsonl(fixture("turn").split("\n").slice(0, 4).join("\n"));
    assert.equal(cut.failure?.message, "no turn.completed event");
    const shell = parseCodexJsonl(`${JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "dir" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 1 } })}`);
    assert.deepEqual(shell.otherTools, ["command_execution"]);
    assert.equal(shell.usage?.cache_read_input_tokens, 0);
  });
});

describe("the tool inventory", () => {
  it("lists top-level, namespaced and Code Mode nested tools", () => {
    const body = {
      tools: [{ type: "web_search" }],
      input: [
        {
          type: "additional_tools",
          tools: [
            { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description: "Run JS\n### `apply_patch`\nedit\n### `view_image`\n" }, { type: "function", name: "wait" }] },
            { type: "namespace", name: "mcp__giraffe", tools: [{ type: "function", name: "remember" }] },
          ],
        },
        { type: "message", role: "user", content: [] },
      ],
    };
    assert.deepEqual(toolsOfRequest(body), ["web_search", "exec", "exec/apply_patch", "exec/view_image", "wait", "mcp__giraffe/remember"]);
  });

  it("says whether the permission profile lets Codex write the workspace", () => {
    const profile = (entries: string) => ({
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n<filesystem><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry>${entries}</file_system></permission_profile></filesystem>\n</environment_context>` }] }],
    });
    const cwd = "C:\\Temp\\cwd-1";
    assert.equal(inventoryOf(profile(""), cwd).writesWorkspace, false);
    assert.equal(inventoryOf(profile('<entry access="write"><path>C:\\Temp\\other</path></entry>'), cwd).writesWorkspace, false);
    assert.equal(inventoryOf(profile('<entry access="write"><path>c:\\temp\\cwd-1</path></entry>'), "C:/Temp/cwd-1").writesWorkspace, true);
  });
});
