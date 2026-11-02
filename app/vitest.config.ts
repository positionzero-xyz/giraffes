import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    main: "./src/worker.ts",
    miniflare: {
      // The pool bundles its own workerd, which accepts dates up to 2026-08-22; wrangler.jsonc's later
      // date is for the newer workerd that `wrangler dev` and deploys use.
      compatibilityDate: "2026-08-22",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { AGENT: { className: "Agent", useSQLite: true } },
      d1Databases: ["LEDGER"],
      bindings: {
        MODEL_BACKEND: "scripted",
        DEV_MODE: "1",
        TEST_MIGRATIONS: await readD1Migrations("./src/ledger"),
      },
    },
  }))],
  test: { passWithNoTests: true, setupFiles: ["./test/setup.ts"] },
});
