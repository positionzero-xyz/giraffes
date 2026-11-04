import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { COMPACTION, CompactionOutputSchema, compactionCommit, planCompaction } from "../src/agent/compaction";
import { COMPACTION_SYSTEM, TURN_SYSTEM } from "../src/agent/prompt";
import { OUTPUTS } from "../src/agent/purposes";
import { AgentStore } from "../src/agent/store";
import { TASKS } from "../src/agent/tasks";
import { planTurn, renderUser, TURN, type TurnView } from "../src/agent/turn";
import { eventKey, type AgentKey, type EpochMs, type TaskId, type TaskRef, type WakeupId, type WakeupKey } from "../src/domain";
import { jsonSchemaOf, looseUser, runParse, type Meter, type ModelClient, type WireResult } from "../src/model/client";
import { bytesOf, renderPrompt } from "../src/model/prompt";
import { PROVIDER_IDS, PROVIDERS } from "../src/model/providers";
import { routeFor } from "../src/model/routes";
import { NOTICES } from "../src/notices";
import { SCHEDULE } from "../src/policy/schedule";
import { DEFAULT_TIME_ZONE } from "../src/policy/time";
import { devChat, giveKey, local, send } from "./testkit";

const THAI = "ก";
const NOW = local("2099-11-04T10:00");
const ALIBABA = routeFor({ kind: "key", provider: "alibaba", model: "qwen3.7-flash" }, "turn");
const ALIBABA_KEY = { provider: "alibaba", key: "sk-alibaba-0123456789", mode: "loose" } as const;
const turnBudget = (route = ALIBABA) => route.promptBytes - bytesOf(TURN_SYSTEM) - bytesOf(looseUser("", jsonSchemaOf(OUTPUTS.turn)));

let n = 0;
function view(over: Partial<TurnView> = {}): TurnView {
  return {
    now: NOW,
    tz: DEFAULT_TIME_ZONE,
    language: "th",
    status: "active",
    statusAt: 0 as EpochMs,
    checkinLocal: "09:00",
    summary: "",
    notes: [],
    recent: [],
    pending: [],
    batch: { items: [{ key: eventKey.dev(`b${++n}`), event: { kind: "message", text: "hi" }, attempts: 1, receivedAt: NOW }] },
    unaskedLeftToday: 3,
    openTasks: [],
    acceptable: null,
    tapped: [],
    admission: { state: "admitted", seat: { cohort: "staff", half: null, code: null, inviter: null }, at: 0 as EpochMs },
    ...over,
  };
}

const message = (text: string) => ({ key: eventKey.dev(`m${++n}`), event: { kind: "message", text } as const, attempts: 1, receivedAt: NOW });

/** A provider on the OpenAI wire that answers turns and compactions alike, and records what each was sent. */
function answering(opts: { readonly failCompaction?: boolean } = {}) {
  const seen: { purpose: "turn" | "compaction"; user: string; bytes: number }[] = [];
  let turns = 0;
  const f = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const [system, user] = body.messages;
    const purpose = system.content === COMPACTION_SYSTEM ? "compaction" : "turn";
    seen.push({ purpose, user: user.content, bytes: bytesOf(system.content) + bytesOf(user.content) });
    if (purpose === "compaction" && opts.failCompaction) return Response.json({ error: "down" }, { status: 500 });
    const value = purpose === "compaction" ? { summary: `สรุป ${seen.length}` } : { actions: [send(`Reply ${turns++}.`)], tasks: [], about: "" };
    return Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100 } });
  };
  return Object.assign(f, { seen });
}

function doTurns(agent: AgentKey): Promise<string[]> {
  return runInDurableObject(env.AGENT.get(env.AGENT.idFromName(agent)), (_a, state) =>
    state.storage.sql.exec<{ text: string }>("SELECT text FROM turn ORDER BY seq").toArray().map((r) => r.text),
  );
}

