import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { chat, devChat, local, propose, scripted, send, turn } from "./testkit";

test("a signed-out person can page through every saved item without keeping a rendered copy", async () => {
  const chat = await devChat("saved-items", { at: "2099-11-04T10:00", model: null });
  await chat.say("hello");
  await chat.received();
  const due = local("2099-11-17T14:37");
  const large = "🦒 legacy entry ".repeat(410);
  const stub = env.AGENT.get(env.AGENT.idFromName(chat.agent));
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    for (let n = 1; n <= 123; n++) {
      sql.exec("INSERT INTO memory_note (text, created_at, event_key) VALUES (?, 0, 'legacy')", `[note-${n}]`);
    }
    sql.exec("INSERT INTO memory_note (text, created_at, event_key) VALUES (?, 0, 'legacy')", large);
    sql.exec(`INSERT INTO wakeup (key, kind, origin, note, due_at, created_at, created_by, repeat, repeat_anchor)
              VALUES ('trip-hidden-slug', 'reminder', 'person', 'Pack train tickets', ?, 0, 'legacy', 'weekly', '2099-11-17T14:37')`, due);
    sql.exec(`INSERT INTO task (id, ref, kind, title, status, opened_at, cause_key, touched_at, closed_at)
              VALUES (41, 'book-hidden-slug', 'booking', 'Reserve the observatory', 'completed', 0, 'legacy', 0, 0)`);
    sql.exec(`INSERT INTO task_fact (task_id, kind, ref, detail, completes, person_decision, cause_key, cause_kind, cause_at, at)
              VALUES (41, 'plan_accepted', '41.1', '{"arrival":"2099-11-20","room":723}', 1, 1, 'legacy', 'choice', ?, ?)`, due, due);
  });

  const pages: string[] = [];
  await chat.say("/memory");
  for (let n = 0; n < 20; n++) {
    const [page] = await chat.received();
    expect(page).toBeDefined();
    expect(page.length).toBeLessThanOrEqual(4096);
    pages.push(page);
    if (!page.includes("/memory next")) break;
    await chat.say("/memory next");
  }
  expect(pages.length).toBeGreaterThan(1);
  const listing = pages.join("\n");
  for (let n = 1; n <= 123; n++) expect(listing).toContain(`[note-${n}]`);
  const largePieces = pages.flatMap((p) => [...p.matchAll(/\n\n124\. Note(?: \(continued\))?\n([\s\S]*?)\n\n(?=\d+\. |Send |End )/g)].map((m) => m[1]));
  expect(largePieces.join("")).toBe(large);
  for (const value of [
    "trip-hidden-slug", "Pack train tickets", "weekly", "2099-11-17T14:37", new Date(due).toISOString(),
    "book-hidden-slug", "Reserve the observatory", "booking", "completed", "plan_accepted", "2099-11-20", "723",
    "Asia/Bangkok", "09:00",
  ]) expect(listing).toContain(value);
  expect(listing).not.toContain("41.1");
  expect(chat.logs("model_call")).toEqual([]);
  const snapshot = await chat.snapshot();
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    const rows = sql.exec("SELECT status, texts FROM outbox ORDER BY rowid DESC LIMIT ?", pages.length).toArray();
    expect(rows).toEqual(pages.map(() => ({ status: "sent", texts: "[]" })));
  });
  expect(snapshot.turns.map((t) => t.text).join("\n")).not.toContain("/memory");
});

test("paging does not displace the latest proposal for typed Accept", async () => {
  const title = "A weekend at the coast";
  const offer = "Friday 18:30 train to the coast\nSaturday lighthouse walk then lunch at the market\nSunday return on the 17:20 train";
  const model = scripted([
    turn({ actions: [send("I drafted a plan.")], tasks: [propose("coast-trip", title, offer)] }),
    chat("Done."),
  ]);
  const c = await devChat("memory-and-accept", { at: "2099-11-04T10:00", model });
  await c.say("Plan my weekend.");
  expect(c.channel.delivered.at(-1)?.button?.data).toBe("a:1.1");
  await c.received();
  await c.say("/memory");
  expect((await c.received())[0]).toContain(title);
  expect(model.calls).toHaveLength(1);
  await c.say("Accept");
  expect((await c.snapshot()).tasks[0].status).toBe("completed");
  expect(model.calls[1].user).not.toContain("Saved items");
  model.assertDone();
});

test("a changed source invalidates a cursor, and a new request sees the new items", async () => {
  const c = await devChat("memory-changed", { at: "2099-11-04T10:00", model: null });
  await c.say("hello");
  await c.received();
  const stub = env.AGENT.get(env.AGENT.idFromName(c.agent));
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    sql.exec("INSERT INTO memory_note (text, created_at, event_key) VALUES (?, 0, 'test')", "A".repeat(4500));
  });
  await c.say("/memory");
  expect((await c.received())[0]).toContain("/memory next");
  await runInDurableObject(stub, (_, { storage: { sql } }) => {
    sql.exec("UPDATE memory_note SET text = 'Updated item'");
  });
  await c.say("/memory next");
  expect(await c.received()).toEqual(["Your saved items changed. Send /memory to start again."]);
  await c.say("/memory");
  expect((await c.received())[0]).toContain("Updated item");
});
