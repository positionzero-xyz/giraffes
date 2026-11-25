import { env, runInDurableObject } from "cloudflare:test";
import { expect, inject, test, vi } from "vitest";
import { MIGRATIONS, migrate } from "../src/agent/schema";
import { diagnosticRow, logSchema } from "../src/ledger/ledger";
import { chat, devChat, fakeProvider, giveKey, scripted } from "./testkit";

const marker = "private fixture: flight to Kyoto";

const legacyWrites = [
  ["feedback", "INSERT INTO feedback VALUES ('f1', 'p:dev:fixture', 'dev', 0, ?, NULL)"],
  ["safety_incident", "INSERT INTO safety_incident VALUES ('s1', NULL, 'privacy', ?, 0)"],
  ["model_call", "INSERT INTO model_call VALUES ('m1', 'p:dev:fixture', 'turn', ?, 'key', 'settled', 0, 0, 0, 0, 0, 0, 0)"],
  ["unasked_message", "INSERT INTO unasked_message VALUES ('u1', 'p:dev:fixture', 'checkin', ?, 'sent', NULL, 0, NULL, 'unlinked')"],
  ["task", "INSERT INTO task VALUES ('t1', 'p:dev:fixture', '', 'plan', ?, 'message', 0)"],
  ["task_fact", "INSERT INTO task_fact VALUES ('f1', 'p:dev:fixture', 't1', 'opened', '', ?, 0, 0, 'message', 0, 0)"],
  ["action_rejection", "INSERT INTO action_rejection VALUES ('r1', 'p:dev:fixture', 'turn1', ?, 'duplicate', 0)"],
];

test("D1 refuses late free text from legacy writers and manual incident entry", async () => {
  const invalidTypedFields = [
    "INSERT INTO agent VALUES ('a1', 'p:dev:fixture', ?, 0)",
    "INSERT INTO turn_log VALUES ('a1', 'p:dev:fixture', ?, 1, 'acted', 0, 0, 1, 0, 0, 0)",
    "INSERT INTO lifecycle VALUES ('a1', 'p:dev:fixture', 'follow', 'channel', ?)",
    "INSERT INTO admission_log VALUES ('a1', 'p:dev:fixture', 'waitlisted', ?, 'dev', 0)",
  ];
  for (const sql of [...legacyWrites.map(([, write]) => write), ...invalidTypedFields]) {
    await expect(env.LEDGER.prepare(sql).bind(marker).run(), sql).rejects.toThrow(/diagnostic/i);
  }
});

test("cutover erases historical D1 text and blocks an older writer held across the migration", async () => {
  const db = env.LEDGER;
  const { results: guards } = await db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'diagnostic_%' AND type = 'trigger'").all<{ name: string }>();
  await db.batch(guards.map(({ name }) => db.prepare(`DROP TRIGGER "${name}"`)));
  await db.batch(legacyWrites.map(([, sql]) => db.prepare(sql).bind(marker)));
  const held = db.prepare("UPDATE feedback SET text = ? WHERE id = 'f1'").bind(marker);

  await db.batch(inject("d1Migrations").flatMap((m) => m.queries.map((sql) => db.prepare(sql))));

  await expect(held.run()).rejects.toThrow(/diagnostic/i);
  for (const [table] of legacyWrites) {
    const { results } = await db.prepare(`SELECT * FROM "${table}"`).all();
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).not.toContain(marker);
  }
});

test("the DO cutover discards old JSON for every queued stream", async () => {
  const stub = env.AGENT.get(env.AGENT.idFromName("old-diagnostic-rows"));
  await runInDurableObject(stub, (_, { storage }) => {
    const streams = logSchema.options.map((s) => s.shape.stream.value);
    for (const stream of streams) {
      storage.sql.exec("INSERT INTO log_outbox VALUES (?, ?, ?, 0)", stream, stream, JSON.stringify({ stream, text: marker }));
    }
    storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'schema_version'", String(MIGRATIONS.length - 1));
    migrate(storage);
    expect(storage.sql.exec("SELECT * FROM log_outbox").toArray()).toEqual([]);
  });
  await runInDurableObject(stub, (agent) => agent.alarm());
  for (const table of ["agent", "turn_log", "admission_log", "lifecycle", ...legacyWrites.map(([table]) => table)]) {
    expect((await env.LEDGER.prepare(`SELECT * FROM "${table}"`).all()).results).toEqual([]);
  }
});

test("the queued payload decoder strips fields from older rows", () => {
  const id = "opaque";
  expect(diagnosticRow({ stream: "feedback", id, agent: "p:dev:fixture", channel: "dev", at: 0, cohort: null, text: marker })).toEqual({
    stream: "feedback", id, agent: "p:dev:fixture", channel: "dev", at: 0, cohort: null,
  });
});

test("delivery errors and a custom provider model and response never appear in Worker sinks", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const throwing = await devChat("throwing-delivery", { at: "2099-11-04T10:00", model: scripted([chat(marker)]) });
    const stub = env.AGENT.get(env.AGENT.idFromName(throwing.agent));
    await runInDurableObject(stub, (agent) => {
      agent.withDeps({ channels: { line: throwing.channel, telegram: throwing.channel, dev: {
        ...throwing.channel, async deliver() { return { kind: "failed", detail: marker }; },
      } } });
    });
    await throwing.say("hello");
    expect(warn).toHaveBeenCalledWith({ code: "delivery_failed" });

    const provider = fakeProvider([{ kind: "status", status: 404, body: { error: marker } }]);
    const custom = await devChat("private-endpoint", { at: "2099-11-04T10:00", model: null, provider });
    await custom.say("hello");
    await giveKey(custom.agent, { provider: "openai-compatible", model: marker, baseUrl: "https://private-endpoint.example/v1" });
    await custom.say("try again");
    expect(provider.seen).toHaveLength(1);
    const sink = JSON.stringify([warn.mock.calls, error.mock.calls, custom.logs("model_call"), custom.logs("turn")]);
    expect(sink).not.toContain(marker);
    expect(sink).not.toContain("private-endpoint.example");
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
});
