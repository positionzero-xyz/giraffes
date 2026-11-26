import type { AgentKey, Brand, EpochMs } from "../domain";
import { canonicalJsonObject, parseJsonObject, type JsonObject } from "./json";

export type OutsideWriteId = Brand<string, "OutsideWriteId">;
export type OperationId = Brand<string, "OperationId">;
export type OutsideApprovalId = Brand<string, "OutsideApprovalId">;

export const OUTSIDE_WRITE_STATUSES = ["approval_pending", "ready", "verifying", "uncertain", "succeeded", "failed", "dropped"] as const;
export type OutsideWriteStatus = (typeof OUTSIDE_WRITE_STATUSES)[number];

export type OutsideWrite = {
  readonly id: OutsideWriteId;
  readonly intent: string;
  readonly provider: string;
  readonly action: string;
  readonly operationId: OperationId;
  readonly args: JsonObject;
  readonly status: OutsideWriteStatus;
  readonly attempt: number;
  readonly leaseUntil: EpochMs | null;
  readonly receipt: JsonObject | null;
  readonly failure: string | null;
  readonly inDoubt: boolean;
  readonly createdAt: EpochMs;
  readonly updatedAt: EpochMs;
};

export type NewOutsideWrite = {
  readonly id: OutsideWriteId;
  readonly intent: string;
  readonly provider: string;
  readonly action: string;
  readonly operationId: OperationId;
  readonly args: JsonObject;
  readonly status: "approval_pending" | "ready";
  readonly now: EpochMs;
};

export const OUTSIDE_APPROVAL_STATUSES = ["pending", "approved", "consumed", "refused", "expired"] as const;
export type OutsideApprovalStatus = (typeof OUTSIDE_APPROVAL_STATUSES)[number];

export type OutsideApproval = {
  readonly id: OutsideApprovalId;
  readonly writeId: OutsideWriteId;
  readonly owner: AgentKey;
  readonly status: OutsideApprovalStatus;
  readonly expiresAt: EpochMs;
  readonly createdAt: EpochMs;
  readonly decidedAt: EpochMs | null;
  readonly decidedBy: AgentKey | null;
  readonly consumedAt: EpochMs | null;
};

export type NewOutsideApproval = {
  readonly id: OutsideApprovalId;
  readonly writeId: OutsideWriteId;
  readonly owner: AgentKey;
  readonly expiresAt: EpochMs;
  readonly now: EpochMs;
};

export type OutsideWriteDraft = { readonly write: NewOutsideWrite; readonly approval: NewOutsideApproval | null };

export function prepareOutsideWrite(input: {
  readonly intent: string;
  readonly provider: string;
  readonly action: string;
  readonly args: unknown;
  readonly now: EpochMs;
  readonly approval?: { readonly owner: AgentKey; readonly expiresAt: EpochMs };
}): OutsideWriteDraft | null {
  const args = parseJsonObject(input.args);
  if (args === undefined || input.intent === "" || input.provider === "" || input.action === "") return null;
  const writeId = crypto.randomUUID() as OutsideWriteId;
  return {
    write: {
      id: writeId,
      intent: input.intent,
      provider: input.provider,
      action: input.action,
      operationId: `ow_${crypto.randomUUID()}` as OperationId,
      args,
      status: input.approval ? "approval_pending" : "ready",
      now: input.now,
    },
    approval: input.approval
      ? { id: crypto.randomUUID() as OutsideApprovalId, writeId, owner: input.approval.owner, expiresAt: input.approval.expiresAt, now: input.now }
      : null,
  };
}

export type OutsideWriteCall = {
  readonly intent: string;
  readonly provider: string;
  readonly action: string;
  readonly operationId: OperationId;
  readonly args: JsonObject;
};

export type OutsideWriteAnswer =
  | { readonly kind: "accepted"; readonly receipt: JsonObject }
  | { readonly kind: "rejected"; readonly reason: string };

export type OutsideCheckAnswer =
  | { readonly kind: "accepted"; readonly receipt: JsonObject }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "unknown" };

export type OutsideProvider = {
  write(call: OutsideWriteCall, signal: AbortSignal): Promise<OutsideWriteAnswer>;
  check(call: OutsideWriteCall, signal: AbortSignal): Promise<OutsideCheckAnswer>;
};

export type WriteFinish =
  | { readonly kind: "succeeded"; readonly receipt: JsonObject }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "uncertain" };

