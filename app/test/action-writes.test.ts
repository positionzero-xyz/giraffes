import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { advanceOutsideWrite, outsideApprovalView, prepareOutsideWrite, type OutsideProvider, type OutsideWriteCall } from "../src/action/writes";
import type { JsonObject } from "../src/action/json";
import { AgentStore } from "../src/agent/store";
import type { AgentKey, EpochMs } from "../src/domain";
import { fakeClock, local } from "./testkit";

const owner = "p:telegram:owner" as AgentKey;
const other = "p:telegram:other" as AgentKey;

type WriteStep = "accept" | "accept_then_lost" | "lost";
type CheckStep = "truth" | "not_found" | "unknown";

function fakeOutsideProvider(writeSteps: readonly WriteStep[] = [], checkSteps: readonly CheckStep[] = []) {
  const accepted = new Map<string, JsonObject>();
  const writes: OutsideWriteCall[] = [];
  const checks: OutsideWriteCall[] = [];
  const writeQueue = [...writeSteps];
  const checkQueue = [...checkSteps];
  const provider: OutsideProvider = {
    async write(call) {
      writes.push(call);
      const step = writeQueue.shift() ?? "accept";
      const receipt = { id: `receipt-${writes.length}`, operation: call.operationId };
      if (step !== "lost") accepted.set(call.operationId, receipt);
      if (step === "accept_then_lost" || step === "lost") throw new TypeError("response lost");
      return { kind: "accepted", receipt };
    },
    async check(call) {
      checks.push(call);
      const step = checkQueue.shift() ?? "truth";
      if (step === "unknown") return { kind: "unknown" };
      const receipt = accepted.get(call.operationId);
      if (step === "truth" && receipt !== undefined) return { kind: "accepted", receipt };
      return { kind: "not_found" };
    },
  };
  return { provider, writes, checks };
}

async function inStore<T>(name: string, run: (store: AgentStore) => Promise<T> | T): Promise<T> {
  const stub = env.AGENT.get(env.AGENT.idFromName(`action-${name}`));
  return runInDurableObject(stub, (_agent, state) => run(new AgentStore(state.storage)));
}

const start = local("2099-11-04T10:00");
const sendArgs = { to: "a@example.com", subject: "Lunch", body: "Shall we eat at noon?" };

function draft(intent: string, args: unknown = sendArgs, now: EpochMs = start, approval: { readonly owner: AgentKey; readonly expiresAt: EpochMs } | undefined = undefined) {
  const made = prepareOutsideWrite({ intent, provider: "mail", action: "send", args, now, approval });
  if (!made) throw new Error("bad test write");
  return made;
}

test("a repeated write intent reuses the durable record and its stable operation id", async () => {
  await inStore("dedupe", (store) => {
    const first = draft("event-1:send-0");
    const created = store.putOutsideWrite(first.write, null);
    const replay = draft("event-1:send-0");
    const repeated = store.putOutsideWrite(replay.write, null);
    expect(created.kind).toBe("created");
    expect(repeated.kind).toBe("existing");
    if (created.kind === "conflict" || repeated.kind === "conflict") throw new Error("unexpected conflict");
    expect(repeated.write.id).toBe(created.write.id);
    expect(repeated.write.operationId).toBe(created.write.operationId);
    expect(repeated.write.operationId).not.toBe(replay.write.operationId);
    expect(repeated.write.status).toBe("ready");
  });
});

test("a replayed approval request keeps the original approval rather than extending it", async () => {
  await inStore("approval-dedupe", (store) => {
    const firstExpiry = (start + 15 * 60_000) as EpochMs;
    const laterExpiry = (start + 60 * 60_000) as EpochMs;
    const first = draft("event-12:send-0", sendArgs, start, { owner, expiresAt: firstExpiry });
    const replay = draft("event-12:send-0", sendArgs, (start + 1_000) as EpochMs, { owner, expiresAt: laterExpiry });
    const created = store.putOutsideWrite(first.write, first.approval);
    const repeated = store.putOutsideWrite(replay.write, replay.approval);
    if (created.kind === "conflict" || repeated.kind === "conflict" || !created.approval || !repeated.approval) throw new Error("unexpected conflict");
    expect(repeated.kind).toBe("existing");
    expect(repeated.approval.id).toBe(created.approval.id);
    expect(repeated.approval.expiresAt).toBe(firstExpiry);
  });
});

