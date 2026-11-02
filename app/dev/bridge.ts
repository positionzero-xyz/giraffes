/**
 * Local dev bridge: lets `wrangler dev` use the operator's own Claude login through `claude -p`.
 * A Worker can't spawn processes, so the Worker's `bridgeModel` POSTs here.
 * Run with: bun app/dev/bridge.ts   (binds 127.0.0.1 only; never deployed)
 *
 * Contract: see src/model/bridge.ts.
 */

const PORT = 8789;
const ALIAS: Record<string, string> = { "claude-haiku-5-5": "haiku", "claude-sonnet-5-5": "sonnet" };

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    // TODO:
    //   { model, system, user, jsonSchema } = await req.json()
    //   args = ["claude", "-p", "--model", ALIAS[model], "--tools", "", "--system-prompt", system,
    //           "--output-format", "json", "--no-session-persistence", "--setting-sources", "",
    //           "--strict-mcp-config", "--json-schema", JSON.stringify(jsonSchema)]
    //   proc = Bun.spawn(args, { stdin: new Blob([user]), stdout: "pipe", stderr: "pipe", cwd: tmpdir })
    //   d = JSON.parse(stdout)
    //   d.is_error → 502 (the Worker maps it to "unavailable")
    //   return Response.json({ structured: d.structured_output ?? null, usage: d.usage,
    //                          stop: d.stop_reason === "refusal" ? "refusal" : d.stop_reason === "max_tokens" ? "max_tokens" : "end" })
    //   (no retries here: the Worker's agent owns retry policy)
    void req; void ALIAS;
    return new Response("not implemented", { status: 501 });
  },
});
