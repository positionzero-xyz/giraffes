import type { ModelClient, ModelRequest, ModelResult, Purpose, Usage } from "./model";

export type ScriptStep =
  | { readonly kind: "output"; readonly value: unknown; readonly usage?: Partial<Usage> }
  | { readonly kind: "fail"; readonly failure: "invalid_output" | "refused_by_model" | "unavailable" }
  | { readonly kind: "crash" }
  | { readonly kind: "hold"; readonly then: ScriptStep };

export type ScriptedModel = ModelClient & {
  readonly calls: ReadonlyArray<{ readonly purpose: Purpose; readonly system: string; readonly user: string }>;
  release(): void;
  assertDone(): void;
};

const DEFAULT_USAGE: Usage = { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 };

export function scripted(steps: readonly ScriptStep[]): ScriptedModel {
  const queue = [...steps];
  const calls: { purpose: Purpose; system: string; user: string }[] = [];
  let released = false;

  async function play<T>(step: ScriptStep, req: ModelRequest<T>): Promise<ModelResult<T>> {
    switch (step.kind) {
      case "output": {
        const parsed = req.schema.safeParse(step.value);
        if (!parsed.success) throw new Error(`scripted output doesn't match the schema: ${parsed.error.message}`);
        return { ok: true, value: parsed.data, usage: { ...DEFAULT_USAGE, ...step.usage } };
      }
      case "fail":
        return { ok: false, failure: step.failure, usage: step.failure === "unavailable" ? null : DEFAULT_USAGE };
      case "crash":
        throw new Error("scripted crash during the model call");
      case "hold":
        // A flag the test flips, not a promise the test creates: the agent never waits on a promise
        // that belongs to another request context.
        while (!released) await new Promise((r) => setTimeout(r, 1));
        return play(step.then, req);
    }
  }

  return {
    calls,
    release() {
      released = true;
    },
    assertDone() {
      if (queue.length > 0) throw new Error(`${queue.length} scripted step(s) never used`);
    },
    async parse<T>(req: ModelRequest<T>): Promise<ModelResult<T>> {
      calls.push({ purpose: req.purpose, system: req.system, user: req.user });
      const step = queue.shift();
      if (!step) throw new Error(`unexpected model call #${calls.length} (${req.purpose}): the script has no step left`);
      return play(step, req);
    },
  };
}
