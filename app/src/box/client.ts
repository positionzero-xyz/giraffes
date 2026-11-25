import { z } from "zod";
import { bridgeBody, readBridgeReply, UNREADABLE_REPLY, type JsonSchema, type WireResult } from "../model/client";
import type { Fetch } from "./host";
import type { BoxToken } from "./names";

export type BoxHealth =
  | { readonly kind: "up"; readonly signedIn: boolean }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable"; readonly detail: string };

export type BoxRequest = { readonly model: string; readonly system: string; readonly user: string; readonly jsonSchema: JsonSchema };
/** A turn in the person's own Claude Code session: `append` follows its system prompt, `turn` is the context and what is new. */
export type BoxAgentRequest = { readonly model: string; readonly append: string; readonly turn: string; readonly tools: readonly unknown[] };

export type BoxReply =
  /** The CLI answered; whether the answer is valid is the caller's to decide. */
  | { readonly kind: "reply"; readonly reply: Extract<WireResult, { kind: "reply" }> }
  | { readonly kind: "signed_out" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable"; readonly detail: string };

export interface BoxClient {
  health(url: string, token: BoxToken): Promise<BoxHealth>;
  parse(url: string, token: BoxToken, req: BoxRequest): Promise<BoxReply>;
  /** The reply's text is JSON containing the session's answer and its accepted and refused tool calls. */
  agent(url: string, token: BoxToken, req: BoxAgentRequest): Promise<BoxReply>;
}

export const BOX_TIMEOUTS = { parseMs: 120_000, healthMs: 15_000 } as const;

const Health = z.object({ ok: z.literal(true), signedIn: z.boolean() });
const AgentBody = z.object({ text: z.string(), calls: z.array(z.unknown()), refusedCalls: z.unknown().optional(), usage: z.unknown(), stop: z.unknown() });

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function readAgentBody(raw: unknown): Extract<WireResult, { kind: "reply" }> | null {
  const body = AgentBody.safeParse(raw);
  if (!body.success) return null;
  const { usage, stop, ...structured } = body.data;
  return readBridgeReply({ structured, usage, stop });
}

const reason = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

export function boxClient(fetch: Fetch, timeouts: { readonly parseMs: number; readonly healthMs: number } = BOX_TIMEOUTS): BoxClient {
  return {
    async health(url, token) {
      let res: Response;
      try {
        res = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeouts.healthMs) });
      } catch (err) {
        return { kind: "unavailable", detail: reason(err) };
      }
      if (res.status === 401) return { kind: "unauthorized" };
      if (!res.ok) return { kind: "unavailable", detail: `health ${res.status}` };
      const parsed = Health.safeParse(await res.json().catch(() => null));
      return parsed.success ? { kind: "up", signedIn: parsed.data.signedIn } : { kind: "unavailable", detail: "health reply unreadable" };
    },

    parse: (url, token, req) => post(url, token, "parse", bridgeBody(req), readBridgeReply),

    agent: (url, token, req) => post(url, token, "agent", JSON.stringify(req), readAgentBody),
  };

  async function post(url: string, token: BoxToken, path: "parse" | "agent", body: string, read: (raw: unknown) => ReturnType<typeof readBridgeReply>): Promise<BoxReply> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${url}/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeouts.parseMs),
      });
      text = await res.text();
    } catch (err) {
      return { kind: "unavailable", detail: reason(err) };
    }
    if (res.status === 409) return { kind: "signed_out" };
    if (res.status === 401) return { kind: "unauthorized" };
    if (!res.ok) return { kind: "unavailable", detail: `${path} ${res.status}` };
    return { kind: "reply", reply: read(jsonOrNull(text)) ?? UNREADABLE_REPLY };
  }
}
