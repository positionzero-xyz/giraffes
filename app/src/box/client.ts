import { z } from "zod";
import { bridgeBody, NO_USAGE, readBridgeReply, type JsonSchema, type WireResult } from "../model/client";
import type { Fetch } from "./host";
import type { BoxToken } from "./names";

export type BoxHealth =
  | { readonly kind: "up"; readonly signedIn: boolean }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable"; readonly detail: string };

export type BoxRequest = { readonly model: string; readonly system: string; readonly user: string; readonly jsonSchema: JsonSchema };

export type BoxReply =
  /** The CLI answered; whether the answer is valid is the caller's to decide. */
  | { readonly kind: "reply"; readonly reply: Extract<WireResult, { kind: "reply" }> }
  | { readonly kind: "signed_out" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable"; readonly detail: string };

export interface BoxClient {
  health(url: string, token: BoxToken): Promise<BoxHealth>;
  parse(url: string, token: BoxToken, req: BoxRequest): Promise<BoxReply>;
}

export const BOX_TIMEOUTS = { parseMs: 120_000, healthMs: 15_000 } as const;

const Health = z.object({ ok: z.literal(true), signedIn: z.boolean() });

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

    async parse(url, token, req) {
      let res: Response;
      let text: string;
      try {
        res = await fetch(`${url}/parse`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: bridgeBody(req),
          signal: AbortSignal.timeout(timeouts.parseMs),
        });
        text = await res.text();
      } catch (err) {
        return { kind: "unavailable", detail: reason(err) };
      }
      if (res.status === 409) return { kind: "signed_out" };
      if (res.status === 401) return { kind: "unauthorized" };
      if (!res.ok) return { kind: "unavailable", detail: `parse ${res.status}` };
      return { kind: "reply", reply: readBridgeReply(jsonOrNull(text)) ?? { kind: "reply", text: "", stop: "end", usage: NO_USAGE, reportedMicro: null } };
    },
  };
}
