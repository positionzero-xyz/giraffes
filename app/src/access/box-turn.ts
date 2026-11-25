import { AGENT_SYSTEM } from "../agent/prompt";
import { AGENT_TOOLS, BoxTurnOutputSchema, turnFromAgent, type TurnOutput } from "../agent/turn";
import type { BoxAgentRequest } from "../box/client";
import { readAttempt, type Attempt, type WireResult } from "../model/client";
import type { PromptParts } from "../model/prompt";
import { routeFor } from "../model/routes";
import { fitPrompt } from "./fit";

export const BOX_TURN_ROUTE = routeFor({ kind: "box", provider: "claude" }, "turn");

/** What a turn on the person's box sends: no history, since the session keeps its own. Null when it doesn't fit. */
export function boxTurnRequest(system: string, prompt: PromptParts): BoxAgentRequest | null {
  const fitted = fitPrompt(BOX_TURN_ROUTE, "strict", "turn", system, { sections: prompt.sections.filter((s) => !s.history) });
  return fitted === null ? null : { model: BOX_TURN_ROUTE.model, append: AGENT_SYSTEM, turn: fitted.user, tools: AGENT_TOOLS };
}

export function boxTurnAttempt(reply: Extract<WireResult, { kind: "reply" }>): Attempt<TurnOutput> {
  const output = turnFromAgent(jsonOrNull(reply.text));
  return readAttempt(output === null ? reply : { ...reply, text: JSON.stringify(output) }, BoxTurnOutputSchema);
}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
