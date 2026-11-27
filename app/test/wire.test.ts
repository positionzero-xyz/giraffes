import { describe, expect, test } from "vitest";
import { z } from "zod";
import { TurnOutputSchema } from "../src/agent/turn";
import type { MicroUsd } from "../src/domain";
import { classify, connect, jsonSchemaOf, runParse, SecretKey, type Attempt, type Endpoint, type Fetch, type Meter, type WireResult } from "../src/model/client";
import { fitPrompt, bytesOf, type PromptParts } from "../src/model/prompt";
import { defaultModelOf, PROVIDER_IDS, PROVIDERS } from "../src/model/providers";
import { PROMPT_FLOOR_BYTES, PROMPT_OVERHEAD_TOKENS, routeFor } from "../src/model/routes";

const Answer = z.object({ answer: z.number() });

type Seen = { url: string; headers: Headers; body: Record<string, unknown>; redirect: RequestInit["redirect"] };

function fakeFetch(respond: (seen: Seen, n: number) => Response | Promise<Response>): Fetch & { readonly seen: Seen[] } {
  const seen: Seen[] = [];
  const f = async (input: string, init?: RequestInit) => {
    const s = { url: input, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "null")), redirect: init?.redirect };
    seen.push(s);
    return respond(s, seen.length);
  };
  return Object.assign(f, { seen });
}

function endpoint(provider: keyof typeof PROVIDERS, key = "sk-test-0123456789"): Endpoint {
  const p = PROVIDERS[provider];
  return {
    provider,
    protocol: p.protocol,
    baseUrl: p.baseUrl ?? "https://llm.example.com/v1",
    auth: p.auth,
    key: SecretKey.from(key),
    headers: p.headers({ session: "s-1" }),
    body: p.body,
  };
}

const route = (provider: keyof typeof PROVIDERS, model = defaultModelOf(PROVIDERS[provider]) ?? "custom-model") => routeFor({ kind: "key", provider, model }, "turn");

type Metered = Meter & { readonly settled: Attempt<unknown>["kind"][]; readonly reserved: number[] };

function meter(capAttempts = Infinity): Metered {
  const settled: Attempt<unknown>["kind"][] = [];
  const reserved: number[] = [];
  return {
    settled,
    reserved,
    reserve(_route, bytes) {
      if (reserved.length >= capAttempts) return null;
      reserved.push(bytes);
      return { id: `r${reserved.length}`, estimate: 1 as MicroUsd };
    },
    settle(_r, _route, outcome) {
      settled.push(outcome.kind);
    },
  };
}

function message(text: string, stop = "end_turn") {
  return {
    content: [{ type: "text", text }],
    stop_reason: stop,
    usage: { input_tokens: 1200, output_tokens: 40, cache_creation_input_tokens: 10, cache_read_input_tokens: 3000 },
  };
}

function completion(text: string, extra: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1500, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000 }, ...extra },
  };
}

const ask = (r = route("anthropic"), mode: "strict" | "loose" = "strict") => ({ route: r, mode, system: "You answer in JSON.", user: "What is six times seven?", schema: Answer });

