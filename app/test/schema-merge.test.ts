import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { MIGRATIONS, migrate } from "../src/agent/schema";
import { rewindQuoteRewrites } from "./testkit";

test.each(["main", "transient-only", "correction"] as const)("keeps data when upgrading a database from %s", async (branch) => {
  const stub = env.AGENT.get(env.AGENT.idFromName("merge-schema-" + branch));
  await runInDurableObject(stub, (_, { storage }) => {
    const { sql } = storage;
    rewindQuoteRewrites(sql);
    const firstMain = MIGRATIONS.findIndex((migration) => migration.includes("CREATE TABLE line_message"));
    sql.exec("INSERT INTO turn (role, text, at, event_key, transient) VALUES ('person', 'kept', 1, 'dev:before', 1)");
    if (branch === "main") {
      sql.exec("ALTER TABLE turn DROP COLUMN transient");
      sql.exec("INSERT INTO line_message VALUES ('provider-id', 'outbox-id', 0, 1)");
      sql.exec("UPDATE forget SET completed_at = 123");
    } else {
      sql.exec("DROP TABLE line_message");
      sql.exec("ALTER TABLE forget DROP COLUMN completed_at");
      sql.exec("ALTER TABLE box DROP COLUMN setup");
      sql.exec("UPDATE forget SET receipt = '{}'");
    }
    if (branch === "correction") {
      sql.exec("UPDATE turn SET correction_spans = '[]'");
    } else {
      sql.exec("ALTER TABLE turn DROP COLUMN correction_spans");
      sql.exec("ALTER TABLE outbox DROP COLUMN correction_spans");
    }
    const checkpoint = branch === "main"
      ? MIGRATIONS.findIndex((migration) => migration.includes("ALTER TABLE box ADD COLUMN setup")) + 1
      : firstMain + (branch === "transient-only" ? 1 : 2);
    sql.exec("UPDATE meta SET v = ? WHERE k = 'schema_version'", String(checkpoint));

    if (branch !== "main") {
      sql.exec(`CREATE TRIGGER fail_version BEFORE UPDATE ON meta
        WHEN NEW.k = 'schema_version' BEGIN SELECT RAISE(ABORT, 'checkpoint write failed'); END`);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => migrate(storage)).toThrow("checkpoint write failed");
        expect(sql.exec("SELECT name FROM sqlite_master WHERE name = 'line_message'").toArray()).toEqual([]);
        expect(sql.exec("SELECT name FROM pragma_table_info('forget') WHERE name = 'completed_at'").toArray()).toEqual([]);
        expect(sql.exec("SELECT text, transient FROM turn").one()).toEqual({ text: "kept", transient: 1 });
      }
      sql.exec("DROP TRIGGER fail_version");
    }
    migrate(storage);
    migrate(storage);

    expect(sql.exec("SELECT text, transient, correction_spans FROM turn").one()).toEqual({
      text: "kept", transient: branch === "main" ? 0 : 1, correction_spans: branch === "correction" ? "[]" : null,
    });
    expect(sql.exec("SELECT id FROM line_message").toArray()).toEqual(branch === "main" ? [{ id: "provider-id" }] : []);
    expect(sql.exec("SELECT completed_at FROM forget").one().completed_at).toEqual(branch === "main" ? 123 : expect.any(Number));
    expect(sql.exec("SELECT correction_spans FROM outbox").toArray()).toEqual([]);
    expect(sql.exec("SELECT name FROM pragma_table_info('box') WHERE name = 'setup'").one()).toEqual({ name: "setup" });
    expect(sql.exec("SELECT v FROM meta WHERE k = 'schema_version'").one().v).toBe(String(MIGRATIONS.length));
  });
});

test("upgrades the prior PR schema without replaying its private quote migrations", async () => {
  const stub = env.AGENT.get(env.AGENT.idFromName("merge-schema-pr-before-box-setup"));
  await runInDurableObject(stub, (_, { storage }) => {
    const { sql } = storage;
    sql.exec("INSERT INTO private_quote_id VALUES ('kept-private')");
    sql.exec("ALTER TABLE box DROP COLUMN setup");
    const checkpoint = String(MIGRATIONS.length - 1);
    sql.exec("UPDATE meta SET v = ? WHERE k = 'schema_version'", checkpoint);
    sql.exec(`CREATE TRIGGER fail_version BEFORE UPDATE ON meta
      WHEN NEW.k = 'schema_version' BEGIN SELECT RAISE(ABORT, 'checkpoint write failed'); END`);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => migrate(storage)).toThrow("checkpoint write failed");
      expect(sql.exec("SELECT name FROM pragma_table_info('box') WHERE name = 'setup'").toArray()).toEqual([]);
      expect(sql.exec("SELECT v FROM meta WHERE k = 'schema_version'").one().v).toBe(checkpoint);
    }
    sql.exec("DROP TRIGGER fail_version");
    migrate(storage);
    migrate(storage);

    expect(sql.exec("SELECT name FROM pragma_table_info('box') WHERE name = 'setup'").one()).toEqual({ name: "setup" });
    expect(sql.exec("SELECT id FROM private_quote_id").one()).toEqual({ id: "kept-private" });
    expect(sql.exec("SELECT v FROM meta WHERE k = 'schema_version'").one().v).toBe(String(MIGRATIONS.length));
  });
});
