import { describe, expect, test } from "vitest";
import {
  NO_TASKS,
  TASKS,
  isPlainAccept,
  linkOf,
  nextStatus,
  planTasks,
  purposeOf,
  taskEffects,
  type OpenTask,
  type TaskOp,
  type TaskView,
  type TappedProposal,
} from "../src/agent/tasks";
import type { InboxItem } from "../src/agent/turn";
import type { AgentEvent, EpochMs, EventKey, FactCause, ProposalId, TaskId, TaskRef, WakeupId, WakeupKey } from "../src/domain";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2099-11-04T10:00:00+07:00") as EpochMs;
const id = (n: number) => n as TaskId;
const ref = (s: string) => s as TaskRef;
const pid = (s: string) => s as ProposalId;

function item(event: AgentEvent, receivedAt: EpochMs = NOW, key = "dev:1"): InboxItem {
  return { key: key as EventKey, event, attempts: 1, receivedAt };
}
const message = (text: string): AgentEvent => ({ kind: "message", text });
const tap = (proposal: string): AgentEvent => ({ kind: "choice", choice: { kind: "accept", proposal: pid(proposal) }, at: NOW });
const checkin: AgentEvent = { kind: "checkin", day: "2099-11-04" as never, dueAt: NOW, firedAt: NOW };
function wakeup(task: number | null, bookkeeping = false): AgentEvent {
  return { kind: "wakeup", wakeupId: 3 as WakeupId, key: "trip-check" as WakeupKey, origin: "agent", note: "n", dueAt: NOW, firedAt: NOW, task: task === null ? null : id(task), bookkeeping, repeat: null };
}

const trip: OpenTask = { id: id(7), ref: ref("chiang-mai-trip"), kind: "plan", title: "Chiang Mai long weekend", proposal: pid("7.1") };

function view(over: Partial<TaskView> & { readonly event?: AgentEvent; readonly items?: readonly InboxItem[] } = {}): TaskView {
  const items = over.items ?? [item(over.event ?? message("hi"))];
  return {
    now: NOW,
    batch: { items: items as [InboxItem, ...InboxItem[]] },
    openTasks: over.openTasks ?? [trip],
    acceptable: over.acceptable ?? null,
    tapped: over.tapped ?? [],
  };
}

const cause: FactCause = { key: "dev:1" as EventKey, kind: "message", at: NOW };
const PLAN = "Fri 18:30 overnight train from Bangkok\nSat Doi Suthep at 7 before the heat, Nimman cafes after\nSun 16:00 flight back";
const op = (o: Partial<TaskOp> & Pick<TaskOp, "op" | "ref">): TaskOp => ({ kind: "plan", title: "A trip", plan: "", ...o });
const tapped = (status: TappedProposal["status"], taskStatus: TappedProposal["taskStatus"] = "open"): TappedProposal => ({
  id: pid("7.1"),
  task: id(7),
  version: 1,
  status,
  taskStatus,
});

