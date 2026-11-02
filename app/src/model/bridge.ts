/**
 * Dev backend: the Worker calls a tiny local process (`app/dev/bridge.ts`) that runs `claude -p` with the
 * operator's own Claude login, run locally. Dev only: `loadConfig` refuses
 * MODEL_BACKEND=bridge unless DEV_MODE=1.
 *
 * Wire contract (private to this file and dev/bridge.ts):
 *   POST {bridgeUrl}/parse  { model, system, user, jsonSchema }
 *   200  { structured: unknown | null, usage: { input_tokens, output_tokens, cache_creation_input_tokens,
 *          cache_read_input_tokens }, stop: "end" | "refusal" | "max_tokens" }
 */
import type { ModelClient, ModelRequest, ModelResult } from "./model";

export function bridgeModel(bridgeUrl: string): ModelClient {
  return {
    async parse<T>(req: ModelRequest<T>): Promise<ModelResult<T>> {
      // TODO:
      //   jsonSchema = z.toJSONSchema(req.schema)
      //   res = await fetch(`${bridgeUrl}/parse`, { method: "POST", body: JSON.stringify({ model: alias(routeOf(req.purpose).model), ... }) })
      //   !res.ok → { ok: false, failure: "unavailable", usage: null }
      //   body → usage; req.schema.safeParse(body.structured) → ok | invalid_output
      //   Usage is real token counts from the CLI's JSON, so spend tracking behaves as in production
      //   even though the operator's plan pays.
      void bridgeUrl;
      throw new Error("not implemented");
    },
  };
}
