import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { TURN, TurnOutputSchema } from "../src/agent/turn";
import { anthropicModel } from "../src/model/anthropic";
import { bridgeModel } from "../src/model/bridge";
import { routeOf } from "../src/model/model";
import { scripted } from "../src/model/scripted";

const Answer = z.object({ answer: z.number() });
const request = { purpose: "turn" as const, system: "You answer in JSON.", user: "What is six times seven?", schema: Answer };

type Seen = { url: string; headers: Headers; body: unknown };

function stubFetch(respond: (seen: Seen) => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const s = { url: req.url, headers: req.headers, body: await req.json().catch(() => null) };
    seen.push(s);
    return respond(s);
  });
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function message(text: string, stop = "end_turn") {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 },
  };
}

describe("anthropic", () => {
  test("sends one cached-system structured request and returns the parsed value with usage", async () => {
    const seen = stubFetch(() => Response.json(message('{"answer":42}')));

    const result = await anthropicModel("sk-test").parse(request);

    expect(result).toEqual({ ok: true, value: { answer: 42 }, usage: { inputTokens: 1200, outputTokens: 40, cacheWriteTokens: 0, cacheReadTokens: 3000 } });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0].body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: routeOf("turn").maxTokens,
      system: [{ type: "text", text: "You answer in JSON.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "What is six times seven?" }],
      output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "number" } } } } },
    });
    expect(Object.keys(seen[0].body as object).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
  });

  test("an overloaded API is reported unavailable after exactly one attempt", async () => {
    const seen = stubFetch(() => Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 }));

    expect(await anthropicModel("sk-test").parse(request)).toEqual({ ok: false, failure: "unavailable", usage: null });
    expect(seen).toHaveLength(1);
  });

  test("a refusal and output that doesn't match the schema are failures that still carry usage", async () => {
    stubFetch(() => Response.json(message("", "refusal")));
    expect(await anthropicModel("sk-test").parse(request)).toMatchObject({ ok: false, failure: "refused_by_model", usage: { inputTokens: 1200 } });

    vi.restoreAllMocks();
    stubFetch(() => Response.json(message('{"answer":"forty-two"}')));
    expect(await anthropicModel("sk-test").parse(request)).toMatchObject({ ok: false, failure: "invalid_output", usage: { outputTokens: 40 } });
  });

  test("a turn past the length caps still parses, because the API doesn't enforce them and code does", async () => {
    const send = { type: "send", text: "x".repeat(TURN.maxTextChars + 1) };
    const out = { actions: Array.from({ length: TURN.maxActions + 1 }, () => send), tasks: [], about: "" };
    stubFetch(() => Response.json(message(JSON.stringify(out))));
    expect(await anthropicModel("sk-test").parse({ ...request, schema: TurnOutputSchema })).toMatchObject({ ok: true, value: out });
  });

  test("a request whose response never arrived is in doubt, because it may have been billed", async () => {
    stubFetch(() => {
      throw new TypeError("connection reset");
    });
    expect(await anthropicModel("sk-test").parse(request)).toEqual({ ok: false, failure: "in_doubt", usage: null });
  });

  test("a request the API rejected with a 4xx was never run, so it is rejected, not in doubt", async () => {
    for (const status of [400, 401, 403, 404, 413]) {
      vi.restoreAllMocks();
      stubFetch(() => Response.json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, { status }));
      expect(await anthropicModel("sk-test").parse(request), String(status)).toEqual({ ok: false, failure: "rejected", usage: null });
    }

    vi.restoreAllMocks();
    stubFetch(() => Response.json({ type: "error", error: { type: "timeout_error", message: "slow" } }, { status: 408 }));
    expect(await anthropicModel("sk-test").parse(request)).toEqual({ ok: false, failure: "in_doubt", usage: null });
  });
});

describe("dev bridge", () => {
  test("posts the model, prompts and JSON schema, and validates what comes back", async () => {
    const seen = stubFetch(() =>
      Response.json({
        structured: { answer: 42 },
        usage: { input_tokens: 2, output_tokens: 59, cache_creation_input_tokens: 1397, cache_read_input_tokens: 0 },
        stop: "end",
        costUsd: 0.0003,
      }),
    );

    const result = await bridgeModel("http://127.0.0.1:8789").parse(request);

    expect(result).toEqual({ ok: true, value: { answer: 42 }, usage: { inputTokens: 2, outputTokens: 59, cacheWriteTokens: 1397, cacheReadTokens: 0 } });
    expect(seen[0].url).toBe("http://127.0.0.1:8789/parse");
    expect(seen[0].body).toMatchObject({
      model: "claude-haiku-5-5",
      system: "You answer in JSON.",
      user: "What is six times seven?",
      jsonSchema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
    });
  });

  test("a bridge that is down or failing is unavailable", async () => {
    stubFetch(() => Response.json({ error: "claude -p failed" }, { status: 502 }));
    expect(await bridgeModel("http://127.0.0.1:8789").parse(request)).toEqual({ ok: false, failure: "unavailable", usage: null });

    vi.restoreAllMocks();
    stubFetch(() => {
      throw new TypeError("connection refused");
    });
    expect(await bridgeModel("http://127.0.0.1:8789").parse(request)).toEqual({ ok: false, failure: "unavailable", usage: null });
  });
});

describe("scripted", () => {
  test("a canned output that drifts from the schema fails loudly", async () => {
    const model = scripted([{ kind: "output", value: { answer: "42" } }]);
    await expect(model.parse(request)).rejects.toThrow(/doesn't match the schema/);
  });
});
