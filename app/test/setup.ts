import { afterEach, beforeEach, inject } from "vitest";
import { applyD1Migrations, env, reset } from "cloudflare:test";

beforeEach(() => applyD1Migrations(env.LEDGER, inject("d1Migrations")));
afterEach(() => reset());
