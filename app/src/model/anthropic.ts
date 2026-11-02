/**
 * Hosted backend: the official `@anthropic-ai/sdk`, which runs on Workers.
 * SDK types stop at this file.
 */
import type { ModelClient, ModelRequest, ModelResult } from "./model";

export function anthropicModel(apiKey: string): ModelClient {
  return {
    async parse<T>(req: ModelRequest<T>): Promise<ModelResult<T>> {
      // TODO:
      //   const route = routeOf(req.purpose);
      //   const client = new Anthropic({ apiKey, maxRetries: 2 });
      //   const res = await client.messages.parse({
      //     model: route.model,
      //     max_tokens: route.maxTokens,
      //     system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      //     messages: [{ role: "user", content: req.user }],
      //     output_config: { format: zodOutputFormat(req.schema), effort: route.effort },
      //   });
      //   // No assistant prefill, no temperature/top_p, no forced tool_choice: all 400 on these models.
      //   usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens,
      //             cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      //             cacheReadTokens: res.usage.cache_read_input_tokens ?? 0 }
      //   if (res.stop_reason === "refusal")    return { ok: false, failure: "refused_by_model", usage }
      //   if (res.stop_reason === "max_tokens") return { ok: false, failure: "invalid_output", usage }
      //   if (res.parsed_output == null)        return { ok: false, failure: "invalid_output", usage }
      //   return { ok: true, value: res.parsed_output, usage }
      // catch APIError 429/5xx/529 after SDK retries → { ok: false, failure: "unavailable", usage: null }
      // catch connection errors                       → { ok: false, failure: "unavailable", usage: null }
      void apiKey;
      throw new Error("not implemented");
    },
  };
}