describe("accepting a plan", () => {
  test("a tap on the open proposal records plan_accepted on its task, from the person, and says so", () => {
    const fx = taskEffects(view({ event: tap("7.1"), tapped: [tapped("open")] }));
    expect(fx.commit.facts).toEqual([
      {
        target: { id: 7 },
        fact: { kind: "plan_accepted", ref: "7.1", detail: { via: "tap", version: 1 }, cause: { key: "dev:1", kind: "choice", at: NOW } },
      },
    ]);
    expect(fx.replies).toEqual([{ kind: "accepted", title: "Chiang Mai long weekend" }]);
  });

  test("a second tap on a proposal already accepted records nothing and says nothing", () => {
    const fx = taskEffects(view({ event: tap("7.1"), openTasks: [], tapped: [tapped("accepted", "completed")] }));
    expect(fx).toEqual({ commit: NO_TASKS, replies: [] });
  });

  test("a tap on a proposal a newer version superseded records nothing and says the plan changed", () => {
    const fx = taskEffects(view({ event: tap("7.1"), tapped: [tapped("superseded")] }));
    expect(fx).toEqual({ commit: NO_TASKS, replies: [{ kind: "plan_changed" }] });
  });

  test("a tap on a closed task's proposal is recorded, and the task's final status keeps it from completing", () => {
    const fx = taskEffects(view({ event: tap("7.1"), openTasks: [], tapped: [tapped("closed", "closed")] }));
    expect(fx.commit.facts.map((f) => [f.target, f.fact.kind])).toEqual([[{ id: 7 }, "plan_accepted"]]);
    expect(fx.replies).toEqual([]);
    expect(nextStatus("closed", "plan_accepted")).toBe("closed");
    expect(nextStatus("expired", "plan_accepted")).toBe("expired");
  });

  test("a typed accept counts only for the proposal on the newest delivered message, sent within 48 hours", () => {
    const acceptable = { id: pid("7.1"), task: id(7), version: 1, sentAt: (NOW - HOUR) as EpochMs };
    const typed = taskEffects(view({ event: message("ok ka"), acceptable }));
    expect(typed.commit.facts.map((f) => [f.target, f.fact.kind, f.fact.detail])).toEqual([[{ id: 7 }, "plan_accepted", { via: "typed", version: 1 }]]);

    expect(taskEffects(view({ event: message("ok") })).commit).toEqual(NO_TASKS);
    const stale = { ...acceptable, sentAt: (NOW - TASKS.typedAcceptWithinMs - 1) as EpochMs };
    expect(taskEffects(view({ event: message("ok"), acceptable: stale })).commit).toEqual(NO_TASKS);
    expect(taskEffects(view({ event: message("ok but Saturday"), acceptable })).commit).toEqual(NO_TASKS);
    const amended = [item(message("ok")), item(message("but make it Sunday"), NOW, "dev:2")];
    expect(taskEffects(view({ items: amended, acceptable })).commit).toEqual(NO_TASKS);
  });

  test("a typed accept compares times at whole-second precision, since Telegram stamps whole seconds", () => {
    const acceptable = { id: pid("7.1"), task: id(7), version: 1, sentAt: (NOW + 700) as EpochMs };
    const typed = taskEffects(view({ event: message("ok"), acceptable }));
    expect(typed.commit.facts.map((f) => f.fact.kind)).toEqual(["plan_accepted"]);
    const before = { ...acceptable, sentAt: (NOW + 1_000) as EpochMs };
    expect(taskEffects(view({ event: message("ok"), acceptable: before })).commit).toEqual(NO_TASKS);
  });

  test("a batch accepts when its first message is a plain accept and nothing after it rejects or amends", () => {
    const acceptable = { id: pid("7.1"), task: id(7), version: 1, sentAt: (NOW - HOUR) as EpochMs };
    const batch = (...texts: string[]) => texts.map((t, i) => item(message(t), NOW, `dev:${i + 1}`));
    const accepts = (...texts: string[]) => taskEffects(view({ items: batch(...texts), acceptable })).commit.facts.length === 1;

    expect(accepts("ok", "thanks")).toBe(true);
    expect(accepts("โอเค", "ขอบคุณค่ะ")).toBe(true);
    expect(accepts("ok", "but Saturday")).toBe(false);
    expect(accepts("ok", "no wait")).toBe(false);
    expect(accepts("ok", "can we change the hotel")).toBe(false);
    expect(accepts("ได้เลย", "แต่ขอเป็นวันเสาร์")).toBe(false);
    expect(accepts("ได้เลย", "ขอเปลี่ยนโรงแรม")).toBe(false);
    expect(accepts("ได้เลย", "ไม่เอาแล้ว")).toBe(false);
    expect(accepts("thanks", "ok")).toBe(false);
  });

  test("the accept vocabulary is closed, in English and Thai, polite particles and punctuation aside", () => {
    for (const yes of ["ok", "OK!", "okay", "ok ka", "Yes please", "sounds good", "👍", "โอเค", "โอเคค่ะ", "ตกลงครับ", "ได้เลยค่ะ", "เอาเลย"]) {
      expect(isPlainAccept(yes), yes).toBe(true);
    }
    for (const no of ["ok but Saturday", "not ok", "no", "maybe", "โอเคแต่เปลี่ยนวัน", "what about Sunday?", ""]) {
      expect(isPlainAccept(no), no).toBe(false);
    }
  });
});

