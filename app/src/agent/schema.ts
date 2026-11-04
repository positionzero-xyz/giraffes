export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE agent (
    one              INTEGER PRIMARY KEY CHECK (one = 1),
    agent_key        TEXT NOT NULL,
    channel          TEXT NOT NULL,
    channel_user_id  TEXT NOT NULL,
    tz               TEXT NOT NULL,
    checkin_local    TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
    status_at        INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE inbox (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key    TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL,
    payload      TEXT NOT NULL,
    received_at  INTEGER NOT NULL,
    ready_at     INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    outcome      TEXT,
    finished_at  INTEGER
  );
  CREATE INDEX inbox_ready ON inbox (status, ready_at, seq);

  CREATE TABLE turn (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    role       TEXT NOT NULL CHECK (role IN ('person', 'agent', 'note')),
    text       TEXT NOT NULL,
    at         INTEGER NOT NULL,
    event_key  TEXT NOT NULL
  );

  CREATE TABLE memory (
    one              INTEGER PRIMARY KEY CHECK (one = 1),
    summary          TEXT NOT NULL DEFAULT '',
    through_turn_seq INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO memory (one) VALUES (1);

  CREATE TABLE memory_note (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    event_key  TEXT NOT NULL
  );

  CREATE TABLE wakeup (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('reminder', 'checkin')),
    origin      TEXT NOT NULL CHECK (origin IN ('person', 'agent', 'system')),
    note        TEXT NOT NULL,
    due_at      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'fired', 'skipped', 'cancelled')),
    created_at  INTEGER NOT NULL,
    created_by  TEXT NOT NULL,
    closed_at   INTEGER,
    CHECK ((kind = 'checkin') = (origin = 'system'))
  );
  CREATE UNIQUE INDEX wakeup_pending_key ON wakeup (key) WHERE status = 'pending';
  CREATE INDEX wakeup_due ON wakeup (status, due_at);

  CREATE TABLE outbox (
    id             TEXT PRIMARY KEY,
    event_key      TEXT NOT NULL,
    trigger_kind   TEXT NOT NULL,
    intent         TEXT NOT NULL CHECK (intent IN ('reply', 'requested', 'unasked')),
    texts          TEXT NOT NULL,
    reply_token    TEXT,
    reply_expires  INTEGER,
    ready_at       INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sending', 'sent', 'dropped')),
    admitted_day   TEXT,
    in_doubt       INTEGER NOT NULL DEFAULT 0,
    attempts       INTEGER NOT NULL DEFAULT 0,
    via            TEXT,
    drop_reason    TEXT,
    created_at     INTEGER NOT NULL,
    closed_at      INTEGER
  );
  CREATE INDEX outbox_ready ON outbox (status, ready_at);
  CREATE INDEX outbox_admitted ON outbox (admitted_day) WHERE intent = 'unasked';

  CREATE TABLE spend_month (
    month          TEXT PRIMARY KEY,
    spent_micro    INTEGER NOT NULL DEFAULT 0,
    leased_micro   INTEGER NOT NULL DEFAULT 0,
    lease_seq      INTEGER NOT NULL DEFAULT 0,
    lease_pending  INTEGER
  );

  CREATE TABLE reservation (
    id             TEXT PRIMARY KEY,
    month          TEXT NOT NULL,
    purpose        TEXT NOT NULL,
    model          TEXT NOT NULL,
    estimate_micro INTEGER NOT NULL,
    event_key      TEXT,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE log_outbox (
    id         TEXT PRIMARY KEY,
    stream     TEXT NOT NULL,
    row        TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE log_flush (
    one          INTEGER PRIMARY KEY CHECK (one = 1),
    failures     INTEGER NOT NULL DEFAULT 0,
    retry_at     INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO log_flush (one) VALUES (1);
  `,
  `
  ALTER TABLE memory ADD COLUMN compaction_failures INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE memory ADD COLUMN compaction_retry_at INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE box (
    one                INTEGER PRIMARY KEY CHECK (one = 1),
    name               TEXT NOT NULL,
    host               TEXT NOT NULL CHECK (host IN ('fly', 'static')),
    url                TEXT NOT NULL,
    state              TEXT NOT NULL CHECK (state IN ('provisioning', 'signed_out', 'signed_in', 'failed')),
    state_at           INTEGER NOT NULL,
    link_sent_at       INTEGER,
    signin_poll_until  INTEGER,
    error              TEXT,
    attempts           INTEGER NOT NULL DEFAULT 0,
    next_at            INTEGER
  );
  `,
  `
  CREATE TABLE box_next (
    one                INTEGER PRIMARY KEY CHECK (one = 1),
    name               TEXT NOT NULL,
    host               TEXT NOT NULL CHECK (host IN ('fly', 'static')),
    url                TEXT NOT NULL,
    state              TEXT NOT NULL CHECK (state IN ('provisioning', 'signed_out', 'signed_in', 'failed', 'reclaiming')),
    state_at           INTEGER NOT NULL,
    link_sent_at       INTEGER,
    signin_poll_until  INTEGER,
    error              TEXT,
    attempts           INTEGER NOT NULL DEFAULT 0,
    next_at            INTEGER,
    poll_at            INTEGER,
    reclaim_at         INTEGER
  );
  INSERT INTO box_next (one, name, host, url, state, state_at, link_sent_at, signin_poll_until, error, attempts, next_at, poll_at)
    SELECT one, name, host, url, state, state_at, link_sent_at, signin_poll_until, error, attempts, next_at,
           CASE state WHEN 'signed_out' THEN next_at END
    FROM box;
  DROP TABLE box;
  ALTER TABLE box_next RENAME TO box;
  `,
  `
  CREATE TABLE plan (
    one                INTEGER PRIMARY KEY CHECK (one = 1),
    trial_ends_at      INTEGER NOT NULL,
    own_subscription   TEXT,
    own_plan           TEXT CHECK (own_plan IN ('standard', 'plus', 'ai')),
    seat_subscription  TEXT,
    seat_owner         TEXT,
    updated_at         INTEGER NOT NULL,
    CHECK ((own_subscription IS NULL) = (own_plan IS NULL)),
    CHECK ((seat_subscription IS NULL) = (seat_owner IS NULL))
  );
  CREATE TABLE billing_event (
    id  TEXT PRIMARY KEY,
    at  INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE plan_next (
    one                INTEGER PRIMARY KEY CHECK (one = 1),
    trial_ends_at      INTEGER,
    own_subscription   TEXT,
    own_plan           TEXT CHECK (own_plan IN ('standard', 'plus', 'ai')),
    seat_subscription  TEXT,
    seat_owner         TEXT,
    updated_at         INTEGER NOT NULL,
    CHECK ((own_subscription IS NULL) = (own_plan IS NULL)),
    CHECK ((seat_subscription IS NULL) = (seat_owner IS NULL))
  );
  INSERT INTO plan_next (one, trial_ends_at, own_subscription, own_plan, seat_subscription, seat_owner, updated_at)
    SELECT one, NULL, own_subscription, own_plan, seat_subscription, seat_owner, updated_at FROM plan;
  DROP TABLE plan;
  ALTER TABLE plan_next RENAME TO plan;
  `,
  `
  CREATE TABLE checkout_session (
    id          TEXT PRIMARY KEY,
    event_key   TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE box_next (
    one                INTEGER PRIMARY KEY CHECK (one = 1),
    name               TEXT NOT NULL,
    host               TEXT NOT NULL CHECK (host IN ('fly', 'static')),
    url                TEXT NOT NULL,
    state              TEXT NOT NULL CHECK (state IN ('provisioning', 'signed_out', 'signed_in', 'reclaiming')),
    state_at           INTEGER NOT NULL,
    link_sent_at       INTEGER,
    signin_poll_until  INTEGER,
    attempts           INTEGER NOT NULL DEFAULT 0,
    next_at            INTEGER,
    poll_at            INTEGER,
    reclaim_at         INTEGER,
    reclaim_reason     TEXT CHECK (reclaim_reason IN ('unused', 'failed', 'retired')),
    retire_at          INTEGER,
    image              TEXT,
    ensure_at          INTEGER,
    CHECK ((state = 'reclaiming') = (reclaim_reason IS NOT NULL))
  );
  INSERT INTO box_next (one, name, host, url, state, state_at, link_sent_at, signin_poll_until, attempts, next_at, poll_at, reclaim_at,
                        reclaim_reason)
    SELECT one, name, host, url, CASE state WHEN 'failed' THEN 'reclaiming' ELSE state END, state_at, link_sent_at, signin_poll_until,
           CASE state WHEN 'failed' THEN 0 ELSE attempts END, CASE state WHEN 'failed' THEN state_at ELSE next_at END, poll_at, reclaim_at,
           CASE state WHEN 'failed' THEN 'failed' WHEN 'reclaiming' THEN 'unused' END
    FROM box;
  DROP TABLE box;
  ALTER TABLE box_next RENAME TO box;
  `,
  `
  ALTER TABLE agent ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('th', 'en'));
  UPDATE agent SET language = 'th' WHERE channel = 'line';
  `,
];

export function migrate(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const row = sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'schema_version'").toArray()[0];
  for (let i = row ? Number(row.v) : 0; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i];
    storage.transactionSync(() => {
      sql.exec(migration);
      sql.exec("INSERT INTO meta (k, v) VALUES ('schema_version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", String(i + 1));
    });
  }
}
