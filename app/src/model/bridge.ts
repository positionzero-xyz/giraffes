import { z } from "zod";
import { routeOf, type ModelClient, type ModelRequest, type ModelResult, type Usage } from "./model";

const BridgeReply = z.object({
  structured: z.unknown(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
    })
    .nullable(),
  stop: z.enum(["end", "refusal", "max_tokens"]),
});

const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

export function bridgeModel(bridgeUrl: string): ModelClient {
  return {
    async parse<T>(req: ModelRequest<T>): Promise<ModelResult<T>> {
      const body = { model: routeOf(req.purpose).model, system: req.system, user: req.user, jsonSchema: z.toJSONSchema(req.schema) };
      let res: Response;
      try {
        res = await fetch(`${bridgeUrl}/parse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      } catch {
        return { ok: false, failure: "unavailable", usage: null };
      }
      if (!res.ok) return { ok: false, failure: "unavailable", usage: null };

      const reply = BridgeReply.safeParse(await res.json().catch(() => null));
      if (!reply.success) return { ok: false, failure: "invalid_output", usage: null };
      const u = reply.data.usage;
      const usage: Usage = u
        ? {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
          }
        : NO_USAGE;
      if (reply.data.stop === "refusal") return { ok: false, failure: "refused_by_model", usage };
      if (reply.data.stop === "max_tokens") return { ok: false, failure: "invalid_output", usage };
      const parsed = req.schema.safeParse(reply.data.structured);
      return parsed.success ? { ok: true, value: parsed.data, usage } : { ok: false, failure: "invalid_output", usage };
    },
  };
}
