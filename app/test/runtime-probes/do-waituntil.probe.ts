import { env, runInDurableObject } from "cloudflare:test";
import { test } from "vitest";

test("a rejected Durable Object waitUntil fails the suite", async () => {
  const stub = env.AGENT.get(env.AGENT.idFromName("p:dev:runtime-probe"));
  await runInDurableObject(stub, (_agent, state) => {
    state.waitUntil(Promise.reject(new Error("probe-do-waituntil")));
  });
});
