import type { EpochMs } from "../domain";
import type { BoxHostKind } from "./host";
import type { BoxName } from "./names";

export const BOX = {
  pollEveryMs: 30_000,
  pollForMs: 30 * 60_000,
  ticketForMs: 30 * 60_000,
  provisionRetryBaseMs: 15_000,
  provisionRetryMaxMs: 5 * 60_000,
  maxProvisionAttempts: 10,
  reclaimAfterMs: 48 * 60 * 60_000,
  reclaimRetryMaxMs: 60 * 60_000,
} as const;

export const BOX_STATES = ["provisioning", "signed_out", "signed_in", "failed", "reclaiming"] as const;
export type BoxState = (typeof BOX_STATES)[number];

export type BoxStatus =
  | { readonly state: "provisioning"; readonly attempts: number; readonly retryAt: EpochMs }
  | {
      readonly state: "signed_out";
      readonly linkSentAt: EpochMs | null;
      readonly pollAt: EpochMs | null;
      readonly pollUntil: EpochMs | null;
      readonly reclaimAt: EpochMs | null;
    }
  | { readonly state: "signed_in" }
  | { readonly state: "failed"; readonly error: string }
  | { readonly state: "reclaiming"; readonly attempts: number; readonly retryAt: EpochMs };

export type Box = { readonly name: BoxName; readonly host: BoxHostKind; readonly url: string; readonly stateAt: EpochMs } & BoxStatus;

export type Probe = { readonly kind: "up"; readonly signedIn: boolean } | { readonly kind: "down"; readonly retryable: boolean; readonly detail: string };

export const BOX_SAYS = [
  "unavailable",
  "full",
  "setting_up",
  "still_setting_up",
  "link",
  "signed_out_link",
  "connected",
  "already_connected",
  "setup_failed",
  "reclaimed",
  "resetting",
  "not_in_plan",
] as const;
export type BoxSay = (typeof BOX_SAYS)[number];

export type Transition = { readonly box: Box; readonly say: BoxSay | null };
export type Reply = { readonly box: Box; readonly say: BoxSay };
export type Step =
  | { readonly kind: "probe"; readonly box: Box }
  | { readonly kind: "reclaim"; readonly box: Box }
  | ({ readonly kind: "settled" } & Reply);

const LINK_NOTE = "<sign-in link>";

const SAY: Readonly<Record<BoxSay, (link: string) => string>> = {
  unavailable: () => "Connecting your own Claude plan isn't available yet.",
  full: () => "I can't connect another Claude plan right now. Please try again later.",
  setting_up: () => "Setting up your Claude connection. I'll send you a sign-in link in a few minutes.",
  still_setting_up: () => "Your Claude connection is still being set up. I'll send the sign-in link when it's ready.",
  link: (link) => `Sign in to Claude here to connect your plan. The link works for 30 minutes.\n${link}`,
  signed_out_link: (link) =>
    `Your Claude plan is signed out, so I'm answering without it for now. Sign in again here. The link works for 30 minutes.\n${link}`,
  connected: () => "Your Claude plan is connected. Your messages now use your Claude plan.",
  already_connected: () => "Your Claude plan is already connected.",
  setup_failed: () => "I couldn't set up your Claude connection. Send /claude to try again.",
  reclaimed: () => "Nobody signed in to your Claude connection for 2 days, so I removed it. Send /claude to set it up again.",
  resetting: () => "I'm removing your unused Claude connection. Send /claude again in a minute.",
  not_in_plan: () => "Your plan doesn't include connecting your own Claude plan. Send /plan to see the plans.",
};

export const needsLink = (say: BoxSay): boolean => say === "link" || say === "signed_out_link";

export function boxMessage(say: BoxSay, link: string | null): { readonly text: string; readonly note: string } {
  return { text: SAY[say](link ?? LINK_NOTE), note: SAY[say](LINK_NOTE) };
}

function to(b: Box, status: BoxStatus, now: EpochMs): Box {
  return { name: b.name, host: b.host, url: b.url, stateAt: status.state === b.state ? b.stateAt : now, ...status };
}

