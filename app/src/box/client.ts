import { z } from "zod";
import { readBridgeReply, UNREADABLE_REPLY, type JsonSchema, type WireResult } from "../model/client";
import type { Fetch } from "./host";
import type { BoxToken } from "./names";

export type BoxHealth =
  | { readonly kind: "up"; readonly signedIn: boolean; readonly box?: string }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable"; readonly detail: string };

export type BoxAt = { readonly box: string; readonly epoch: number };
export type AccountBoxErase = BoxAt & { readonly scope: "account" };

export type BoxRequest = { readonly model: string; readonly system: string; readonly user: string; readonly jsonSchema: JsonSchema; readonly at?: BoxAt };
export type BoxAgentRequest = {
  readonly model: string;
  readonly append: string;
  readonly session: string | null;
  /** Opaque per-person key for the box's rollback session file on a shared static box. */
  readonly sessionOwner?: string;
  readonly turn: string;
  readonly fresh: string;
  readonly tools: readonly unknown[];
  /** True for a one-off session the box must delete after the turn. */
  readonly ephemeral?: boolean;
  readonly at?: BoxAt;
};

export type SessionUsed = { readonly id: string; readonly resumed: boolean };

export type BoxReply =
  /** The CLI answered; whether the answer is valid is the caller's to decide. */
  | { readonly kind: "reply"; readonly reply: Extract<WireResult, { kind: "reply" }>; readonly session?: SessionUsed }
  | { readonly kind: "signed_out" }
  | { readonly kind: "stale" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable"; readonly detail: string };

export type BoxErase =
  | { readonly kind: "erased"; readonly box: string; readonly floor: number; readonly scope?: "account" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "pending"; readonly detail: string };

export interface BoxClient {
  health(url: string, token: BoxToken): Promise<BoxHealth>;
  parse(url: string, token: BoxToken, req: BoxRequest): Promise<BoxReply>;
  /** The reply's text is JSON containing the session's answer and its accepted and refused tool calls. */
  agent(url: string, token: BoxToken, req: BoxAgentRequest): Promise<BoxReply>;
  erase(url: string, token: BoxToken, request: number | BoxAt | AccountBoxErase): Promise<BoxErase>;
}

export const BOX_TIMEOUTS = { parseMs: 120_000, healthMs: 15_000 } as const;

const Health = z.object({ ok: z.literal(true), signedIn: z.boolean(), box: z.uuid().optional().catch(undefined) });
const Erased = z.object({ box: z.uuid(), floor: z.number().int(), scope: z.literal("account").optional() });
const Stale = z.object({ error: z.literal("stale") });
const Session = z.object({ id: z.uuid(), resumed: z.boolean() });
const AgentBody = z.object({
  text: z.string(),
  calls: z.array(z.unknown()),
  refusedCalls: z.unknown().optional(),
  session: Session.optional().catch(undefined),
  usage: z.unknown(),
  stop: z.unknown(),
});

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const reason = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

const atFields = (at: BoxAt | undefined) => (at ? { box: at.box, epoch: at.epoch } : {});

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
      if (!parsed.success) return { kind: "unavailable", detail: "health reply unreadable" };
      const { signedIn, box } = parsed.data;
      return box === undefined ? { kind: "up", signedIn } : { kind: "up", signedIn, box };
    },

    parse: (url, token, req) =>
      post(url, token, "parse", JSON.stringify({ model: req.model, system: req.system, user: req.user, jsonSchema: req.jsonSchema, ...atFields(req.at) }), (raw) => {
        const reply = readBridgeReply(raw);
        return reply && { reply };
      }),

    // A box image without the one-off route answers it 404, so a one-off never runs in the person's session there.
    agent: (url, token, { at, ...req }) =>
      post(url, token, req.ephemeral === true ? "agent/once" : "agent", JSON.stringify({ ...req, ...atFields(at) }), (raw) => {
        const body = AgentBody.safeParse(raw);
        if (!body.success) return null;
        const { usage, stop, session, ...structured } = body.data;
        const reply = readBridgeReply({ structured, usage, stop });
        return reply && { reply, session };
      }),

    async erase(url, token, request) {
      const erase = typeof request === "number" ? { epoch: request } : request;
      let res: Response;
      let body: unknown;
      try {
        res = await fetch(`${url}/erase`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(erase),
          signal: AbortSignal.timeout(timeouts.parseMs),
        });
        body = await res.json().catch(() => null);
      } catch (err) {
        return { kind: "pending", detail: reason(err) };
      }
      if (res.status === 401) return { kind: "unauthorized" };
      if (!res.ok) return { kind: "pending", detail: `erase ${res.status}` };
      const erased = Erased.safeParse(body);
      if (!erased.success || erased.data.floor < erase.epoch) return { kind: "pending", detail: "erase reply unreadable" };
      if ("box" in erase && erased.data.box !== erase.box) return { kind: "pending", detail: "erase disk not verified" };
      if ("scope" in erase && erased.data.scope !== erase.scope) {
        return { kind: "pending", detail: "account erase not verified" };
      }
      return { kind: "erased", ...erased.data };
    },
  };

  async function post(
    url: string,
    token: BoxToken,
    path: "parse" | "agent" | "agent/once",
    body: string,
    read: (raw: unknown) => { readonly reply: Extract<WireResult, { kind: "reply" }>; readonly session?: SessionUsed } | null,
  ): Promise<BoxReply> {
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
    if (res.status === 412 && Stale.safeParse(jsonOrNull(text)).success) return { kind: "stale" };
    if (res.status === 401) return { kind: "unauthorized" };
    if (!res.ok) return { kind: "unavailable", detail: `${path} ${res.status}` };
    return { kind: "reply", ...(read(jsonOrNull(text)) ?? { reply: UNREADABLE_REPLY }) };
  }
}
