/**
 * Test backend. A queue of canned outputs, each validated against the request's real schema, so a
 * script that drifts from the schema fails the test instead of passing a shape production can't produce.
 */
import type { ModelClient, ModelRequest, ModelResult, Purpose, Usage } from "./model";

export type ScriptStep =
  | { readonly kind: "output"; readonly value: unknown; readonly usage?: Partial<Usage> }
  | { readonly kind: "fail"; readonly failure: "invalid_output" | "refused_by_model" | "unavailable" }
  /** Resolve only when the test calls `release()`: lets a test enqueue a message mid-call. */
  | { readonly kind: "hold"; readonly then: ScriptStep; readonly gate: Promise<void> };

export type ScriptedModel = ModelClient & {
  /** Every request seen, in order, for assertions on prompt content and routing. */
  readonly calls: ReadonlyArray<{ readonly purpose: Purpose; readonly system: string; readonly user: string }>;
  /** Throws if steps remain: an unconsumed step means the agent made fewer calls than the test expected. */
  assertDone(): void;
};

export function scripted(steps: readonly ScriptStep[]): ScriptedModel {
  // TODO: shift() a step per parse(); no step left → throw (the agent made an unexpected call).
  //       "output": req.schema.safeParse(value) must succeed, else throw with the zod issues.
  //       usage defaults to { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 }.
  void (null as unknown as ModelRequest<unknown> | ModelResult<unknown>);
  throw new Error("not implemented");
}