describe("every cap that guards a prompt budget is in UTF-8 bytes", () => {
  test("a Thai note the model writes is cut to its cap in bytes, not characters", () => {
    const thai = THAI.repeat(TURN.maxNoteBytes);
    const commit = planTurn(
      {
        actions: [
          { type: "remember", note: thai },
          { type: "schedule_wakeup", key: "bins", at: "2099-11-04T23:00", note: thai, asked: true, task: "" },
          send("ok"),
        ],
        tasks: [],
        about: "",
      },
      view(),
    );
    expect(bytesOf(commit.notes[0])).toBeLessThanOrEqual(TURN.maxNoteBytes);
    expect(bytesOf(commit.wakeupsAdd[0].note)).toBeLessThanOrEqual(TURN.maxNoteBytes);
  });

  test("a summary over its cap in bytes is refused, even under the old character cap", () => {
    expect(CompactionOutputSchema.safeParse({ summary: THAI.repeat(COMPACTION.maxSummaryBytes / 3 + 1) }).success).toBe(false);
    expect(CompactionOutputSchema.safeParse({ summary: THAI.repeat(COMPACTION.maxSummaryBytes / 3) }).success).toBe(true);
  });

  test("a task title is cut to its cap in bytes", () => {
    const commit = planTurn({ actions: [send("ok")], tasks: [{ op: "open", ref: "trip", kind: "plan", title: THAI.repeat(200), plan: "" }], about: "" }, view());
    expect(bytesOf(commit.tasks.open[0].title)).toBeLessThanOrEqual(TASKS.maxTitleBytes);
  });

  test("the sections a turn keeps whole, at their caps in Thai, leave room for a message on every route", () => {
    const pending = Array.from({ length: SCHEDULE.maxPendingReminders }, (_, i) => ({
      id: i as WakeupId,
      key: `reminder-${i}-with-a-long-key` as WakeupKey,
      kind: "reminder" as const,
      origin: "person" as const,
      note: THAI.repeat(TURN.maxNoteBytes / 3),
      dueAt: NOW,
      task: null,
      bookkeeping: false,
    }));
    const openTasks = Array.from({ length: TASKS.maxOpen }, (_, i) => ({
      id: i as TaskId,
      ref: `task-${i}` as TaskRef,
      kind: "plan" as const,
      title: THAI.repeat(TASKS.maxTitleBytes / 3),
      proposal: null,
    }));
    const full = view({ summary: THAI.repeat(COMPACTION.maxSummaryBytes / 3), pending, openTasks, batch: { items: [message("")] } });
    const fixed = bytesOf(renderPrompt(renderUser(full)));
    for (const provider of PROVIDER_IDS) {
      for (const model of Object.keys(PROVIDERS[provider].models)) {
        const route = routeFor({ kind: "key", provider, model }, "turn");
        expect(turnBudget(route) - fixed, `${provider}:${model}`).toBeGreaterThanOrEqual(1_000);
      }
    }
  });

  test("the newest message is shown whole, however long, and earlier ones in its batch are cut to the batch cap in bytes", () => {
    const newest = `newest ${"x".repeat(5_000)} end`;
    const earlier = Array.from({ length: 5 }, (_, i) => message(`${i} ${THAI.repeat(1_500)}`));
    const prompt = renderPrompt(renderUser(view({ batch: { items: [...earlier, message(newest)] as never } })));
    expect(prompt).toContain(newest);
    const newSection = prompt.slice(prompt.indexOf("## New"));
    expect(bytesOf(newSection) - bytesOf(newest)).toBeLessThanOrEqual(TURN.batchBytes + 200);
  });
});

describe("a message too long for the route", () => {
  test("gets a code-written notice in the person's language, and no model is called", async () => {
    const provider = answering();
    const c = await devChat("tla", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent, ALIBABA_KEY);

    await c.say(THAI.repeat(8_000));

    expect(await c.received()).toEqual([NOTICES.en.tooLong]);
    expect(provider.seen).toEqual([]);
    expect(c.logs("turn").map((l) => l.outcome)).toEqual(["too_long"]);
  });
});

