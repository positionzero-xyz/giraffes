import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { Agent } from "../../src/agent/agent";
import type { AgentKey } from "../../src/domain";

test("a rejected Durable Object RPC promise fails the suite", async () => {
  const original = Agent.prototype.refreshPlan;
  Agent.prototype.refreshPlan = async () => {
    throw new Error("probe-rpc-rejection");
  };
  try {
    const stub = env.AGENT.get(env.AGENT.idFromName("p:dev:runtime-probe"));
    await expect(stub.refreshPlan("p:dev:runtime-probe" as AgentKey)).rejects.toThrow("probe-rpc-rejection");
  } finally {
    Agent.prototype.refreshPlan = original;
  }
});
