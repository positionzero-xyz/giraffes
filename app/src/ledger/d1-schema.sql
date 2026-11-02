-- Cross-user ledger (D1). Append-only instrumentation plus global-ceiling leases.
-- Rows arrive from agents' log_outbox with deterministic ids: every insert is INSERT OR IGNORE.
-- Nothing here is ever UPDATEd. Facts that look like updates ("did a completed task follow this
-- unasked message?") are derived at query time by the views at the bottom.
-- Times are epoch milliseconds UTC. Money is integer micro-USD.

CREATE TABLE IF NOT EXISTS agent (
  id            TEXT PRIMARY KEY,                -- 'agent:<agent_key>'
  agent_key     TEXT NOT NULL UNIQUE,            -- 'p:line:U…'
  channel       TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_log (
  id                 TEXT PRIMARY KEY,           -- '<agent_key>|<first event key>'
  agent_key          TEXT NOT NULL,
  event_kind         TEXT NOT NULL,              -- message | wakeup | checkin | lifecycle | (week 2) job_result
  batch_size         INTEGER NOT NULL,
  task_kind          TEXT,                       -- chat | reminder | plan | booking | site | group | other
  task_key           TEXT,
  task_status        TEXT NOT NULL,              -- none | started | progressed | completed | failed
  outcome            TEXT NOT NULL,              -- acted | quiet | refused_budget | model_failed | poison | no_model | stale
  refused_for_budget INTEGER NOT NULL CHECK (refused_for_budget IN (0, 1)),
  cost_micro         INTEGER NOT NULL,
  attempts           INTEGER NOT NULL,
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS turn_log_agent_time ON turn_log (agent_key, finished_at);
CREATE INDEX IF NOT EXISTS turn_log_task ON turn_log (task_status, finished_at);

CREATE TABLE IF NOT EXISTS model_call (
  id                 TEXT PRIMARY KEY,           -- reservation id
  agent_key          TEXT NOT NULL,
  purpose            TEXT NOT NULL,              -- turn | compaction | planning
  model              TEXT NOT NULL,
  status             TEXT NOT NULL,              -- settled | refused_user_cap | refused_global_ceiling | recovered_after_crash | unavailable
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
  id           TEXT PRIMARY KEY,                 -- outbox id
  agent_key    TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,                    -- wakeup (agent-origin) | checkin | (week 2) job_result
  text         TEXT NOT NULL,
  status       TEXT NOT NULL,                    -- sent | dropped_budget | dropped_blocked | failed
  day          TEXT,                             -- local date it was admitted for
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS unasked_agent_time ON unasked_message (agent_key, at);

CREATE TABLE IF NOT EXISTS lifecycle (
  id        TEXT PRIMARY KEY,                    -- inbound event key, or 'gone:<outbox id>'
  agent_key TEXT NOT NULL,
  change    TEXT NOT NULL CHECK (change IN ('follow', 'block')),
  source    TEXT NOT NULL CHECK (source IN ('channel', 'delivery')),
  at        INTEGER NOT NULL
);

-- Global ceiling. SUM(micro) per month <= ceiling is enforced by the single conditional INSERT in
-- ledger.ts; D1 serializes writes, so check-and-grant is atomic. (agent, month, seq) makes it idempotent.
CREATE TABLE IF NOT EXISTS spend_lease (
  agent_key  TEXT NOT NULL,
  month      TEXT NOT NULL,                      -- 'YYYY-MM' UTC
  seq        INTEGER NOT NULL,
  micro      INTEGER NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (agent_key, month, seq)
);
CREATE INDEX IF NOT EXISTS spend_lease_month ON spend_lease (month);

-- ---------------------------------------------------------------------------------------------
-- Gate views (the beta success gates). Weeks are counted from the agent's first_seen_at.

-- Delegated tasks completed per agent per beta week. Reminders don't count toward the main gate.
CREATE VIEW IF NOT EXISTS weekly_delegation AS
SELECT t.agent_key,
       CAST((t.finished_at - a.first_seen_at) / (7 * 86400000) AS INTEGER) AS week,
       COUNT(*) AS completed_tasks
FROM turn_log t JOIN agent a ON a.agent_key = t.agent_key
WHERE t.task_status = 'completed' AND t.task_kind NOT IN ('reminder', 'chat')
GROUP BY t.agent_key, week;

-- Main gate: completed a delegated task in >= 4 of weeks 0..5, including week 4 or 5.
CREATE VIEW IF NOT EXISTS gate_weekly_delegation AS
SELECT agent_key,
       COUNT(DISTINCT week) AS active_weeks,
       MAX(week IN (4, 5)) AS late_week
FROM weekly_delegation WHERE week BETWEEN 0 AND 5
GROUP BY agent_key
HAVING active_weeks >= 4 AND late_week = 1;

-- Always-on gate input: did a completed task follow an unasked message within 48 h?
-- Excluding bookkeeping and person-set reminders is a task_kind filter, refined when week 2 adds kinds.
CREATE VIEW IF NOT EXISTS unasked_with_followup AS
SELECT u.id, u.agent_key, u.trigger_kind, u.text, u.at,
       EXISTS (
         SELECT 1 FROM turn_log t
         WHERE t.agent_key = u.agent_key
           AND t.task_status = 'completed'
           AND t.task_kind NOT IN ('reminder', 'chat')
           AND t.finished_at > u.at AND t.finished_at <= u.at + 48 * 3600000
       ) AS followed
FROM unasked_message u WHERE u.status = 'sent';

CREATE VIEW IF NOT EXISTS block_rate AS
SELECT (SELECT COUNT(DISTINCT agent_key) FROM lifecycle WHERE change = 'block') * 1.0
     / (SELECT COUNT(*) FROM agent) AS blocked_share;

CREATE VIEW IF NOT EXISTS cost_per_agent_week AS
SELECT m.agent_key,
       CAST((m.at - a.first_seen_at) / (7 * 86400000) AS INTEGER) AS week,
       SUM(m.cost_micro) / 1e6 AS usd,
       SUM(m.status LIKE 'refused%') AS refusals
FROM model_call m JOIN agent a ON a.agent_key = m.agent_key
GROUP BY m.agent_key, week;
