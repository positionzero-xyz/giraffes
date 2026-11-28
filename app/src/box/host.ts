import type { AgentKey } from "../domain";
import type { BoxName, BoxToken } from "./names.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const BOX_HOST_KINDS = ["fly", "static"] as const;
export type BoxHostKind = (typeof BOX_HOST_KINDS)[number];

export type HostFailure = { readonly ok: false; readonly retryable: boolean; readonly detail: string; readonly missing?: true };
export type HostResult = { readonly ok: true } | HostFailure;

export const HOST_OK: HostResult = { ok: true };

export type FlyDiskRetirement = {
  /** The mounted disk whose account wipe binds the proof; null when no single mounted disk can be proven. */
  readonly disk: string | null;
  readonly machine: string | null;
  /** Every live volume the app owns, so retirement destroys older or unattached disks too. */
  readonly disks: readonly string[];
};

export type FlyRetirementCheck =
  | { readonly ok: true; readonly state: "present" | "gone" }
  | HostFailure;

export interface FlyBoxRetirement {
  /** Run before wiping so the authenticated box proof can be bound to the mounted disk. */
  retirementTarget(name: BoxName): Promise<{ readonly ok: true; readonly target: FlyDiskRetirement } | HostFailure>;
  /** Re-read ownership and the saved identity without choosing a replacement volume. */
  retirementRecheck(name: BoxName, target: FlyDiskRetirement): Promise<FlyRetirementCheck>;
  /** Retire the identified disk after a wipe or when the caller has established no wipe is needed. */
  retireWipedDisk(name: BoxName, target: FlyDiskRetirement): Promise<HostResult & { readonly diskDeleteAccepted?: true }>;
  /** Run after the caller has durably recorded the disk retirement proof. */
  removeRetiredApp(name: BoxName): Promise<HostResult>;
}

export interface BoxHost {
  readonly kind: BoxHostKind;
  /** The image `ensure` puts on a machine; null when the host doesn't run one. */
  readonly image: string | null;
  nameFor(agent: AgentKey): Promise<BoxName>;
  urlOf(name: BoxName): string;
  ensure(name: BoxName, token: BoxToken): Promise<HostResult>;
  destroy(name: BoxName): Promise<HostResult>;
}

export function staticHost(cfg: { readonly url: string; readonly appPrefix: string }): BoxHost {
  const name = `${cfg.appPrefix}static` as BoxName;
  return {
    kind: "static",
    image: null,
    nameFor: async () => name,
    urlOf: () => cfg.url,
    ensure: async () => HOST_OK,
    destroy: async () => HOST_OK,
  };
}