describe("the model's task ops", () => {
  test("no ops change nothing", () => {
    expect(planTasks([], view(), cause, NO_TASKS)).toEqual({ commit: NO_TASKS, rejected: [] });
  });

  test("a propose with an empty plan opens a new task but offers nothing", () => {
    const r = planTasks([op({ op: "propose", ref: "dinner", plan: "  " })], view(), cause, NO_TASKS);
    expect(r.commit.open).toEqual([{ ref: "dinner", kind: "plan", title: "A trip" }]);
    expect(r.commit.propose).toBeNull();
    expect(r.rejected).toEqual([{ action: "task_propose:dinner", reason: "plan_empty" }]);
  });

  test("a plan with fewer than 2 lines or 80 characters is too thin to offer, though the task opens", () => {
    for (const plan of ["Drink water", "Line one\nline two"]) {
      const r = planTasks([op({ op: "propose", ref: "water", plan })], view(), cause, NO_TASKS);
      expect(r.commit.open.map((t) => t.ref), plan).toEqual(["water"]);
      expect(r.commit.propose, plan).toBeNull();
      expect(r.rejected, plan).toEqual([{ action: "task_propose:water", reason: "plan_too_thin" }]);
    }
  });

  test("a propose on an open task offers the plan and opens nothing; a second propose is rejected", () => {
    const r = planTasks([op({ op: "propose", ref: "chiang-mai-trip", plan: PLAN }), op({ op: "propose", ref: "dinner", plan: PLAN })], view(), cause, NO_TASKS);
    expect(r.commit.open).toEqual([]);
    expect(r.commit.propose).toEqual({ ref: "chiang-mai-trip", text: PLAN });
    expect(r.rejected).toEqual([{ action: "task_propose:dinner", reason: "too_many_proposals" }]);
  });

  test("closing an unknown task is rejected; closing an open one records the fact", () => {
    const r = planTasks([op({ op: "close", ref: "gym" }), op({ op: "close", ref: "chiang-mai-trip" })], view(), cause, NO_TASKS);
    expect(r.rejected).toEqual([{ action: "task_close:gym", reason: "task_unknown" }]);
    expect(r.commit.facts).toEqual([{ target: { ref: "chiang-mai-trip" }, fact: { kind: "closed", ref: "", detail: {}, cause } }]);
  });

  test("a 21st open task is rejected", () => {
    const twenty = Array.from({ length: TASKS.maxOpen }, (_, i): OpenTask => ({ id: id(i + 1), ref: ref(`t${i}`), kind: "other", title: "t", proposal: null }));
    const r = planTasks([op({ op: "open", ref: "one-more" })], view({ openTasks: twenty }), cause, NO_TASKS);
    expect(r.commit.open).toEqual([]);
    expect(r.rejected).toEqual([{ action: "task_open:one-more", reason: "task_limit" }]);
  });

  test("ops past the third are rejected", () => {
    const ops = ["a", "b", "c", "d"].map((r) => op({ op: "open", ref: r }));
    const r = planTasks(ops, view({ openTasks: [] }), cause, NO_TASKS);
    expect(r.commit.open.map((t) => t.ref)).toEqual(["a", "b", "c"]);
    expect(r.rejected).toEqual([{ action: "task_open:d", reason: "too_many_task_ops" }]);
  });

  test("a propose on a task the person's accept completed this turn is rejected", () => {
    const fx = taskEffects(view({ event: tap("7.1"), tapped: [tapped("open")] }));
    const r = planTasks([op({ op: "propose", ref: "chiang-mai-trip", plan: PLAN })], view({ event: tap("7.1") }), cause, fx.commit);
    expect(r.commit.propose).toBeNull();
    expect(r.commit.facts).toEqual(fx.commit.facts);
    expect(r.rejected).toEqual([{ action: "task_propose:chiang-mai-trip", reason: "task_done" }]);
  });
});

describe("link and purpose", () => {
  const proposing = { open: [], propose: { ref: ref("dinner"), text: PLAN }, facts: [] };

  test("the task proposed this turn wins over the wake-up's task and the model's about", () => {
    const v = view({ event: wakeup(7), openTasks: [trip, { ...trip, id: id(8), ref: ref("dinner") }] });
    expect(linkOf(v, proposing, "chiang-mai-trip")).toEqual({ ref: "dinner" });
    expect(linkOf(v, NO_TASKS, "dinner")).toEqual({ id: 7 });
    expect(linkOf(view({ event: wakeup(99) }), NO_TASKS, "chiang-mai-trip")).toEqual({ ref: "chiang-mai-trip" });
  });

  test("an about naming an unknown task links nothing, so the message is unlinked", () => {
    const v = view({ event: checkin });
    const link = linkOf(v, NO_TASKS, "no-such-task");
    expect(link).toBeNull();
    expect(purposeOf(v, NO_TASKS, link)).toBe("unlinked");
    expect(purposeOf(v, NO_TASKS, linkOf(v, NO_TASKS, ""))).toBe("unlinked");
  });

  test("an unasked message on an open task is a follow-up; on a task completed this turn it is bookkeeping", () => {
    const v = view({ event: checkin });
    expect(purposeOf(v, NO_TASKS, linkOf(v, NO_TASKS, "chiang-mai-trip"))).toBe("task_followup");
    const done = { open: [], propose: null, facts: [{ target: { id: id(7) }, fact: { kind: "plan_accepted" as const, ref: "7.1", detail: {}, cause } }] };
    const link = linkOf(v, done, "chiang-mai-trip");
    expect(link).toEqual({ id: 7 });
    expect(purposeOf(v, done, link)).toBe("bookkeeping");
  });

  test("a check code scheduled is bookkeeping, and a reply has no purpose", () => {
    expect(purposeOf(view({ event: wakeup(7, true) }), NO_TASKS, { id: id(7) })).toBe("bookkeeping");
    expect(purposeOf(view({ event: message("hi") }), NO_TASKS, { id: id(7) })).toBeNull();
  });

  test("completed, closed and expired are final", () => {
    expect(nextStatus("open", "plan_accepted")).toBe("completed");
    expect(nextStatus("open", "closed")).toBe("closed");
    expect(nextStatus("open", "expired")).toBe("expired");
    expect(nextStatus("open", "proposed")).toBe("open");
    expect(nextStatus("completed", "closed")).toBe("completed");
  });
});
