CREATE TABLE IF NOT EXISTS agent (
  id            TEXT PRIMARY KEY,
  agent_key     TEXT NOT NULL UNIQUE,
  channel       TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_log (
  id                 TEXT PRIMARY KEY,
  agent_key          TEXT NOT NULL,
  event_kind         TEXT NOT NULL,
  batch_size         INTEGER NOT NULL,
  outcome            TEXT NOT NULL CHECK (outcome IN ('acted', 'quiet', 'refused_budget', 'lapsed', 'model_failed', 'poison', 'no_model', 'stale')),
  refused_for_budget INTEGER NOT NULL CHECK (refused_for_budget IN (0, 1)),
  cost_micro         INTEGER NOT NULL,
  attempts           INTEGER NOT NULL,
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS turn_log_agent_time ON turn_log (agent_key, finished_at);

CREATE TABLE IF NOT EXISTS model_call (
  id                 TEXT PRIMARY KEY,
  agent_key          TEXT NOT NULL,
  purpose            TEXT NOT NULL CHECK (purpose IN ('turn', 'compaction', 'planning')),
  model              TEXT NOT NULL,
  backend            TEXT NOT NULL DEFAULT 'api' CHECK (backend IN ('api', 'box')),
  status             TEXT NOT NULL CHECK (status IN ('settled', 'refused_user_cap', 'refused_global_ceiling', 'recovered_after_crash', 'unavailable', 'rejected', 'in_doubt')),
  estimate_micro     INTEGER NOT NULL,
  cost_micro         INTEGER NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  at                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS model_call_agent_time ON model_call (agent_key, at);

CREATE TABLE IF NOT EXISTS unasked_message (
  id           TEXT PRIMARY KEY,
  agent_key    TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'dropped_budget', 'dropped_blocked', 'dropped_quota', 'failed')),
  day          TEXT,
  at           INTEGER NOT NULL,
  task_id      TEXT,
  purpose      TEXT NOT NULL CHECK (purpose IN ('task_followup', 'bookkeeping', 'unlinked'))
);
CREATE INDEX IF NOT EXISTS unasked_agent_time ON unasked_message (agent_key, at);
CREATE INDEX IF NOT EXISTS unasked_task ON unasked_message (task_id, at);

CREATE TABLE IF NOT EXISTS task (
  id         TEXT PRIMARY KEY,
  agent_key  TEXT NOT NULL,
  ref        TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('plan', 'booking', 'site', 'group', 'other')),
  title      TEXT NOT NULL,
  cause_kind TEXT NOT NULL,
  opened_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_agent ON task (agent_key, opened_at);

-- No CHECK on kind: a new kind of evidence arrives as data. completes is set once, by the DO, on the fact that moved
-- the task to completed, so no view keeps a list of kinds.
CREATE TABLE IF NOT EXISTS task_fact (
  id              TEXT PRIMARY KEY,
  agent_key       TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  ref             TEXT NOT NULL,
  detail          TEXT NOT NULL,
  completes       INTEGER NOT NULL CHECK (completes IN (0, 1)),
  person_decision INTEGER NOT NULL CHECK (person_decision IN (0, 1)),
  cause_kind      TEXT NOT NULL,
  cause_at        INTEGER NOT NULL,
  at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_fact_task ON task_fact (task_id, at);
CREATE INDEX IF NOT EXISTS task_fact_agent ON task_fact (agent_key, completes, at);

CREATE TABLE IF NOT EXISTS lifecycle (
  id        TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  change    TEXT NOT NULL CHECK (change IN ('follow', 'block')),
  source    TEXT NOT NULL CHECK (source IN ('channel', 'delivery')),
  at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS action_rejection (
  id        TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  turn_id   TEXT NOT NULL,
  action    TEXT NOT NULL,
  reason    TEXT NOT NULL CHECK (reason IN ('duplicate', 'limit', 'past', 'too_far', 'bad_time', 'bad_key', 'reserved_key', 'task_limit', 'task_unknown', 'task_done', 'plan_empty', 'plan_too_thin', 'too_many_proposals', 'too_many_task_ops', 'not_pending', 'bad_zone', 'too_many_sends', 'too_many_actions', 'too_long')),
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS action_rejection_agent_time ON action_rejection (agent_key, at);

CREATE TABLE IF NOT EXISTS boxes (
  agent_key  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  host       TEXT NOT NULL CHECK (host IN ('fly', 'static')),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS billing_subscription (
  id         TEXT PRIMARY KEY,
  owner_key  TEXT NOT NULL,
  plan       TEXT NOT NULL CHECK (plan IN ('standard', 'plus', 'ai')),
  customer_id TEXT,
  status     TEXT NOT NULL CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'paused', 'canceled')),
  seats      INTEGER NOT NULL,
  past_due_since INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS billing_subscription_owner ON billing_subscription (owner_key);

CREATE TABLE IF NOT EXISTS billing_duplicate (
  owner_key        TEXT NOT NULL,
  subscription_ids TEXT NOT NULL,
  found_at         INTEGER NOT NULL,
  PRIMARY KEY (owner_key, subscription_ids)
);

CREATE TABLE IF NOT EXISTS billing_seat (
  agent_key       TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  joined_at       INTEGER NOT NULL,
  left_at         INTEGER
);
CREATE INDEX IF NOT EXISTS billing_seat_subscription ON billing_seat (subscription_id, left_at);

CREATE TABLE IF NOT EXISTS billing_invite (
  code            TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_by         TEXT,
  used_at         INTEGER
);

CREATE TABLE IF NOT EXISTS line_quota (
  at     INTEGER PRIMARY KEY,
  month  TEXT NOT NULL,
  quota  INTEGER,
  used   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS line_quota_alert (
  month   TEXT NOT NULL,
  percent INTEGER NOT NULL,
  via     TEXT NOT NULL CHECK (via IN ('line', 'telegram', 'log')),
  at      INTEGER NOT NULL,
  PRIMARY KEY (month, percent)
);

CREATE TABLE IF NOT EXISTS spend_lease (
  agent_key  TEXT NOT NULL,
  month      TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  micro      INTEGER NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (agent_key, month, seq)
);
CREATE INDEX IF NOT EXISTS spend_lease_month ON spend_lease (month);
