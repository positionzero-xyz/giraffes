import { OUTPUTS } from "../agent/purposes";
import { jsonSchemaOf, looseUser, type SchemaMode } from "../model/client";
import { bytesOf, fitSections, type PromptParts } from "../model/prompt";
import type { Purpose, Route } from "../model/routes";

export function userBudget(route: Route, mode: SchemaMode, purpose: Purpose, system: string): number {
  const schemaBytes = mode === "loose" ? bytesOf(looseUser("", jsonSchemaOf(OUTPUTS[purpose]))) : 0;
  return route.promptBytes - bytesOf(system) - schemaBytes;
}

/** Null: even with every trimmable line dropped, the prompt doesn't fit the route. */
export function fitPrompt(route: Route, mode: SchemaMode, purpose: Purpose, system: string, prompt: PromptParts): { readonly user: string; readonly trimmed: boolean } | null {
  const budget = userBudget(route, mode, purpose, system);
  const fitted = fitSections(prompt, budget);
  return bytesOf(fitted.text) <= budget ? { user: fitted.text, trimmed: fitted.historyCut > 0 } : null;
}
