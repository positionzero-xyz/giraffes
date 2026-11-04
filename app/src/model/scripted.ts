import { DEV_URL_SCRIPTED } from "../access/access";
import { OUTPUTS } from "../agent/purposes";
import type { MicroUsd } from "../domain";
import type { Connect, ModelClient, Usage, WireRequest, WireResult } from "./client";
import type { CallPurpose } from "./routes";

export type ScriptFailure = "invalid_output" | "refused_by_model" | "unavailable" | "rejected" | "in_doubt";

export type ScriptStep =
  | { readonly kind: "output"; readonly value: unknown; readonly usage?: Partial<Usage> }
  | { readonly kind: "fail"; readonly failure: ScriptFailure }
  | { readonly kind: "throw" }
  | { readonly kind: "hold"; readonly then: ScriptStep };

export type ScriptedModel = ModelClient & {
  readonly calls: ReadonlyArray<{ readonly purpose: CallPurpose; readonly system: string; readonly user: string }>;
  release(): void;
  assertDone(): void;
};

const DEFAULT_USAGE: Usage = { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 };

const FAILURE: Readonly<Record<ScriptFailure, WireResult>> = {
  invalid_output: { kind: "reply", text: "not json", stop: "end", usage: DEFAULT_USAGE, reportedMicro: null },
  refused_by_model: { kind: "reply", text: "", stop: "refusal", usage: DEFAULT_USAGE, reportedMicro: null },
  unavailable: { kind: "status", status: 529, retryAfterMs: null, billing: false },
  rejected: { kind: "status", status: 400, retryAfterMs: null, billing: false },
  in_doubt: { kind: "network" },
};

/** A wire client that plays canned outputs, checked against the purpose's real schema so a drifted script fails loudly. */
export function scripted(steps: readonly ScriptStep[], opts: { readonly compaction?: readonly ScriptStep[] } = {}): ScriptedModel {
  const queue = [...steps];
  const compaction = opts.compaction ? [...opts.compaction] : queue;
  const calls: { purpose: CallPurpose; system: string; user: string }[] = [];
  let released = false;

  async function play(step: ScriptStep, purpose: CallPurpose): Promise<WireResult> {
    switch (step.kind) {
      case "output": {
        if (purpose !== "probe" && !OUTPUTS[purpose].safeParse(step.value).success) {
          throw new Error(`scripted output doesn't match the schema: ${OUTPUTS[purpose].safeParse(step.value).error?.message}`);
        }
        return { kind: "reply", text: JSON.stringify(step.value), stop: "end", usage: { ...DEFAULT_USAGE, ...step.usage }, reportedMicro: null as MicroUsd | null };
      }
      case "fail":
        return FAILURE[step.failure];
      case "throw":
        throw new Error("scripted exception from the model call");
      case "hold":
        while (!released) await new Promise((r) => setTimeout(r, 1));
        return play(step.then, purpose);
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
    async send(req: WireRequest): Promise<WireResult> {
      const purpose = req.route.purpose;
      calls.push({ purpose, system: req.system, user: req.user });
      const step = (purpose === "compaction" ? compaction : queue).shift();
      if (!step) throw new Error(`unexpected model call #${calls.length} (${purpose}): the script has no step left`);
      return play(step, purpose);
    },
  };
}

/** Serves the dev lane from `model` and every other endpoint through `other`. */
export function scriptedConnect(model: ModelClient, other: Connect): Connect {
  return (e) => (e.protocol === "bridge" && e.baseUrl === DEV_URL_SCRIPTED ? model : other(e));
}
