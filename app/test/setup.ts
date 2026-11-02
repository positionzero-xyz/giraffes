import { afterEach, beforeEach } from "vitest";
import { applyD1Migrations, env, reset } from "cloudflare:test";

beforeEach(() => applyD1Migrations(env.LEDGER, env.TEST_MIGRATIONS));
afterEach(() => reset());
