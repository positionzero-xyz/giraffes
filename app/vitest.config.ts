import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

/** Mirrors wrangler's default Text module rule, so `import page from "*.html"` is a string under Vite too. */
const htmlAsText = {
  name: "html-as-text",
  enforce: "pre" as const,
  transform: (code: string, id: string) => (id.endsWith(".html") ? { code: `export default ${JSON.stringify(code)};`, map: null } : null),
};

export default defineConfig(async () => ({
  plugins: [
    htmlAsText,
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        // The pool bundles its own workerd, which accepts dates up to 2026-08-22; wrangler.jsonc's later
        // date is for the newer workerd that `wrangler dev` and deploys use.
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { AGENT: { className: "Agent", useSQLite: true } },
        d1Databases: ["LEDGER"],
        bindings: { MODEL_BACKEND: "scripted", DEV_MODE: "1", KEY_SECRET: "test-key-secret-0123456789abcdef0123", PUBLIC_URL: "https://giraffes.test" },
      },
    }),
  ],
  test: {
    dangerouslyIgnoreUnhandledErrors: false,
    // Integration tests advance fake time through serialized Durable Object alarms; parallel files can exceed the 5 s default.
    testTimeout: 20_000,
    globalSetup: ["./test/runtime-guard.global-setup.mjs"],
    setupFiles: ["./test/setup.ts"],
    provide: { d1Migrations: await readD1Migrations("./src/ledger/migrations") },
  },
}));
