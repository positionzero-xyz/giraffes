import type { EpochMs } from "../domain";
import type { BoxHostKind } from "./host";
import type { BoxName } from "./names";

export const BOX = {
  pollEveryMs: 30_000,
  pollForMs: 30 * 60_000,
  ticketForMs: 30 * 60_000,
  /** A code posted just before its ticket expires can take the box's 60 s exit wait to land. */
  signinGraceMs: 2 * 60_000,
  provisionRetryBaseMs: 15_000,
  provisionRetryMaxMs: 5 * 60_000,
  maxProvisionAttempts: 10,
  reclaimAfterMs: 48 * 60 * 60_000,
  lastLookRetryMs: 5 * 60_000,
  reclaimRetryMaxMs: 60 * 60_000,
  retireAfterMs: 14 * 24 * 60 * 60_000,
} as const;

export const BOX_STATES = ["provisioning", "signed_out", "signed_in", "reclaiming"] as const;
export type BoxState = (typeof BOX_STATES)[number];

export const RECLAIM_REASONS = ["unused", "failed", "retired"] as const;
export type ReclaimReason = (typeof RECLAIM_REASONS)[number];

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
  | { readonly state: "reclaiming"; readonly reason: ReclaimReason; readonly attempts: number; readonly retryAt: EpochMs };

export type Box = {
  readonly name: BoxName;
  readonly host: BoxHostKind;
  readonly url: string;
  readonly stateAt: EpochMs;
  /** Set while the person's plan doesn't allow a box; the box is reclaimed then unless the plan allows one again. */
  readonly retireAt: EpochMs | null;
} & BoxStatus;
type Provisioning = Extract<Box, { state: "provisioning" }>;
type SignedOut = Extract<Box, { state: "signed_out" }>;
type Reclaiming = Extract<Box, { state: "reclaiming" }>;

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
  "retiring",
  "retired",
] as const;
export type BoxSay = (typeof BOX_SAYS)[number];

export type Transition = { readonly box: Box; readonly say: BoxSay | null };
export type Reply = { readonly box: Box; readonly say: BoxSay };

/** What one drain does with a box: `provision` ensures it on the host and probes it, `poll` and `last_look` probe it, `reclaim` removes it. */
export type Step =
  | { readonly kind: "provision"; readonly box: Provisioning }
  | { readonly kind: "poll" | "last_look"; readonly box: SignedOut }
  | { readonly kind: "reclaim"; readonly box: Reclaiming };
export type ProbeStep = Exclude<Step, { kind: "reclaim" }>;

const LINK_NOTE = "<sign-in link>";

const SAY: Readonly<Record<BoxSay, (link: string, until: string) => string>> = {
  unavailable: () => "Connecting your own Claude plan isn't available yet.",
  full: () => "I can't connect another Claude plan right now. Please try again later.",
  setting_up: () => "Setting up your Claude connection. I'll send you a sign-in link in a few minutes.",
  still_setting_up: () => "Your Claude connection is still being set up. I'll send the sign-in link when it's ready.",
  link: (link) => `Sign in to Claude here to connect your plan. The link works for 30 minutes.\n${link}`,
  signed_out_link: (link) =>
    `Your Claude plan is signed out, so I'm answering without it for now. Sign in again here. The link works for 30 minutes.\n${link}`,
  connected: () => "Your Claude plan is connected. Your messages now use your Claude plan.",
  already_connected: () => "Your Claude plan is already connected.",
  setup_failed: () => "I couldn't set up your Claude connection. Send /claude to start over.",
  reclaimed: () => "Nobody signed in to your Claude connection for 2 days, so I removed it. Send /claude to set it up again.",
  resetting: () => "I'm removing your old Claude connection. Send /claude again in a few minutes.",
  not_in_plan: () => "Your plan doesn't include connecting your own Claude plan. Send /plan to see the plans.",
  retiring: (_, until) =>
    `Your plan doesn't include connecting your own Claude plan, so I'll remove your Claude connection on ${until} unless your plan resumes. Send /plan to see the plans.`,
  retired: () => "Your plan doesn't include connecting your own Claude plan, so I removed your Claude connection. Send /plan to see the plans.",
};

export const needsLink = (say: BoxSay): boolean => say === "link" || say === "signed_out_link";

export function boxMessage(say: BoxSay, link: string | null, until: string = ""): { readonly text: string; readonly note: string } {
  return { text: SAY[say](link ?? LINK_NOTE, until), note: SAY[say](LINK_NOTE, until) };
}

const GONE: Readonly<Record<ReclaimReason, BoxSay>> = { unused: "reclaimed", failed: "setup_failed", retired: "retired" };

export const goneMessage = (b: Reclaiming) => boxMessage(GONE[b.reason], null);

function to(b: Box, status: BoxStatus, now: EpochMs): Box {
  return { name: b.name, host: b.host, url: b.url, stateAt: status.state === b.state ? b.stateAt : now, retireAt: b.retireAt, ...status };
}

const provisioning = (attempts: number, retryAt: EpochMs): BoxStatus => ({ state: "provisioning", attempts, retryAt });