const provisioning = (attempts: number, retryAt: EpochMs): BoxStatus => ({ state: "provisioning", attempts, retryAt });

const reclaiming = (attempts: number, now: EpochMs): BoxStatus => ({
  state: "reclaiming",
  attempts,
  retryAt: (now + Math.min(BOX.provisionRetryBaseMs * 2 ** (attempts - 1), BOX.reclaimRetryMaxMs)) as EpochMs,
});

function linkSent(b: Box, reclaimAt: EpochMs | null, now: EpochMs): Box {
  return to(
    b,
    { state: "signed_out", linkSentAt: now, pollAt: (now + BOX.pollEveryMs) as EpochMs, pollUntil: (now + BOX.pollForMs) as EpochMs, reclaimAt },
    now,
  );
}

export function newBox(name: BoxName, host: BoxHostKind, url: string, now: EpochMs): Box {
  return { name, host, url, stateAt: now, ...provisioning(0, now) };
}

export function dueAt(b: Box): EpochMs | null {
  switch (b.state) {
    case "provisioning":
    case "reclaiming":
      return b.retryAt;
    case "signed_out": {
      const times = [b.pollAt, b.reclaimAt].filter((t): t is EpochMs => t !== null);
      return times.length > 0 ? (Math.min(...times) as EpochMs) : null;
    }
    case "signed_in":
    case "failed":
      return null;
  }
}

export function beginStep(b: Box, now: EpochMs): Step | null {
  const due = dueAt(b);
  if (due === null || due > now) return null;
  switch (b.state) {
    case "provisioning": {
      if (b.attempts >= BOX.maxProvisionAttempts) {
        return { kind: "settled", box: to(b, { state: "failed", error: `no answer after ${b.attempts} attempts` }, now), say: "setup_failed" };
      }
      const backoff = Math.min(BOX.provisionRetryBaseMs * 2 ** b.attempts, BOX.provisionRetryMaxMs);
      return { kind: "probe", box: to(b, provisioning(b.attempts + 1, (now + backoff) as EpochMs), now) };
    }
    case "signed_out": {
      if (b.reclaimAt !== null && b.reclaimAt <= now) return { kind: "reclaim", box: to(b, reclaiming(1, now), now) };
      const next = now + BOX.pollEveryMs;
      const pollAt = b.pollUntil !== null && next <= b.pollUntil ? (next as EpochMs) : null;
      return { kind: "probe", box: to(b, { ...b, pollAt }, now) };
    }
    case "reclaiming":
      return { kind: "reclaim", box: to(b, reclaiming(b.attempts + 1, now), now) };
    case "signed_in":
    case "failed":
      return null;
  }
}

export function afterProbe(b: Box, probe: Probe, now: EpochMs): Transition {
  switch (b.state) {
    case "provisioning":
      if (probe.kind === "up") {
        if (probe.signedIn) return { box: to(b, { state: "signed_in" }, now), say: "connected" };
        return { box: linkSent(b, (now + BOX.reclaimAfterMs) as EpochMs, now), say: "link" };
      }
      if (probe.retryable && b.attempts < BOX.maxProvisionAttempts) return { box: b, say: null };
      return { box: to(b, { state: "failed", error: probe.detail }, now), say: "setup_failed" };
    case "signed_out":
    case "reclaiming":
      return probe.kind === "up" && probe.signedIn ? { box: to(b, { state: "signed_in" }, now), say: "connected" } : { box: b, say: null };
    case "signed_in":
    case "failed":
      return { box: b, say: null };
  }
}

export function onCommand(b: Box, now: EpochMs): Reply {
  switch (b.state) {
    case "provisioning":
      return { box: b, say: "still_setting_up" };
    case "signed_out":
      return { box: linkSent(b, b.reclaimAt, now), say: "link" };
    case "failed":
      return { box: to(b, provisioning(0, now), now), say: "setting_up" };
    case "signed_in":
      return { box: b, say: "already_connected" };
    case "reclaiming":
      return { box: b, say: "resetting" };
  }
}

export function onSignedOut(b: Box, now: EpochMs): Reply {
  return { box: linkSent(b, null, now), say: "signed_out_link" };
}