describe("compaction folds only what it saw", () => {
  const turn = (seq: number, text: string) => ({ seq, role: "person" as const, text, at: NOW });

  test("a turn is sent whole or not at all, and the fold ends at the last turn sent", () => {
    const fact = "the clinic code is 4471";
    const oldestTurns = [turn(1, "short"), turn(2, `${"x".repeat(2_100)} ${fact}`), turn(3, "y".repeat(30_000))];
    const plan = planCompaction({ summary: "", throughSeq: 0, oldestTurns, turnCount: 61, noteCount: 0, oldestNotes: [] }, 20_000)!;
    const text = renderPrompt(plan.prompt);
    expect(text).toContain(fact);
    expect(plan.foldThroughSeq).toBe(2);
    expect(bytesOf(text)).toBeLessThanOrEqual(20_000);
  });

  test("notes are folded whole, only as many as fit", () => {
    const oldestNotes = Array.from({ length: 42 }, (_, i) => ({ id: i + 1, text: `${i} ${THAI.repeat(95)}` }));
    const plan = planCompaction({ summary: THAI.repeat(1_000), throughSeq: 0, oldestTurns: [], turnCount: 0, noteCount: 42, oldestNotes }, 6_000)!;
    const text = renderPrompt(plan.prompt);
    expect(bytesOf(text)).toBeLessThanOrEqual(6_000);
    expect(plan.foldNoteIds.length).toBeGreaterThan(0);
    for (const id of plan.foldNoteIds) expect(text).toContain(oldestNotes[id - 1].text);
    expect(plan.foldNoteIds.length).toBeLessThan(42);
  });

  test("a turn larger than the whole budget is folded as a placeholder, and its row survives the commit", async () => {
    const c = await devChat("tlb", { model: null, at: "2099-11-04T10:00" });
    await c.say("hello");
    const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
    const huge = `${THAI.repeat(10_000)} the end`;

    const kept = await runInDurableObject(stub, (_a, state) => {
      const store = new AgentStore(state.storage);
      state.storage.sql.exec("DELETE FROM turn");
      state.storage.sql.exec("INSERT INTO turn (role, text, at, event_key) VALUES ('person', ?, ?, 'dev:huge')", huge, NOW);
      for (let i = 0; i < 70; i++) state.storage.sql.exec("INSERT INTO turn (role, text, at, event_key) VALUES ('person', ?, ?, ?)", `short ${i}`, NOW, `dev:s${i}`);
      const plan = planCompaction(store.compactionInput(), 20_000)!;
      const text = renderPrompt(plan.prompt);
      store.commitCompaction(compactionCommit(plan, { summary: "summary" }), NOW);
      return { text, rows: state.storage.sql.exec<{ text: string }>("SELECT text FROM turn").toArray().map((r) => r.text) };
    });

    expect(kept.text).toMatch(/\[long message on 2099-11-04, 30\d{3} bytes, not summarized\]/);
    expect(kept.text).not.toContain("the end");
    expect(kept.rows).toContain(huge);
    expect(kept.rows).not.toContain("short 0");
  });
});

describe("compaction before a turn on the smallest route", () => {
  const say = (i: number) => `${i} ${THAI.repeat(1_200)}`;

  test("a Thai conversation that outgrows the budget is compacted first, so the turn shows its whole history and deletes nothing unseen", async () => {
    const provider = answering();
    const c = await devChat("tlc", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent, ALIBABA_KEY);

    for (let i = 0; i < 12; i++) await c.say(say(i));

    const turns = provider.seen.filter((s) => s.purpose === "turn");
    const compactions = provider.seen.filter((s) => s.purpose === "compaction");
    expect(turns).toHaveLength(12);
    expect(compactions.length).toBeGreaterThan(0);
    for (const s of provider.seen) expect(s.bytes).toBeLessThanOrEqual(ALIBABA.promptBytes);
    for (const t of turns) expect(t.user).not.toContain("earlier line");
    expect(c.logs("turn").map((l) => l.historyTrimmed)).toEqual(Array(12).fill(false));
    const rows = await doTurns(c.agent);
    const folded = compactions.map((s) => s.user).join("\n");
    for (let i = 0; i < 12; i++) expect(folded.includes(say(i)) || rows.includes(say(i)), `message ${i}`).toBe(true);
  });

  test("while compaction fails, the turn shows the newest history that fits and the turn log says it was trimmed", async () => {
    const provider = answering({ failCompaction: true });
    const c = await devChat("tld", { model: null, provider, at: "2099-11-04T10:00" });
    await giveKey(c.agent, ALIBABA_KEY);

    for (let i = 0; i < 8; i++) await c.say(say(i));

    const last = provider.seen.filter((s) => s.purpose === "turn").at(-1)!;
    expect(last.user).toContain("earlier line");
    expect(last.user).toContain(say(7));
    expect(c.logs("turn").at(-1)?.historyTrimmed).toBe(true);
    expect(c.logs("turn")[0].historyTrimmed).toBe(false);
  });
});

describe("a repair counts against the budget", () => {
  test("a repair whose prompt would exceed the budget isn't sent, and the call fails as invalid output", async () => {
    const sent: string[] = [];
    const client: ModelClient = {
      async send(req): Promise<WireResult> {
        sent.push(req.user);
        return { kind: "reply", text: "x".repeat(ALIBABA.promptBytes), stop: "end", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, reportedMicro: null };
      },
    };
    const meter: Meter = { reserve: () => ({ id: "r", estimate: 1 as never }), settle: () => {} };
    const out = await runParse(client, { route: ALIBABA, mode: "loose", system: TURN_SYSTEM, user: "hi", schema: OUTPUTS.turn }, meter);
    expect(sent).toHaveLength(1);
    expect(out.last?.kind).toBe("invalid");
  });
});
