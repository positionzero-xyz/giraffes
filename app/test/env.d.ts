import type { Env as Bindings } from "../src/config";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
declare global {
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