test("a lost response is reconciled from the provider before any retry and does not double-send", async () => {
  await inStore("lost-response", async (store) => {
    const clock = fakeClock(start);
    const fake = fakeOutsideProvider(["accept_then_lost"]);
    const made = draft("event-2:send-0");
    const put = store.putOutsideWrite(made.write, null);
    if (put.kind === "conflict") throw new Error("unexpected conflict");

    const first = await advanceOutsideWrite(store, fake.provider, put.write.id, clock);
    expect(first).toMatchObject({ status: "uncertain", receipt: null, attempt: 1 });
    expect(fake.writes).toHaveLength(1);

    const second = await advanceOutsideWrite(store, fake.provider, put.write.id, clock);
    expect(second).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(second?.receipt).toMatchObject({ id: "receipt-1", operation: put.write.operationId });
    expect(fake.writes).toHaveLength(1);
    expect(fake.checks).toHaveLength(1);
    expect(fake.checks[0].operationId).toBe(put.write.operationId);
  });
});

test("a write retried only after a real not-found check keeps the same operation id", async () => {
  await inStore("safe-retry", async (store) => {
    const clock = fakeClock(start);
    const fake = fakeOutsideProvider(["lost", "accept"], ["not_found"]);
    const made = draft("event-3:send-0");
    const put = store.putOutsideWrite(made.write, null);
    if (put.kind === "conflict") throw new Error("unexpected conflict");

    expect((await advanceOutsideWrite(store, fake.provider, put.write.id, clock))?.status).toBe("uncertain");
    expect((await advanceOutsideWrite(store, fake.provider, put.write.id, clock))?.status).toBe("ready");
    expect(fake.writes).toHaveLength(1);
    expect((await advanceOutsideWrite(store, fake.provider, put.write.id, clock))?.status).toBe("succeeded");
    expect(fake.writes).toHaveLength(2);
    expect(fake.writes.map((call) => call.operationId)).toEqual([put.write.operationId, put.write.operationId]);
    expect(fake.checks).toHaveLength(1);
  });
});

test("an unknown outcome stays uncertain and is never retried blindly", async () => {
  await inStore("uncertain", async (store) => {
    const clock = fakeClock(start);
    const fake = fakeOutsideProvider(["accept_then_lost"], ["unknown"]);
    const made = draft("event-4:send-0");
    const put = store.putOutsideWrite(made.write, null);
    if (put.kind === "conflict") throw new Error("unexpected conflict");

    expect((await advanceOutsideWrite(store, fake.provider, put.write.id, clock))?.status).toBe("uncertain");
    expect((await advanceOutsideWrite(store, fake.provider, put.write.id, clock))?.status).toBe("uncertain");
    expect(fake.writes).toHaveLength(1);
    expect(fake.checks).toHaveLength(1);
    expect(store.outsideWrite(put.write.id)?.receipt).toBeNull();
  });
});