describe("anthropic protocol", () => {
  test("sends one cached-system request with the schema and effort, and reads the value and usage", async () => {
    const f = fakeFetch(() => Response.json(message('{"answer":42}')));
    const m = meter();

    const out = await runParse(connect(f)(endpoint("anthropic", "sk-ant-api03-secret")), ask(), m);

    expect(out.last).toEqual({ kind: "ok", value: { answer: 42 }, usage: { inputTokens: 1200, outputTokens: 40, cacheWriteTokens: 10, cacheReadTokens: 3000 }, reported: null });
    expect(m.settled).toEqual(["ok"]);
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(f.seen[0].headers.get("x-api-key")).toBe("sk-ant-api03-secret");
    expect(f.seen[0].headers.get("authorization")).toBeNull();
    expect(f.seen[0].body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 18_000,
      system: [{ type: "text", text: "You answer in JSON.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "What is six times seven?" }],
      output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } } },
    });
  });

  test("OpenCode Go takes a Bearer key on its Anthropic path, with our user agent and a stable session", async () => {
    const f = fakeFetch(() => Response.json(message('{"answer":42}')));

    await runParse(connect(f)(endpoint("opencode-go", "oc_sk_secret")), ask(route("opencode-go")), meter());

    expect(f.seen[0].url).toBe("https://opencode.ai/inference/go/anthropic/v1/messages");
    expect(f.seen[0].headers.get("authorization")).toBe("Bearer oc_sk_secret");
    expect(f.seen[0].headers.get("x-opencode-session")).toBe("s-1");
    expect(f.seen[0].headers.get("user-agent")).toBe("giraffes/1");
  });

  test("a refusal and an output cut off at the limit are not values", async () => {
    const refused = fakeFetch(() => Response.json(message("", "refusal")));
    expect((await runParse(connect(refused)(endpoint("anthropic")), ask(), meter())).last?.kind).toBe("refused_by_model");
    const cut = fakeFetch(() => Response.json(message('{"answ', "max_tokens")));
    expect((await runParse(connect(cut)(endpoint("anthropic")), ask(), meter())).last?.kind).toBe("invalid");
  });
});