const reclaimNow = (b: Box, reason: ReclaimReason, now: EpochMs): Box => to(b, { state: "reclaiming", reason, attempts: 0, retryAt: now }, now);

const backoff = (attempts: number, maxMs: number) => Math.min(BOX.provisionRetryBaseMs * 2 ** attempts, maxMs);

function linkSent(b: Box, reclaimAt: EpochMs | null, now: EpochMs): Box {
  return to(
    b,
    { state: "signed_out", linkSentAt: now, pollAt: (now + BOX.pollEveryMs) as EpochMs, pollUntil: (now + BOX.pollForMs) as EpochMs, reclaimAt },
    now,
  );
}

/** Every link's ticket has expired, and any code posted with it has landed, before the box is reclaimed. */
function reclaimAfterLink(reclaimAt: EpochMs, now: EpochMs): EpochMs {
  return Math.max(reclaimAt, now + BOX.ticketForMs + BOX.signinGraceMs) as EpochMs;
}

export function newBox(name: BoxName, host: BoxHostKind, url: string, now: EpochMs): Box {
  return { name, host, url, stateAt: now, retireAt: null, ...provisioning(0, now) };
}

export function dueAt(b: Box): EpochMs | null {
  const own = stateDueAt(b);
  if (b.state === "reclaiming" || b.retireAt === null) return own;
  return own === null ? b.retireAt : (Math.min(own, b.retireAt) as EpochMs);
}

function stateDueAt(b: Box): EpochMs | null {
  switch (b.state) {
    case "provisioning":
    case "reclaiming":
      return b.retryAt;
    case "signed_out": {
      const times = [b.pollAt, b.reclaimAt].filter((t): t is EpochMs => t !== null);
      return times.length > 0 ? (Math.min(...times) as EpochMs) : null;
    }
    case "signed_in":
      return null;
  }
}

/** The step due now, with the box as it must be stored before the step runs, so a crash mid-step retries later rather than at once. */
export function beginStep(b: Box, now: EpochMs): Step | null {
  const due = dueAt(b);
  if (due === null || due > now) return null;
  if (b.state !== "reclaiming" && b.retireAt !== null && b.retireAt <= now) return beginStep(reclaimNow(b, "retired", now), now);
  switch (b.state) {
    case "provisioning":
      if (b.attempts >= BOX.maxProvisionAttempts) return beginStep(reclaimNow(b, "failed", now), now);
      return { kind: "provision", box: { ...b, attempts: b.attempts + 1, retryAt: (now + backoff(b.attempts, BOX.provisionRetryMaxMs)) as EpochMs } };
    case "signed_out": {
      if (b.reclaimAt !== null && b.reclaimAt <= now) return { kind: "last_look", box: { ...b, reclaimAt: (now + BOX.lastLookRetryMs) as EpochMs } };
      const next = now + BOX.pollEveryMs;
      return { kind: "poll", box: { ...b, pollAt: b.pollUntil !== null && next <= b.pollUntil ? (next as EpochMs) : null } };
    }
    case "reclaiming": {
      const retryAt = (now + backoff(b.attempts, BOX.reclaimRetryMaxMs)) as EpochMs;
      return { kind: "reclaim", box: { ...b, attempts: b.attempts + 1, retryAt } };
    }
    case "signed_in":
      return null;
  }
}

export function afterProbe(step: ProbeStep, probe: Probe, now: EpochMs): Transition {
  const b = step.box;
  if (probe.kind === "up" && probe.signedIn) return { box: to(b, { state: "signed_in" }, now), say: "connected" };
  switch (step.kind) {
    case "provision":
      if (probe.kind === "up") return { box: linkSent(b, (now + BOX.reclaimAfterMs) as EpochMs, now), say: "link" };
      if (probe.retryable && step.box.attempts < BOX.maxProvisionAttempts) return { box: b, say: null };
      return { box: reclaimNow(b, "failed", now), say: null };
    case "last_look":
      return probe.kind === "up" ? { box: reclaimNow(b, "unused", now), say: null } : { box: b, say: null };
    case "poll":
      return { box: b, say: null };
  }
}

export function onCommand(b: Box, now: EpochMs): Reply {
  switch (b.state) {
    case "provisioning":
      return { box: b, say: "still_setting_up" };
    case "signed_out":
      return { box: linkSent(b, b.reclaimAt === null ? null : reclaimAfterLink(b.reclaimAt, now), now), say: "link" };
    case "signed_in":
      return { box: b, say: "already_connected" };
    case "reclaiming":
      return { box: b, say: "resetting" };
  }
}

/** With billing on, a box outlives the plan that allowed it by `retireAfterMs`, and the person is told once when that starts. */
export function onPlan(b: Box, allowsBox: boolean, now: EpochMs): Transition {
  if (b.state === "reclaiming" || allowsBox === (b.retireAt === null)) return { box: b, say: null };
  if (allowsBox) return { box: { ...b, retireAt: null }, say: null };
  return { box: { ...b, retireAt: (now + BOX.retireAfterMs) as EpochMs }, say: "retiring" };
}

export function onSignedOut(b: Box, now: EpochMs): Reply {
  return { box: linkSent(b, null, now), say: "signed_out_link" };
}