test("a lease abandoned by a crash is checked rather than treated as done or retried early", async () => {
  await inStore("crash-lease", async (store) => {
    const clock = fakeClock(start);
    const fake = fakeOutsideProvider(["accept"]);
    const made = draft("event-7:send-0");
    const put = store.putOutsideWrite(made.write, null);
    if (put.kind === "conflict") throw new Error("unexpected conflict");

    const begun = store.beginOutsideWrite(put.write.id, start, 1_000);
    expect(begun).toEqual({ attempt: 1 });
    await fake.provider.write(
      { intent: put.write.intent, provider: put.write.provider, action: put.write.action, operationId: put.write.operationId, args: put.write.args },
      AbortSignal.timeout(1_000),
    );

    expect((await advanceOutsideWrite(store, fake.provider, put.write.id, clock))?.status).toBe("verifying");
    expect(fake.checks).toHaveLength(0);
    clock.set((start + 1_001) as EpochMs);
    expect((await advanceOutsideWrite(store, fake.provider, put.write.id, clock))?.status).toBe("succeeded");
    expect(fake.writes).toHaveLength(1);
    expect(fake.checks).toHaveLength(1);
  });
});

test("the exact action stored for an approval cannot be edited underneath it", async () => {
  const stub = env.AGENT.get(env.AGENT.idFromName("action-immutable"));
  await runInDurableObject(stub, (_agent, state) => {
    const store = new AgentStore(state.storage);
    const expiresAt = (start + 15 * 60_000) as EpochMs;
    const made = draft("event-8:send-0", sendArgs, start, { owner, expiresAt });
    const put = store.putOutsideWrite(made.write, made.approval);
    if (put.kind === "conflict" || !put.approval) throw new Error("approval missing");

    const approval = put.approval;
    const view = outsideApprovalView(put.write, approval);
    expect(view).toMatchObject({ provider: "mail", action: "send", owner, canonicalArgs: JSON.stringify({ body: sendArgs.body, subject: sendArgs.subject, to: sendArgs.to }) });
    expect(() => state.storage.sql.exec("UPDATE outside_write SET args = ? WHERE id = ?", JSON.stringify({ to: "attacker@example.com" }), put.write.id)).toThrow();
    expect(store.outsideWrite(put.write.id)?.args).toEqual(sendArgs);
    expect(() => state.storage.sql.exec("UPDATE outside_approval SET write_id = ? WHERE id = ?", "other", approval.id)).toThrow();
  });
});

test("a forget closes waiting and in-flight outside writes without recovery or retry", async () => {
  await inStore("forget-closes", async (store) => {
    const clock = fakeClock(start);
    const fake = fakeOutsideProvider();
    const waiting = draft("event-11:send-0");
    const waitingPut = store.putOutsideWrite(waiting.write, null);
    const expiresAt = (start + 15 * 60_000) as EpochMs;
    const approved = draft("event-11:send-1", sendArgs, start, { owner, expiresAt });
    const approvedPut = store.putOutsideWrite(approved.write, approved.approval);
    if (waitingPut.kind === "conflict" || approvedPut.kind === "conflict" || !approvedPut.approval) throw new Error("unexpected conflict");

    expect(store.beginOutsideWrite(waitingPut.write.id, start, 1_000)).toEqual({ attempt: 1 });
    store.beginForget({ at: start, seq: null }, start);

    expect(store.outsideWrite(waitingPut.write.id)).toMatchObject({ status: "dropped", inDoubt: true, leaseUntil: null });
    expect(store.outsideWrite(approvedPut.write.id)).toMatchObject({ status: "dropped", inDoubt: false });
    expect(store.outsideApproval(approvedPut.approval.id)?.status).toBe("expired");
    clock.set((start + 2_000) as EpochMs);
    expect((await advanceOutsideWrite(store, fake.provider, waitingPut.write.id, clock))?.status).toBe("dropped");
    expect((await advanceOutsideWrite(store, fake.provider, approvedPut.write.id, clock))?.status).toBe("dropped");
    expect(fake.writes).toHaveLength(0);
    expect(fake.checks).toHaveLength(0);
  });
});

