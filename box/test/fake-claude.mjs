#!/usr/bin/env node
// Stands in for the pinned CLI: `fake-claude.mjs <state-dir> <claude args...>`.
// <state-dir>/logged-in marks a login, and every call appends what it did to <state-dir>/events.log.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [dir, ...args] = process.argv.slice(2);
const event = (line) => appendFileSync(join(dir, "events.log"), `${line}\n`);
const loggedIn = existsSync(join(dir, "logged-in"));
const flag = (name) => args[args.indexOf(name) + 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (args[0] === "--version") {
  console.log("2.1.316 (Claude Code)");
} else if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" }, null, 2));
  process.exitCode = loggedIn ? 0 : 1;
} else if (args[0] === "auth" && args[1] === "login") {
  event(`login started BROWSER=${process.env.BROWSER}`);
  process.stdout.write("Opening browser to sign in…\n");
  process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=s3cret\n");
  process.stdout.write("Paste code here if prompted > ");
  for await (const line of createInterface({ input: process.stdin })) {
    event(`login read ${line}`);
    if (line === "slow-code#state") await sleep(600);
    if (line === "good-code#state" || line === "slow-code#state") {
      writeFileSync(join(dir, "logged-in"), "");
      console.log("Login successful.");
      process.exit(0);
    }
    if (line.startsWith("garbled")) {
      process.stdout.write("Invalid code. Please make sure the full code was copied.\nPaste code here if prompted > ");
      continue;
    }
    console.log("Login failed: invalid_grant");
    process.exit(1);
  }
} else if (args[0] === "-p") {
  const user = await stdin();
  event(`turn start ${Date.now()}`);
  await sleep(user === "hang" ? 5000 : 150);
  event(`turn end ${Date.now()}`);
  if (!loggedIn) {
    console.log(JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }));
    process.exit(1);
  }
  if (user === "crash") {
    console.error(flag("--system-prompt"));
    console.log(JSON.stringify({ type: "result", is_error: true, subtype: flag("--model") }));
    process.exit(2);
  }
  const ok = flag("--tools") === "" && flag("--setting-sources") === "" && args.includes("--no-session-persistence");
  console.log(JSON.stringify({
    type: "result",
    is_error: false,
    stop_reason: "end_turn",
    total_cost_usd: 0.001,
    structured_output: { ok, model: flag("--model"), system: flag("--system-prompt"), schema: JSON.parse(flag("--json-schema")), user },
    usage: { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 4, service_tier: "standard" },
  }));
} else {
  console.error(`fake claude: unexpected ${args.join(" ")}`);
  process.exit(64);
}
