import { afterEach, beforeEach, inject } from "vitest";
import { applyD1Migrations, env, reset } from "cloudflare:test";
import { UNSCRIPTED_BOX_TURNS } from "./testkit";

beforeEach(() => applyD1Migrations(env.LEDGER, inject("d1Migrations")));
afterEach(() => reset());
afterEach(() => {
  const seen = UNSCRIPTED_BOX_TURNS.splice(0);
  if (seen.length) throw new Error(`the box got turns the test did not script: ${JSON.stringify(seen)}`);
});