test("the owner approves the exact write once; others, repeats and changed arguments do not authorize it", async () => {
  await inStore("approval-exact", async (store) => {
    const clock = fakeClock(start);
    const fake = fakeOutsideProvider();
    const expiresAt = (start + 15 * 60_000) as EpochMs;
    const made = draft("event-5:send-0", sendArgs, start, { owner, expiresAt });
    const put = store.putOutsideWrite(made.write, made.approval);
    if (put.kind === "conflict" || !put.approval) throw new Error("approval missing");

    expect((await advanceOutsideWrite(store, fake.provider, put.write.id, clock))?.status).toBe("approval_pending");
    expect(store.decideOutsideApproval(put.approval.id, other, "approve", clock.now())).toEqual({ kind: "wrong_owner" });
    expect(store.decideOutsideApproval(put.approval.id, owner, "approve", clock.now())).toEqual({ kind: "approved" });

    const changed = draft("event-5:send-1", { ...sendArgs, body: "Shall we eat at one?" }, start, { owner, expiresAt });
    const changedPut = store.putOutsideWrite(changed.write, changed.approval);
    if (changedPut.kind === "conflict") throw new Error("unexpected conflict");
    expect(store.consumeOutsideApproval(put.approval.id, changedPut.write.id, clock.now())).toEqual({ kind: "mismatched" });
    expect(store.outsideWrite(changedPut.write.id)?.status).toBe("approval_pending");

    expect(store.consumeOutsideApproval(put.approval.id, put.write.id, clock.now())).toEqual({ kind: "consumed" });
    expect(store.consumeOutsideApproval(put.approval.id, put.write.id, clock.now())).toEqual({ kind: "used" });
    expect(store.outsideWrite(put.write.id)?.status).toBe("ready");
    expect((await advanceOutsideWrite(store, fake.provider, put.write.id, clock))?.status).toBe("succeeded");
    expect(fake.writes).toHaveLength(1);
  });
});

test("a definite provider rejection is a durable failure, not an uncertain retry", async () => {
  await inStore("rejected", async (store) => {
    const clock = fakeClock(start);
    const provider: OutsideProvider = {
      async write() {
        return { kind: "rejected", reason: "recipient address refused" };
      },
      async check() {
        throw new Error("check must not be needed after a definite rejection");
      },
    };
    const made = draft("event-9:send-0");
    const put = store.putOutsideWrite(made.write, null);
    if (put.kind === "conflict") throw new Error("unexpected conflict");
    expect((await advanceOutsideWrite(store, provider, put.write.id, clock))).toMatchObject({ status: "failed", failure: "recipient address refused", receipt: null });
  });
});

test("refusing an approval terminally refuses the bound write", async () => {
  await inStore("approval-refusal", (store) => {
    const expiresAt = (start + 15 * 60_000) as EpochMs;
    const made = draft("event-10:send-0", sendArgs, start, { owner, expiresAt });
    const put = store.putOutsideWrite(made.write, made.approval);
    if (put.kind === "conflict" || !put.approval) throw new Error("approval missing");
    expect(store.decideOutsideApproval(put.approval.id, owner, "refuse", start)).toEqual({ kind: "refused" });
    expect(store.outsideWrite(put.write.id)).toMatchObject({ status: "failed", failure: "approval refused" });
    expect(store.consumeOutsideApproval(put.approval.id, put.write.id, start)).toEqual({ kind: "not_approved" });
  });
});

test("an approval expires before it can run", async () => {
  await inStore("approval-expiry", (store) => {
    const expiresAt = (start + 1_000) as EpochMs;
    const made = draft("event-6:send-0", sendArgs, start, { owner, expiresAt });
    const put = store.putOutsideWrite(made.write, made.approval);
    if (put.kind === "conflict" || !put.approval) throw new Error("approval missing");
    expect(store.decideOutsideApproval(put.approval.id, owner, "approve", start)).toEqual({ kind: "approved" });
    expect(store.consumeOutsideApproval(put.approval.id, put.write.id, expiresAt)).toEqual({ kind: "expired" });
    expect(store.outsideWrite(put.write.id)).toMatchObject({ status: "failed", failure: "approval expired" });
    expect(store.outsideApproval(put.approval.id)?.status).toBe("expired");
  });
});
