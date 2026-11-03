import type { AgentKey } from "../domain";
import type { BoxName, BoxToken } from "./names.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const BOX_HOST_KINDS = ["fly", "static"] as const;
export type BoxHostKind = (typeof BOX_HOST_KINDS)[number];

export type HostFailure = { readonly ok: false; readonly retryable: boolean; readonly detail: string };
export type HostResult = { readonly ok: true } | HostFailure;

export const HOST_OK: HostResult = { ok: true };

/** Infrastructure only. Whether the box answers, and whether it is signed in, is the box client's question. */
export interface BoxHost {
  readonly kind: BoxHostKind;
  nameFor(agent: AgentKey): Promise<BoxName>;
  urlOf(name: BoxName): string;
  /** Converges on a running box. Safe to call again after any partial run. */
  ensure(name: BoxName, token: BoxToken): Promise<HostResult>;
}

/**
 * Every person shares the one box at the fixed URL, so the name is fixed too: the box holds one
 * BOX_TOKEN, and the token derives from the name.
 */
export function staticHost(cfg: { readonly url: string; readonly appPrefix: string }): BoxHost {
  const name = `${cfg.appPrefix}static` as BoxName;
  return {
    kind: "static",
    nameFor: async () => name,
    urlOf: () => cfg.url,
    ensure: async () => HOST_OK,
  };
}

