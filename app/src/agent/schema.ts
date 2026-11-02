/**
 * The agent's SQLite schema. One Durable Object per person; every table here belongs to that person
 * and has exactly one writer: the Agent's drain (plus `enqueue`, which only inserts inbox rows).
 *
 * Applied in the constructor under `blockConcurrencyWhile`, so no request sees a half-migrated object.
 * Migrations are append-only; `meta.schema_version` records how many have run.
 *
 * Conventions: times are epoch ms UTC (INTEGER); money is integer micro-USD; JSON columns are parsed
 * by store.ts and nowhere else.
 */

export const MIGRATIONS: readonly string[] = [
  /* 1 */ `
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

  -- Exactly one row. Written on the first enqueue (the DO can't learn its own name otherwise).
  CREATE TABLE agent (
    one              INTEGER PRIMARY KEY CHECK (one = 1),
    agent_key        TEXT NOT NULL,
    channel          TEXT NOT NULL,
    channel_user_id  TEXT NOT NULL,
    tz               TEXT NOT NULL DEFAULT 'Asia/Bangkok',
    checkin_local    TEXT NOT NULL DEFAULT '09:00',
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
    created_at       INTEGER NOT NULL
  );

  -- The durable queue. Every event, external or internal, enters here and only here.
  -- No CHECK on kind: week 2 adds 'job_result' without a table rebuild; store.ts parses payloads.
  CREATE TABLE inbox (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,   -- processing order
    event_key    TEXT NOT NULL UNIQUE,                -- dedupe: redelivered webhooks, double alarms
    kind         TEXT NOT NULL,
    payload      TEXT NOT NULL,                       -- JSON AgentEvent
    received_at  INTEGER NOT NULL,
    ready_at     INTEGER NOT NULL,                    -- received_at + debounce for messages
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,          -- incremented when a drain claims it
    outcome      TEXT,                                -- TurnOutcome, set with status done/failed
    finished_at  INTEGER
  );
  CREATE INDEX inbox_ready ON inbox (status, ready_at, seq);

  -- Verbatim recent conversation. Compaction deletes the oldest rows after folding them into memory.
  CREATE TABLE turn (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    role       TEXT NOT NULL CHECK (role IN ('person', 'agent', 'note')),   -- note: code notices, late markers
    text       TEXT NOT NULL,
    at         INTEGER NOT NULL,
    event_key  TEXT NOT NULL
  );

  -- Exactly one row. The compacted past.
  CREATE TABLE memory (
    one              INTEGER PRIMARY KEY CHECK (one = 1),
    summary          TEXT NOT NULL DEFAULT '',
    through_turn_seq INTEGER NOT NULL DEFAULT 0,     -- turns with seq <= this are folded in
    updated_at       INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO memory (one) VALUES (1);

  -- Model-written notes ("remember" action). Folded into the summary by compaction past a cap.
  CREATE TABLE memory_note (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    event_key  TEXT NOT NULL
  );

  CREATE TABLE wakeup (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,   -- WakeupId; the firing's inbox key is 'wake:<id>'
    key         TEXT NOT NULL,                       -- WakeupKey
    kind        TEXT NOT NULL CHECK (kind IN ('reminder', 'checkin')),
    note        TEXT NOT NULL,
    due_at      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'fired', 'skipped', 'cancelled')),
    created_at  INTEGER NOT NULL,
    created_by  TEXT NOT NULL,                       -- event_key of the turn that scheduled it, or 'system'
    closed_at   INTEGER
  );
  -- "Every wake-up has an ID, so a duplicate is dropped": a key can be pending at most once.
  CREATE UNIQUE INDEX wakeup_pending_key ON wakeup (key) WHERE status = 'pending';
  CREATE INDEX wakeup_due ON wakeup (status, due_at);

  -- Messages waiting to leave. One row per turn's delivery (all its texts), because a LINE reply token
  -- is single-use. The id is the LINE X-Line-Retry-Key.
  CREATE TABLE outbox (
    id             TEXT PRIMARY KEY,
    event_key      TEXT NOT NULL,
    trigger_kind   TEXT NOT NULL,
    intent         TEXT NOT NULL CHECK (intent IN ('reply', 'unasked')),
    texts          TEXT NOT NULL,                    -- JSON string[1..3]
    reply_token    TEXT,
    reply_expires  INTEGER,
    ready_at       INTEGER NOT NULL,                 -- quiet-hours deferral and retry backoff both move this
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sending', 'sent', 'dropped')),
    admitted_day   TEXT,                             -- unasked only: local date the budget was charged to
    in_doubt       INTEGER NOT NULL DEFAULT 0,       -- a 'sending' row recovered after a crash
    attempts       INTEGER NOT NULL DEFAULT 0,
    drop_reason    TEXT,                             -- budget | blocked | failed | gone
    created_at     INTEGER NOT NULL,
    closed_at      INTEGER
  );
  CREATE INDEX outbox_ready ON outbox (status, ready_at);
  -- The unasked budget is COUNT(*) here, not a counter: one source of truth, idempotent admission.
  CREATE INDEX outbox_admitted ON outbox (admitted_day) WHERE intent = 'unasked';

  -- Spend, current and past months. reserved is derived (SUM over reservation), never stored.
  CREATE TABLE spend_month (
    month          TEXT PRIMARY KEY,                 -- 'YYYY-MM' UTC
    spent_micro    INTEGER NOT NULL DEFAULT 0,
    leased_micro   INTEGER NOT NULL DEFAULT 0,
    lease_seq      INTEGER NOT NULL DEFAULT 0,       -- last seq granted
    lease_pending  INTEGER                           -- seq requested but not yet answered (crash-safe retry)
  );

  -- Open reservations. A row exists only between reserve and settle. Rows found at drain start
  -- belong to a crashed run and are settled at their estimate.
  CREATE TABLE reservation (
    id             TEXT PRIMARY KEY,                 -- also the model_call log id
    month          TEXT NOT NULL,
    purpose        TEXT NOT NULL,
    model          TEXT NOT NULL,
    estimate_micro INTEGER NOT NULL,
    event_key      TEXT,
    created_at     INTEGER NOT NULL
  );

  -- Transactional outbox for the D1 ledger. Written in the same transaction as the fact it records.
  CREATE TABLE log_outbox (
    id         TEXT PRIMARY KEY,                     -- the LogRow id, unique per stream
    stream     TEXT NOT NULL,
    row        TEXT NOT NULL,                        -- JSON LogRow
    created_at INTEGER NOT NULL
  );
  CREATE TABLE log_flush (
    one          INTEGER PRIMARY KEY CHECK (one = 1),
    failures     INTEGER NOT NULL DEFAULT 0,
    retry_at     INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO log_flush (one) VALUES (1);
  `,
  // Week 2 (sketch, not applied): job (id, version, kind, status, ...), approval (action_id, version,
  // expires_at, ...), side_effect (idempotency_key PRIMARY KEY, status pending|done|unknown, ...).
];

/** Runs pending migrations. Idempotent: reads meta.schema_version first. */
export function migrate(sql: SqlStorage): void {
  // TODO: create meta if missing; v = Number(meta['schema_version'] ?? 0);
  //       for i in v..MIGRATIONS.length: sql.exec(MIGRATIONS[i]); set schema_version = i + 1.
  //       Runs inside the constructor's blockConcurrencyWhile; SQLite DDL in a DO is transactional
  //       per implicit transaction (no await between statements).
  throw new Error("not implemented");
}