export type WriteReconciliation =
  | { readonly kind: "succeeded"; readonly receipt: JsonObject }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "ready" }
  | { readonly kind: "uncertain" };

export type OutsideWriteStore = {
  outsideWrite(id: OutsideWriteId): OutsideWrite | null;
  beginOutsideWrite(id: OutsideWriteId, now: EpochMs, leaseMs: number): { readonly attempt: number } | null;
  finishOutsideWrite(id: OutsideWriteId, attempt: number, outcome: WriteFinish, now: EpochMs): boolean;
  reconcileOutsideWrite(id: OutsideWriteId, attempt: number, outcome: WriteReconciliation, now: EpochMs): boolean;
};

export type ApprovalDecision =
  | { readonly kind: "approved" | "refused" | "already_approved" | "already_refused" | "wrong_owner" | "expired" | "used" | "missing" };

export type ApprovalConsumption = { readonly kind: "consumed" | "mismatched" | "not_approved" | "used" | "expired" | "missing" | "unavailable" };

export type OutsideWritePut =
  | { readonly kind: "created" | "existing"; readonly write: OutsideWrite; readonly approval: OutsideApproval | null }
  | { readonly kind: "conflict"; readonly write: OutsideWrite };

const callOf = (write: OutsideWrite): OutsideWriteCall => ({
  intent: write.intent,
  provider: write.provider,
  action: write.action,
  operationId: write.operationId,
  args: write.args,
});

export const outsideWriteFingerprint = (write: OutsideWriteCall): string => `${write.provider}\n${write.action}\n${canonicalJsonObject(write.args)}`;

export type OutsideApprovalView = {
  readonly approvalId: OutsideApprovalId;
  readonly owner: AgentKey;
  readonly provider: string;
  readonly action: string;
  readonly args: JsonObject;
  readonly canonicalArgs: string;
  readonly expiresAt: EpochMs;
};

export function outsideApprovalView(write: OutsideWrite, approval: OutsideApproval): OutsideApprovalView | null {
  if (approval.writeId !== write.id) return null;
  return {
    approvalId: approval.id,
    owner: approval.owner,
    provider: write.provider,
    action: write.action,
    args: write.args,
    canonicalArgs: canonicalJsonObject(write.args),
    expiresAt: approval.expiresAt,
  };
}

export const OUTSIDE_WRITE_LEASE_MS = 30_000;

function answerOutcome(answer: OutsideWriteAnswer): WriteFinish {
  return answer.kind === "accepted" ? { kind: "succeeded", receipt: answer.receipt } : { kind: "failed", reason: answer.reason };
}

function checkOutcome(answer: OutsideCheckAnswer): WriteReconciliation {
  switch (answer.kind) {
    case "accepted":
      return { kind: "succeeded", receipt: answer.receipt };
    case "rejected":
      return { kind: "failed", reason: answer.reason };
    case "not_found":
      return { kind: "ready" };
    case "unknown":
      return { kind: "uncertain" };
  }
}

export async function advanceOutsideWrite(
  store: OutsideWriteStore,
  provider: OutsideProvider,
  id: OutsideWriteId,
  clock: { now(): EpochMs },
  leaseMs: number = OUTSIDE_WRITE_LEASE_MS,
): Promise<OutsideWrite | null> {
  const current = store.outsideWrite(id);
  if (current === null) return null;
  if (current.status === "approval_pending" || current.status === "succeeded" || current.status === "failed" || current.status === "dropped") return current;
  if (current.status === "ready") {
    const begun = store.beginOutsideWrite(id, clock.now(), leaseMs);
    if (begun === null) return store.outsideWrite(id);
    let outcome: WriteFinish;
    try {
      outcome = answerOutcome(await provider.write(callOf(current), AbortSignal.timeout(leaseMs)));
    } catch {
      outcome = { kind: "uncertain" };
    }
    store.finishOutsideWrite(id, begun.attempt, outcome, clock.now());
    return store.outsideWrite(id);
  }
  if (current.status === "verifying" && current.leaseUntil !== null && current.leaseUntil > clock.now()) return current;
  let answer: OutsideCheckAnswer;
  try {
    answer = await provider.check(callOf(current), AbortSignal.timeout(leaseMs));
  } catch {
    answer = { kind: "unknown" };
  }
  store.reconcileOutsideWrite(id, current.attempt, checkOutcome(answer), clock.now());
  return store.outsideWrite(id);
}
