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
  `
  CREATE TABLE task (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ref         TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('plan', 'booking', 'site', 'group', 'other')),
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'closed', 'expired')),
    opened_at   INTEGER NOT NULL,
    cause_key   TEXT NOT NULL,
    touched_at  INTEGER NOT NULL,
    closed_at   INTEGER,
    CHECK ((status = 'open') = (closed_at IS NULL))
  );
  CREATE UNIQUE INDEX task_open_ref ON task (ref) WHERE status = 'open';

  CREATE TABLE task_fact (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id          INTEGER NOT NULL REFERENCES task (id),
    kind             TEXT NOT NULL,
    ref              TEXT NOT NULL DEFAULT '',
    detail           TEXT NOT NULL DEFAULT '{}',
    completes        INTEGER NOT NULL DEFAULT 0 CHECK (completes IN (0, 1)),
    person_decision  INTEGER NOT NULL DEFAULT 0 CHECK (person_decision IN (0, 1)),
    cause_key        TEXT NOT NULL,
    cause_kind       TEXT NOT NULL,
    cause_at         INTEGER NOT NULL,
    at               INTEGER NOT NULL,
    UNIQUE (task_id, kind, ref)
  );
  CREATE INDEX task_fact_task ON task_fact (task_id, at);

  CREATE TABLE proposal (
    id          TEXT PRIMARY KEY,
    task_id     INTEGER NOT NULL REFERENCES task (id),
    version     INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('plan', 'approval')),
    text        TEXT NOT NULL,
    outbox_id   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'superseded', 'closed')),
    created_at  INTEGER NOT NULL,
    decided_at  INTEGER,
    UNIQUE (task_id, version)
  );
  CREATE UNIQUE INDEX proposal_open ON proposal (task_id) WHERE status = 'open';
  CREATE INDEX proposal_outbox ON proposal (outbox_id);

  CREATE TABLE admission (
    one       INTEGER PRIMARY KEY CHECK (one = 1),
    state     TEXT NOT NULL CHECK (state IN ('waitlisted', 'consenting', 'admitted', 'removed')),
    reason    TEXT CHECK (reason IN ('no_code', 'bad_code', 'used', 'full')),
    cohort    TEXT CHECK (cohort IN ('recruit', 'joiner', 'staff')),
    half      TEXT CHECK (half IN ('th_line', 'intl_telegram')),
    code      TEXT,
    inviter   TEXT,
    state_at  INTEGER NOT NULL,
    told_on   TEXT,
    CHECK ((state = 'waitlisted') = (reason IS NOT NULL)),
    CHECK ((state = 'admitted') = (cohort IS NOT NULL)),
    CHECK (state != 'consenting' OR code IS NOT NULL)
  );
  INSERT INTO admission (one, state, cohort, state_at) SELECT 1, 'admitted', 'staff', created_at FROM agent;

  ALTER TABLE wakeup ADD COLUMN task_id INTEGER;
  ALTER TABLE wakeup ADD COLUMN bookkeeping INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE outbox ADD COLUMN task_id INTEGER;
  ALTER TABLE outbox ADD COLUMN purpose TEXT CHECK (purpose IN ('task_followup', 'bookkeeping', 'unlinked'));
  ALTER TABLE outbox ADD COLUMN choice TEXT;
  ALTER TABLE outbox ADD COLUMN reply_only INTEGER NOT NULL DEFAULT 0;
  UPDATE outbox SET purpose = 'unlinked' WHERE intent = 'unasked';
  `,
  `
  CREATE TABLE model_key (
    one              INTEGER PRIMARY KEY CHECK (one = 1),
    provider         TEXT NOT NULL,
    base_url         TEXT NOT NULL,
    model            TEXT NOT NULL,
    auth             TEXT NOT NULL CHECK (auth IN ('x-api-key', 'bearer')),
    mode             TEXT NOT NULL CHECK (mode IN ('strict', 'loose')),
    kid              TEXT NOT NULL,
    iv               BLOB NOT NULL,
    ciphertext       BLOB NOT NULL,
    hint             TEXT NOT NULL,
    cap_micro        INTEGER NOT NULL,
    backup           INTEGER NOT NULL DEFAULT 0 CHECK (backup IN (0, 1)),
    backup_asked_at  INTEGER,
    revision         INTEGER NOT NULL,
    connected_at     INTEGER NOT NULL,
    fault            TEXT CHECK (fault IN ('credential', 'payment', 'model', 'rate', 'unreadable')),
    failures         INTEGER NOT NULL DEFAULT 0,
    rest_until       INTEGER,
    told_at          INTEGER,
    CHECK ((fault IS NULL) = (failures = 0)),
    CHECK (fault IS NOT NULL OR (rest_until IS NULL AND told_at IS NULL))
  );
  CREATE TABLE key_revision (
    one       INTEGER PRIMARY KEY CHECK (one = 1),
    revision  INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO key_revision (one) VALUES (1);

  CREATE TABLE owned_group (
    group_key  TEXT PRIMARY KEY,
    version    INTEGER NOT NULL
  );

  DROP TABLE spend_month;
  CREATE TABLE spend_month (
    scope        TEXT NOT NULL CHECK (scope IN ('byok', 'included')),
    month        TEXT NOT NULL,
    spent_micro  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, month)
  );

  CREATE TABLE reservation_next (
    id              TEXT PRIMARY KEY,
    month           TEXT NOT NULL,
    scope           TEXT NOT NULL CHECK (scope IN ('byok', 'included')),
    purpose         TEXT NOT NULL,
    model           TEXT NOT NULL,
    backend         TEXT NOT NULL CHECK (backend IN ('api', 'key', 'included')),
    estimate_micro  INTEGER NOT NULL,
    instance        TEXT NOT NULL,
    created_at      INTEGER NOT NULL
  );
  INSERT INTO reservation_next (id, month, scope, purpose, model, backend, estimate_micro, instance, created_at)
    SELECT id, month, 'included', purpose, 'anthropic:' || model, 'api', estimate_micro, '', created_at FROM reservation;
  DROP TABLE reservation;
  ALTER TABLE reservation_next RENAME TO reservation;
  `,
  `
  CREATE TABLE plan_next (
    one                INTEGER PRIMARY KEY CHECK (one = 1),
    trial_ends_at      INTEGER,
    own_subscription   TEXT,
    own_plan           TEXT CHECK (own_plan IN ('standard', 'plus', 'included')),
    seat_subscription  TEXT,
    seat_owner         TEXT,
    updated_at         INTEGER NOT NULL,
    CHECK ((own_subscription IS NULL) = (own_plan IS NULL)),
    CHECK ((seat_subscription IS NULL) = (seat_owner IS NULL))
  );
  INSERT INTO plan_next (one, trial_ends_at, own_subscription, own_plan, seat_subscription, seat_owner, updated_at)
    SELECT one, trial_ends_at, own_subscription, CASE own_plan WHEN 'ai' THEN 'included' ELSE own_plan END, seat_subscription, seat_owner, updated_at
    FROM plan;
  DROP TABLE plan;
  ALTER TABLE plan_next RENAME TO plan;
  `,
  `
  CREATE TABLE key_ticket (
    nonce_hash  TEXT PRIMARY KEY,
    expires_at  INTEGER NOT NULL,
    revision    INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'validating', 'saved', 'failed')),
    outcome     TEXT,
    created_at  INTEGER NOT NULL,
    CHECK ((status IN ('saved', 'failed')) = (outcome IS NOT NULL))
  );
  `,
  `
  CREATE TABLE model_key_next (
    one              INTEGER PRIMARY KEY CHECK (one = 1),
    provider         TEXT NOT NULL,
    base_url         TEXT NOT NULL,
    model            TEXT NOT NULL,
    auth             TEXT NOT NULL CHECK (auth IN ('x-api-key', 'bearer')),
    mode             TEXT NOT NULL CHECK (mode IN ('strict', 'loose')),
    kid              TEXT NOT NULL,
    iv               BLOB NOT NULL,
    ciphertext       BLOB NOT NULL,
    hint             TEXT NOT NULL,
    cap_micro        INTEGER NOT NULL,
    backup           INTEGER NOT NULL DEFAULT 0 CHECK (backup IN (0, 1)),
    backup_asked_at  INTEGER,
    revision         INTEGER NOT NULL,
    connected_at     INTEGER NOT NULL,
    fault            TEXT CHECK (fault IN ('credential', 'payment', 'model', 'rate', 'unreadable')),
    failures         INTEGER NOT NULL DEFAULT 0,
    rest_until       INTEGER,
    told_on          TEXT,
    CHECK ((fault IS NULL) = (failures = 0)),
    CHECK (fault IS NOT NULL OR (rest_until IS NULL AND told_on IS NULL))
  );
  INSERT INTO model_key_next (one, provider, base_url, model, auth, mode, kid, iv, ciphertext, hint, cap_micro, backup, backup_asked_at, revision,
                              connected_at, fault, failures, rest_until)
    SELECT one, provider, base_url, model, auth, mode, kid, iv, ciphertext, hint, cap_micro, backup, backup_asked_at, revision,
           connected_at, fault, failures, rest_until FROM model_key;
  DROP TABLE model_key;
  ALTER TABLE model_key_next RENAME TO model_key;
  `,
  `
  ALTER TABLE model_key ADD COLUMN unreadable_under TEXT;
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
    reclaim_reason     TEXT CHECK (reclaim_reason IN ('unused', 'failed', 'retired', 'removed')),
    retire_at          INTEGER,
    image              TEXT,
    ensure_at          INTEGER,
    CHECK ((state = 'reclaiming') = (reclaim_reason IS NOT NULL))
  );
  INSERT INTO box_next SELECT one, name, host, url, state, state_at, link_sent_at, signin_poll_until, attempts, next_at, poll_at, reclaim_at,
                              reclaim_reason, retire_at, image, ensure_at FROM box;
  DROP TABLE box;
  ALTER TABLE box_next RENAME TO box;

  ALTER TABLE agent ADD COLUMN claude_plan_at INTEGER;
  UPDATE agent SET claude_plan_at = (SELECT state_at FROM box) WHERE EXISTS (SELECT 1 FROM box);
  `,
  `
  ALTER TABLE wakeup ADD COLUMN repeat TEXT CHECK (repeat IN ('daily', 'weekdays', 'weekly'));
  ALTER TABLE wakeup ADD COLUMN repeat_anchor TEXT CHECK ((repeat IS NULL) = (repeat_anchor IS NULL));
  `,
  `
  CREATE TABLE box_session (
    one       INTEGER PRIMARY KEY CHECK (one = 1),
    id        TEXT,
    seen_seq  INTEGER NOT NULL,
    memory    TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE box_session ADD COLUMN reply_backfill TEXT NOT NULL DEFAULT '[]';
  `,
  `
  ALTER TABLE inbox ADD COLUMN catch_up TEXT CHECK (catch_up IN ('earlier', 'joined'));
  CREATE INDEX inbox_waiting_for_access ON inbox(received_at) WHERE status = 'done' AND catch_up = 'earlier';
  `,
  `
  ALTER TABLE inbox ADD COLUMN catch_up_budget TEXT;
  `,
  `
  CREATE TABLE saved_items (
    one               INTEGER PRIMARY KEY CHECK (one = 1),
    revision          INTEGER NOT NULL DEFAULT 0,
    snapshot          TEXT,
    snapshot_revision INTEGER,
    cursor_item       INTEGER NOT NULL DEFAULT 0,
    cursor_offset     INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO saved_items (one) VALUES (1);
  CREATE TABLE saved_item (
    ordinal   INTEGER PRIMARY KEY,
    kind      TEXT NOT NULL CHECK (kind IN ('note', 'reminder', 'task', 'setting')),
    source_id INTEGER NOT NULL
  );

  ALTER TABLE outbox ADD COLUMN saved_snapshot TEXT;
  ALTER TABLE outbox ADD COLUMN saved_item INTEGER;
  ALTER TABLE outbox ADD COLUMN saved_offset INTEGER
    CHECK ((saved_item IS NULL AND saved_offset IS NULL AND saved_snapshot IS NULL)
        OR (saved_item IS NOT NULL AND saved_offset IS NOT NULL AND texts = '[]' AND intent = 'reply' AND choice IS NULL));

  CREATE TRIGGER saved_settings_update AFTER UPDATE OF language, tz, checkin_local ON agent
  WHEN NEW.language IS NOT OLD.language OR NEW.tz IS NOT OLD.tz OR NEW.checkin_local IS NOT OLD.checkin_local
  BEGIN UPDATE saved_items SET revision = revision + 1; END;
  ${["memory_note", "wakeup", "task", "task_fact"].flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map((op) => {
      const personOnly = table !== "wakeup" ? "" : op === "UPDATE" ? "WHEN OLD.origin = 'person' OR NEW.origin = 'person'"
        : `WHEN ${op === "DELETE" ? "OLD" : "NEW"}.origin = 'person'`;
      return `CREATE TRIGGER saved_${table}_${op} AFTER ${op} ON ${table} ${personOnly}
        BEGIN UPDATE saved_items SET revision = revision + 1; END;`;
    }),
  ).join("\n")}
  `,
  `
  DELETE FROM log_outbox;
  UPDATE log_flush SET failures = 0, retry_at = 0;
  `,
  `
  CREATE TABLE forget (
    one         INTEGER PRIMARY KEY CHECK (one = 1),
    epoch       INTEGER NOT NULL DEFAULT 0,
    op          TEXT,
    opened_at   INTEGER,
    cutoff_at   INTEGER,
    cutoff_seq  INTEGER,
    CHECK ((op IS NULL) = (opened_at IS NULL)),
    CHECK (cutoff_seq IS NULL OR cutoff_at IS NOT NULL)
  );
  INSERT INTO forget (one) VALUES (1);
  ALTER TABLE box ADD COLUMN volume TEXT;
  `,
  `
  CREATE TABLE billing_alert (
    subscription_ids TEXT PRIMARY KEY,
    delivery_id      TEXT NOT NULL,
    ready_at         INTEGER,
    notified         INTEGER NOT NULL DEFAULT 0,
    attempts         INTEGER NOT NULL DEFAULT 0
  );
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
