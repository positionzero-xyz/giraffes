import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { routeOf, type ModelClient, type ModelRequest, type ModelResult, type Usage } from "./model";

// 429 and 529 mean the API turned the request away, and any other 4xx except 408 means it rejected the
// request. Neither ran. A dropped connection, a timeout or another 5xx can come after the work was done and billed.
const turnedAway = (status: number | undefined) => status === 429 || status === 529;
const inDoubt = (status: number | undefined) => status === undefined || status === 408 || status >= 500;

export function anthropicModel(apiKey: string): ModelClient {
  // Every billed attempt has to pass through its own spend reservation, so the SDK must not retry.
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return {
    async parse<T>(req: ModelRequest<T>): Promise<ModelResult<T>> {
      const route = routeOf(req.purpose);
      let res: Anthropic.Message;
      try {
        res = await client.messages.create({
          model: route.model,
          max_tokens: route.maxTokens,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: req.user }],
          output_config: { format: zodOutputFormat(req.schema), effort: route.effort },
        });
      } catch (err) {
        if (err instanceof Anthropic.APIError && turnedAway(err.status)) return { ok: false, failure: "unavailable", usage: null };
        if (err instanceof Anthropic.APIError && inDoubt(err.status)) return { ok: false, failure: "in_doubt", usage: null };
        if (err instanceof Anthropic.APIError) return { ok: false, failure: "rejected", usage: null };
        throw err;
      }

      const usage: Usage = {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      };
      if (res.stop_reason === "refusal") return { ok: false, failure: "refused_by_model", usage };
      if (res.stop_reason !== "end_turn") return { ok: false, failure: "invalid_output", usage };

      // Parsed here rather than by `messages.parse`, which throws on invalid output and loses the usage
      // we still have to pay for.
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return { ok: false, failure: "invalid_output", usage };
      }
      const parsed = req.schema.safeParse(raw);
      return parsed.success ? { ok: true, value: parsed.data, usage } : { ok: false, failure: "invalid_output", usage };
    },
  };
}
