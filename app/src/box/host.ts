import type { AgentKey } from "../domain";
import type { BoxName, BoxToken } from "./names.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const BOX_HOST_KINDS = ["fly", "static"] as const;
export type BoxHostKind = (typeof BOX_HOST_KINDS)[number];

export type HostFailure = { readonly ok: false; readonly retryable: boolean; readonly detail: string };
export type HostResult = { readonly ok: true } | HostFailure;

export const HOST_OK: HostResult = { ok: true };

export interface BoxHost {
  readonly kind: BoxHostKind;
  nameFor(agent: AgentKey): Promise<BoxName>;
  urlOf(name: BoxName): string;
  ensure(name: BoxName, token: BoxToken): Promise<HostResult>;
  destroy(name: BoxName): Promise<HostResult>;
}

export function staticHost(cfg: { readonly url: string; readonly appPrefix: string }): BoxHost {
  const name = `${cfg.appPrefix}static` as BoxName;
  return {
    kind: "static",
    nameFor: async () => name,
    urlOf: () => cfg.url,
    ensure: async () => HOST_OK,
    destroy: async () => HOST_OK,
  };
}

