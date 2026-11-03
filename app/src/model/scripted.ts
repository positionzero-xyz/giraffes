import type { ModelClient, ModelRequest, ModelResult, Purpose, Usage } from "./model";

export type ScriptStep =
  | { readonly kind: "output"; readonly value: unknown; readonly usage?: Partial<Usage> }
  | { readonly kind: "fail"; readonly failure: "invalid_output" | "refused_by_model" | "unavailable" | "in_doubt" }
  | { readonly kind: "throw" }
  | { readonly kind: "hold"; readonly then: ScriptStep };

export type ScriptedModel = ModelClient & {
  readonly calls: ReadonlyArray<{ readonly purpose: Purpose; readonly system: string; readonly user: string }>;
  release(): void;
  assertDone(): void;
};

const DEFAULT_USAGE: Usage = { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 };

/** Compaction calls play `opts.compaction` when given, so a test can script them apart from turns. */
export function scripted(steps: readonly ScriptStep[], opts: { readonly compaction?: readonly ScriptStep[] } = {}): ScriptedModel {
  const queue = [...steps];
  const compaction = opts.compaction ? [...opts.compaction] : queue;
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
        return { ok: false, failure: step.failure, usage: step.failure === "unavailable" || step.failure === "in_doubt" ? null : DEFAULT_USAGE };
      case "throw":
        throw new Error("scripted exception from the model call");
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
      const left = queue.length + (compaction === queue ? 0 : compaction.length);
      if (left > 0) throw new Error(`${left} scripted step(s) never used`);
    },
    async parse<T>(req: ModelRequest<T>): Promise<ModelResult<T>> {
      calls.push({ purpose: req.purpose, system: req.system, user: req.user });
      const step = (req.purpose === "compaction" ? compaction : queue).shift();
      if (!step) throw new Error(`unexpected model call #${calls.length} (${req.purpose}): the script has no step left`);
      return play(step, req);
    },
  };
}