describe("OpenAI-compatible protocol", () => {
  test("strict mode sends a named json_schema format and reads cached tokens as cache reads", async () => {
    const f = fakeFetch(() => Response.json(completion('{"answer":42}')));

    const out = await runParse(connect(f)(endpoint("deepinfra")), ask(route("deepinfra")), meter());

    expect(out.last).toMatchObject({ kind: "ok", value: { answer: 42 }, usage: { inputTokens: 500, cacheReadTokens: 1000, outputTokens: 40 } });
    expect(f.seen[0].url).toBe("https://api.deepinfra.com/v1/openai/chat/completions");
    expect(f.seen[0].headers.get("authorization")).toBe("Bearer sk-test-0123456789");
    expect(f.seen[0].body).toMatchObject({
      model: "deepseek-ai/DeepSeek-V4-Flash-0731",
      messages: [
        { role: "system", content: "You answer in JSON." },
        { role: "user", content: "What is six times seven?" },
      ],
      response_format: { type: "json_schema", json_schema: { name: "turn", strict: true, schema: { required: ["answer"] } } },
    });
  });

  test("Mistral takes a Bearer key on its chat completions path with a strict schema and no reasoning effort", async () => {
    const f = fakeFetch(() => Response.json(completion('{"answer":42}')));

    const out = await runParse(connect(f)(endpoint("mistral")), ask(route("mistral")), meter());

    expect(out.last).toMatchObject({ kind: "ok", value: { answer: 42 } });
    expect(f.seen[0].url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(f.seen[0].headers.get("authorization")).toBe("Bearer sk-test-0123456789");
    expect(f.seen[0].body).toMatchObject({ model: "mistral-small-2603", max_tokens: 18_000, response_format: { type: "json_schema", json_schema: { strict: true } } });
    expect(f.seen[0].body).not.toHaveProperty("reasoning_effort");
  });

  test("a reasoning model's reply as thinking and text chunks is read from its text chunk alone", async () => {
    const chunks = [
      { type: "thinking", thinking: [{ type: "text", text: "six sevens" }] },
      { type: "text", text: '{"answer":42}' },
    ];
    const f = fakeFetch(() =>
      Response.json({ choices: [{ message: { content: chunks }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    );

    const out = await runParse(connect(f)(endpoint("mistral")), ask(route("mistral")), meter());

    expect(out.last).toMatchObject({ kind: "ok", value: { answer: 42 } });
  });

  test("OpenRouter asks only for endpoints that honour the schema, and its reported cost is kept", async () => {
    const f = fakeFetch(() => Response.json(completion('{"answer":42}', { cost: 0.000421 })));

    const out = await runParse(connect(f)(endpoint("openrouter", "sk-or-v1-secret")), ask(route("openrouter")), meter());

    expect(f.seen[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(f.seen[0].body).toMatchObject({ provider: { require_parameters: true }, usage: { include: true } });
    expect(out.last).toMatchObject({ kind: "ok", reported: 421 });
  });

  test("loose mode asks for a JSON object with the schema in the prompt, and repairs a bad reply once, metering both attempts", async () => {
    const f = fakeFetch((_s, n) => Response.json(completion(n === 1 ? '{"answer":"forty-two"}' : '{"answer":42}')));
    const m = meter();

    const out = await runParse(connect(f)(endpoint("alibaba")), ask(route("alibaba"), "loose"), m);

    expect(out.last).toMatchObject({ kind: "ok", value: { answer: 42 } });
    expect(m.settled).toEqual(["invalid", "ok"]);
    expect(f.seen[0].body.response_format).toEqual({ type: "json_object" });
    const messages = f.seen[1].body.messages as { role: string; content: string }[];
    expect(messages.map((x) => x.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1].content).toContain('"required":["answer"]');
    expect(messages[2].content).toBe('{"answer":"forty-two"}');
    expect(messages[3].content).toContain("answer");
  });

  test("strict mode never repairs, and a second invalid reply in loose mode ends the call", async () => {
    const f = fakeFetch(() => Response.json(completion("not json")));
    const strict = meter();
    expect((await runParse(connect(f)(endpoint("deepinfra")), ask(route("deepinfra")), strict)).last?.kind).toBe("invalid");
    expect(strict.settled).toEqual(["invalid"]);
    const loose = meter();
    expect((await runParse(connect(f)(endpoint("alibaba")), ask(route("alibaba"), "loose"), loose)).last?.kind).toBe("invalid");
    expect(loose.settled).toEqual(["invalid", "invalid"]);
  });
});

describe("meaning of a provider's answer", () => {
  const status = (s: number, opts: { retryAfterMs?: number | null; billing?: boolean } = {}): Extract<WireResult, { kind: "status" }> => ({
    kind: "status",
    status: s,
    retryAfterMs: opts.retryAfterMs ?? null,
    billing: opts.billing ?? false,
  });

  test.each([
    [status(401), { kind: "fault", fault: "credential" }],
    [status(403), { kind: "fault", fault: "credential" }],
    [status(402), { kind: "fault", fault: "payment" }],
    [status(400, { billing: true }), { kind: "fault", fault: "payment" }],
    [status(404), { kind: "fault", fault: "model" }],
    [status(429, { retryAfterMs: 30_000 }), { kind: "turned_away" }],
    [status(429), { kind: "fault", fault: "rate" }],
    [status(429, { retryAfterMs: 5 * 60 * 60_000 }), { kind: "fault", fault: "rate" }],
    [status(529), { kind: "turned_away" }],
    [status(500), { kind: "in_doubt" }],
    [status(408), { kind: "in_doubt" }],
    [status(400), { kind: "rejected" }],
    [{ kind: "network" } as const, { kind: "in_doubt" }],
  ])("%j means %j", (wire, meaning) => {
    expect(classify(wire)).toMatchObject(meaning);
  });

  test("a billing error body is read without being kept", async () => {
    const f = fakeFetch(() => Response.json({ error: { message: "Your credit balance is too low" } }, { status: 400 }));
    expect((await runParse(connect(f)(endpoint("anthropic")), ask(), meter())).last).toEqual({ kind: "fault", fault: "payment", retryAfterMs: null });
  });

  test("a provider redirect faults without forwarding the authenticated request", async () => {
    const f = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://redirect.example.test/" } }));
    const out = await runParse(connect(f)(endpoint("anthropic")), ask(), meter());
    expect(out.last).toEqual({ kind: "fault", fault: "model", retryAfterMs: null });
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].redirect).toBe("manual");
    expect(f.seen[0].headers.get("x-api-key")).toBe("sk-test-0123456789");
  });

  test("an oversized provider response faults and stops reading", async () => {
    let reads = 0;
    let cancelled = false;
    const chunk = new Uint8Array(512 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        if (++reads === 4) controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const f = fakeFetch(() => new Response(body));
    const client = connect(f)(endpoint("anthropic"));
    const { route, mode, system, user } = ask();
    const wire = await client.send({ route, mode, system, user, schema: jsonSchemaOf(Answer), repair: null });
    expect(wire).toEqual({ kind: "provider_fault", reason: "response_too_large" });
    if (wire.kind !== "reply") expect(classify(wire)).toEqual({ kind: "in_doubt" });
    expect(reads).toBe(3);
    expect(cancelled).toBe(true);
  });

  test("a Retry-After header in seconds decides between a short wait and a usage window", async () => {
    const short = fakeFetch(() => new Response("{}", { status: 429, headers: { "retry-after": "20" } }));
    expect((await runParse(connect(short)(endpoint("anthropic")), ask(), meter())).last).toEqual({ kind: "turned_away" });
    const long = fakeFetch(() => new Response("{}", { status: 429, headers: { "retry-after": "3600" } }));
    expect((await runParse(connect(long)(endpoint("anthropic")), ask(), meter())).last).toEqual({ kind: "fault", fault: "rate", retryAfterMs: 3_600_000 });
  });

  test("a meter that refuses sends nothing", async () => {
    const f = fakeFetch(() => Response.json(message('{"answer":42}')));
    expect(await runParse(connect(f)(endpoint("anthropic")), ask(), meter(0))).toEqual({ last: null, overCap: true, attempts: 0 });
    expect(f.seen).toHaveLength(0);
  });

  test("a key prints and serializes as a placeholder", () => {
    const key = SecretKey.from("  sk-ant-api03-very-secret  ");
    expect(key?.reveal()).toBe("sk-ant-api03-very-secret");
    expect(String(key)).toBe("[key]");
    expect(JSON.stringify({ e: endpoint("anthropic", "sk-ant-api03-very-secret") })).not.toContain("very-secret");
    expect(SecretKey.from("short")).toBeNull();
    expect(SecretKey.from("has a space in it")).toBeNull();
  });
});

describe("the dev bridge", () => {
  test("posts the model, prompts and JSON schema, and a bridge that is down never ran", async () => {
    const f = fakeFetch(() => Response.json({ structured: { answer: 42 }, usage: { input_tokens: 2, output_tokens: 59 }, stop: "end" }));
    const bridge: Endpoint = { provider: "bridge", protocol: "bridge", baseUrl: "http://127.0.0.1:8789", auth: "none", key: null, headers: {}, body: {} };
    const r = routeFor({ kind: "dev", model: "claude-haiku-5-5" }, "turn");

    expect((await runParse(connect(f)(bridge), ask(r), meter())).last).toMatchObject({ kind: "ok", value: { answer: 42 } });
    expect(f.seen[0].url).toBe("http://127.0.0.1:8789/parse");
    expect(f.seen[0].body).toMatchObject({ model: "claude-haiku-5-5", system: "You answer in JSON.", jsonSchema: { required: ["answer"] } });

    const down = fakeFetch(() => {
      throw new TypeError("connection refused");
    });
    expect((await runParse(connect(down)(bridge), ask(r), meter())).last).toEqual({ kind: "turned_away" });
  });
});

describe("the model-facing schema", () => {
  type Node = Record<string, unknown>;
  const walk = (n: unknown, visit: (n: Node) => void): void => {
    if (Array.isArray(n)) return n.forEach((x) => walk(x, visit));
    if (n === null || typeof n !== "object") return;
    visit(n as Node);
    for (const v of Object.values(n)) walk(v, visit);
  };

  test("is plain JSON Schema every strict mode accepts: closed objects, every property required, no oneOf or length keywords", () => {
    const schema = jsonSchemaOf(TurnOutputSchema);
    expect(schema.$schema).toBeUndefined();
    walk(schema, (n) => {
      expect(n.oneOf).toBeUndefined();
      expect(n.const).toBeUndefined();
      expect(n.minLength).toBeUndefined();
      expect(n.maxLength).toBeUndefined();
      if (n.type === "object") {
        expect(n.additionalProperties).toBe(false);
        expect([...(n.required as string[])].sort()).toEqual(Object.keys(n.properties as object).sort());
      }
    });
    expect((schema.properties as Record<string, Node>).lateNotice.anyOf).toEqual([expect.objectContaining({ type: "string" }), { type: "null" }]);
  });

  test("a turn output without the optional late notice, and one with it null, both still parse", () => {
    const base = { actions: [], tasks: [], about: "" };
    expect(TurnOutputSchema.safeParse(base).success).toBe(true);
    expect(TurnOutputSchema.safeParse({ ...base, lateNotice: null }).success).toBe(true);
  });
});

describe("prompt budgets", () => {
  test("every priced model's prompt budget stays under its long-prompt tier, and no route starves", () => {
    for (const p of PROVIDER_IDS) {
      for (const [model, m] of Object.entries(PROVIDERS[p].models)) {
        for (const purpose of ["turn", "compaction"] as const) {
          const r = routeFor({ kind: "key", provider: p, model }, purpose);
          expect(r.priced).toBe(true);
          if (m.card.longPrompt) expect(r.promptBytes + PROMPT_OVERHEAD_TOKENS).toBeLessThan(m.card.longPrompt.aboveTokens);
          if (m.card.contextTokens) expect(r.promptBytes + PROMPT_OVERHEAD_TOKENS + r.maxTokens).toBeLessThan(m.card.contextTokens);
        }
      }
    }
    expect(PROMPT_FLOOR_BYTES.turn).toBeGreaterThanOrEqual(24_000);
    expect(PROMPT_FLOOR_BYTES.compaction).toBeGreaterThanOrEqual(24_000);
    expect(route("alibaba").promptBytes).toBeLessThan(32_000 - PROMPT_OVERHEAD_TOKENS);
  });

  test("a model nobody published prices for is priced nominally and marked so", () => {
    const r = route("openai-compatible", "my-own-model");
    expect(r).toMatchObject({ ref: "openai-compatible:my-own-model", priced: false });
    expect(route("anthropic").priced).toBe(true);
  });
});

describe("fitting a prompt", () => {
  const parts: PromptParts = {
    sections: [
      { title: "Now", keep: ["2099-11-04 10:00"], trim: [], dropRank: 9 },
      { title: "Memory", keep: ["summary"], trim: ["note one", "note two"], dropRank: 2 },
      { title: "Conversation", keep: [], trim: Array.from({ length: 30 }, (_, i) => `turn ${i} ${"ก".repeat(200)}`), dropRank: 1 },
      { title: "New", keep: ["Person: hello"], trim: [], dropRank: 9 },
    ],
  };

  test("a prompt within budget is sent as rendered", () => {
    const whole = fitPrompt(parts, Infinity);
    expect(fitPrompt(parts, bytesOf(whole))).toBe(whole);
    expect(whole).toContain("## Now\n2099-11-04 10:00\n\n## Memory\nsummary\nnote one\nnote two");
  });

  test("an over-budget prompt loses the oldest conversation first, marks the cut, and keeps every kept line", () => {
    const budget = 3_000;
    const fitted = fitPrompt(parts, budget);
    expect(bytesOf(fitted)).toBeLessThanOrEqual(budget);
    expect(fitted).toContain("earlier lines left out");
    expect(fitted).not.toContain("turn 0 ");
    expect(fitted).toContain("turn 29 ");
    expect(fitted).toContain("note one");
    expect(fitted).toContain("Person: hello");
  });

  test("when the conversation is gone, notes go next", () => {
    const fitted = fitPrompt(parts, 120);
    expect(fitted).not.toContain("note one");
    expect(fitted).toContain("summary");
    expect(fitted).toContain("Person: hello");
  });
});
