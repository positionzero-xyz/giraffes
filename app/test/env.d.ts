import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env } from "../src/config";

declare global {
  namespace Cloudflare {
    interface Env extends Bindings {}
  }
}
type Bindings = Env;

declare module "vitest" {
  interface ProvidedContext {
    d1Migrations: D1Migration[];
  }
}
