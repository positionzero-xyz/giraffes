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
  outcome            TEXT NOT NULL CHECK (outcome IN ('acted', 'quiet', 'refused_budget', 'lapsed', 'model_failed', 'poison', 'no_model', 'stale', 'not_admitted')),
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

CREATE TABLE IF NOT EXISTS invite_code (
  code       TEXT PRIMARY KEY,
  cohort     TEXT NOT NULL CHECK (cohort IN ('recruit', 'joiner', 'staff')),
  half       TEXT CHECK (half IN ('th_line', 'intl_telegram')),
  issuer     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK ((issuer = 'operator') = (cohort != 'joiner'))
);
CREATE INDEX IF NOT EXISTS invite_code_issuer ON invite_code (issuer);

-- A seat, taken when the person consents. Seats are never freed, so cohort counts stay stable.
CREATE TABLE IF NOT EXISTS enrollment (
  agent_key TEXT PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  cohort    TEXT NOT NULL CHECK (cohort IN ('recruit', 'joiner', 'staff')),
  half      TEXT CHECK (half IN ('th_line', 'intl_telegram')),
  inviter   TEXT,
  channel   TEXT NOT NULL,
  seated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admission_log (
  id        TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  change    TEXT NOT NULL CHECK (change IN ('waitlisted', 'consenting', 'consented', 'removed')),
  reason    TEXT,
  channel   TEXT NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admission_log_agent ON admission_log (agent_key, change);

CREATE TABLE IF NOT EXISTS beta (
  one       INTEGER PRIMARY KEY CHECK (one = 1),
  starts_at INTEGER NOT NULL
);

-- Written by the operator with wrangler d1 execute; nothing in the agent writes these two.
CREATE TABLE IF NOT EXISTS safety_incident (
  id        TEXT PRIMARY KEY,
  agent_key TEXT,
  kind      TEXT NOT NULL CHECK (kind IN ('leave_count', 'privacy', 'group_memory_leak', 'red_team_pass', 'red_team_fail')),
  detail    TEXT NOT NULL,
  at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS survey_response (
  agent_key   TEXT NOT NULL,
  answered_at INTEGER NOT NULL,
  answer      TEXT NOT NULL CHECK (answer IN ('very', 'somewhat', 'not')),
  PRIMARY KEY (agent_key, answered_at)
);

-- Who is in the beta and when their week 0 starts: recruits share the beta's calendar, joiners and staff start at consent.
-- With no beta row there are no participants, so nothing counts from first contact.
CREATE VIEW IF NOT EXISTS participant AS
SELECT e.agent_key, e.cohort, e.half, e.inviter, e.channel, c.at AS admitted_at,
       CASE e.cohort WHEN 'recruit' THEN b.starts_at ELSE c.at END AS week0
FROM enrollment e
JOIN (SELECT agent_key, MIN(at) AS at FROM admission_log WHERE change = 'consented' GROUP BY agent_key) c USING (agent_key)
JOIN beta b;

-- Every task a participant completed. Integer division truncates toward zero, so the at >= week0 guard keeps a
-- completion from before the start out of week 0.
CREATE VIEW IF NOT EXISTS completion AS
SELECT p.agent_key, p.cohort, p.half, f.task_id, f.kind AS evidence, json_extract(f.detail, '$.via') AS via, t.kind AS task_kind, f.at,
       (f.at - p.week0) / 604800000 AS week
FROM task_fact f
JOIN participant p USING (agent_key)
JOIN task t ON t.id = f.task_id
WHERE f.completes = 1 AND f.at >= p.week0;

-- Per half, recruits who consented and those with a completion in week 0. Both halves always report.
CREATE VIEW IF NOT EXISTS gate_first_week AS
WITH halves(half) AS (VALUES ('th_line'), ('intl_telegram'))
SELECT h.half, COUNT(p.agent_key) AS starters,
       COALESCE(SUM(EXISTS (SELECT 1 FROM completion c WHERE c.agent_key = p.agent_key AND c.week = 0)), 0) AS completed
FROM halves h LEFT JOIN participant p ON p.half = h.half AND p.cohort = 'recruit'
GROUP BY h.half;

CREATE VIEW IF NOT EXISTS recruit_delegation AS
SELECT p.agent_key, p.half,
       (SELECT COUNT(DISTINCT c.week) FROM completion c WHERE c.agent_key = p.agent_key AND c.week BETWEEN 0 AND 5) AS active_weeks,
       EXISTS (SELECT 1 FROM completion c WHERE c.agent_key = p.agent_key AND c.week IN (4, 5)) AS late_week
FROM participant p WHERE p.cohort = 'recruit';

-- Per half, recruits with completions in at least 4 distinct weeks of 0 to 5, one of them week 4 or 5.
CREATE VIEW IF NOT EXISTS gate_main AS
WITH halves(half) AS (VALUES ('th_line'), ('intl_telegram'))
SELECT h.half, COUNT(r.agent_key) AS starters, COALESCE(SUM(r.active_weeks >= 4 AND r.late_week), 0) AS qualified
FROM halves h LEFT JOIN recruit_delegation r ON r.half = h.half
GROUP BY h.half;

-- An unasked follow-up is credited when the person's first code-verified decision on its task comes within 7 days of it
-- and the task completes within 14 days of that decision. Only the last follow-up before the decision is credited, so a
-- task credits at most one message. A task completes once, after the decision, so a check on a task already done can't be.
CREATE VIEW IF NOT EXISTS unasked_credit AS
WITH decided AS (
  SELECT d.task_id, MIN(d.cause_at) AS acted_at, MIN(c.at) AS completed_at
  FROM task_fact d
  JOIN task_fact c ON c.task_id = d.task_id AND c.completes = 1 AND c.at >= d.at AND c.at <= d.at + 14 * 86400000
  WHERE d.person_decision = 1
  GROUP BY d.task_id
),
touched AS (
  SELECT u.id, u.agent_key, u.task_id, u.at AS sent_at, k.acted_at, k.completed_at,
         ROW_NUMBER() OVER (PARTITION BY u.task_id ORDER BY u.at DESC, u.id DESC) AS rank
  FROM unasked_message u JOIN decided k ON k.task_id = u.task_id
  WHERE u.status = 'sent' AND u.purpose = 'task_followup' AND u.at < k.acted_at AND k.acted_at <= u.at + 7 * 86400000
)
SELECT id, agent_key, task_id, sent_at, acted_at, completed_at FROM touched WHERE rank = 1;

-- Per half, recruits with at least 2 credited messages, and starters who blocked after consenting.
CREATE VIEW IF NOT EXISTS gate_always_on AS
WITH halves(half) AS (VALUES ('th_line'), ('intl_telegram'))
SELECT h.half, COUNT(p.agent_key) AS starters,
       COALESCE(SUM((SELECT COUNT(*) FROM unasked_credit k WHERE k.agent_key = p.agent_key) >= 2), 0) AS qualified,
       COALESCE(SUM(EXISTS (SELECT 1 FROM lifecycle l WHERE l.agent_key = p.agent_key AND l.change = 'block' AND l.at >= p.admitted_at)), 0) AS blocked
FROM halves h LEFT JOIN participant p ON p.half = h.half AND p.cohort = 'recruit'
GROUP BY h.half;

-- A recruit's or joiner's week on the beta calendar counts as active when they wrote or tapped.
CREATE VIEW IF NOT EXISTS weekly_active AS
SELECT t.agent_key, p.cohort, p.half, (t.finished_at - b.starts_at) / 604800000 AS beta_week
FROM turn_log t JOIN participant p USING (agent_key) JOIN beta b
WHERE t.event_kind IN ('message', 'choice') AND t.outcome != 'not_admitted' AND t.finished_at >= b.starts_at AND p.cohort IN ('recruit', 'joiner')
GROUP BY t.agent_key, beta_week;

-- Joiners with a completion in their own week 1, invites issued and accepted, and people waiting without a seat.
CREATE VIEW IF NOT EXISTS gate_spread AS
SELECT (SELECT COUNT(DISTINCT agent_key) FROM completion WHERE cohort = 'joiner' AND week = 1) AS joiners_week2,
       (SELECT COUNT(*) FROM invite_code WHERE cohort = 'joiner') AS invites_issued,
       (SELECT COUNT(*) FROM enrollment WHERE cohort = 'joiner') AS invites_accepted,
       (SELECT COUNT(DISTINCT agent_key) FROM admission_log w WHERE change = 'waitlisted'
          AND NOT EXISTS (SELECT 1 FROM enrollment e WHERE e.agent_key = w.agent_key)) AS waitlist_length;

CREATE VIEW IF NOT EXISTS invites_per_active AS
SELECT w.beta_week, COUNT(DISTINCT w.agent_key) AS wau,
       (SELECT COUNT(*) FROM invite_code i JOIN beta b
         WHERE i.cohort = 'joiner' AND i.created_at >= b.starts_at AND (i.created_at - b.starts_at) / 604800000 = w.beta_week) AS issued
FROM weekly_active w GROUP BY w.beta_week;

-- Groups with an outcome; a group_outcome fact names its group in detail.group.
CREATE VIEW IF NOT EXISTS gate_groups AS
SELECT COUNT(DISTINCT json_extract(detail, '$.group')) AS groups_with_outcome
FROM task_fact WHERE kind = 'group_outcome';

-- Booking requests by country: made without a fallback, and confirmed or denied the next day.
CREATE VIEW IF NOT EXISTS gate_booking AS
SELECT json_extract(s.detail, '$.country') AS country,
       COUNT(DISTINCT s.task_id) AS requests,
       COUNT(DISTINCT m.task_id) AS made_without_fallback,
       COUNT(DISTINCT y.task_id) AS confirmed_next_day,
       COUNT(DISTINCT n.task_id) AS denied_next_day
FROM task_fact s
LEFT JOIN task_fact m ON m.task_id = s.task_id AND m.kind = 'booking_made'
LEFT JOIN task_fact y ON y.task_id = s.task_id AND y.kind = 'booking_confirmed'
LEFT JOIN task_fact n ON n.task_id = s.task_id AND n.kind = 'booking_denied'
WHERE s.kind = 'job_started' AND json_extract(s.detail, '$.worker') = 'booking'
GROUP BY country;

-- Must stay empty: a booking made without the person's approval of that exact version.
CREATE VIEW IF NOT EXISTS booking_without_approval AS
SELECT m.* FROM task_fact m
WHERE m.kind = 'booking_made'
  AND NOT EXISTS (SELECT 1 FROM task_fact a
                  WHERE a.task_id = m.task_id AND a.kind = 'approved' AND a.person_decision = 1 AND a.at < m.at
                    AND a.ref = json_extract(m.detail, '$.approval'));

-- Per beta week: active people, how many hit their spend cap, spend per active person, and tasks per active person.
CREATE VIEW IF NOT EXISTS gate_cost AS
SELECT w.beta_week, COUNT(*) AS wau,
       SUM(EXISTS (SELECT 1 FROM model_call m JOIN beta b
                   WHERE m.agent_key = w.agent_key AND m.status = 'refused_user_cap'
                     AND m.at >= b.starts_at AND (m.at - b.starts_at) / 604800000 = w.beta_week)) AS hit_cap,
       (SELECT SUM(m.cost_micro) FROM model_call m JOIN participant q USING (agent_key) JOIN beta b
         WHERE q.cohort IN ('recruit', 'joiner') AND m.at >= b.starts_at
           AND (m.at - b.starts_at) / 604800000 = w.beta_week) / 1e6 / COUNT(*) AS usd_per_wau,
       (SELECT COUNT(*) FROM completion c JOIN beta b
         WHERE c.cohort IN ('recruit', 'joiner') AND (c.at - b.starts_at) / 604800000 = w.beta_week) * 1.0 / COUNT(*) AS tasks_per_wau
FROM weekly_active w GROUP BY w.beta_week;

CREATE VIEW IF NOT EXISTS gate_safety AS
SELECT COALESCE(SUM(kind IN ('leave_count', 'privacy', 'group_memory_leak')), 0) AS incidents,
       COALESCE(SUM(kind = 'red_team_pass'), 0) AS red_team_passes,
       COALESCE(SUM(kind IN ('red_team_pass', 'red_team_fail')), 0) AS red_team_attempts
FROM safety_incident;

-- Active recruits and joiners, and how many of them answered 'very'.
CREATE VIEW IF NOT EXISTS gate_survey AS
SELECT COUNT(DISTINCT w.agent_key) AS active,
       COUNT(DISTINCT CASE WHEN s.answer = 'very' THEN w.agent_key END) AS very
FROM weekly_active w LEFT JOIN survey_response s ON s.agent_key = w.agent_key;

CREATE VIEW IF NOT EXISTS retention AS
SELECT p.cohort, p.half, (t.finished_at - p.week0) / 604800000 AS week, COUNT(DISTINCT p.agent_key) AS active
FROM turn_log t JOIN participant p USING (agent_key)
WHERE t.event_kind IN ('message', 'choice') AND t.finished_at >= p.week0
GROUP BY p.cohort, p.half, week;

CREATE VIEW IF NOT EXISTS tasks_by_type AS
SELECT t.kind AS task_kind, f.kind AS evidence, COUNT(*) AS opened, COUNT(f.id) AS completed
FROM task t JOIN participant p USING (agent_key)
LEFT JOIN task_fact f ON f.task_id = t.id AND f.completes = 1
WHERE p.cohort IN ('recruit', 'joiner')
GROUP BY t.kind, f.kind;

-- One row per gate view, with its threshold. passed is 0 until there is data to pass on.
CREATE VIEW IF NOT EXISTS gate_summary AS
WITH gates(n, gate) AS (VALUES (1, 'gate_first_week'), (2, 'gate_main'), (3, 'gate_always_on'), (4, 'gate_always_on block rate'),
                               (5, 'gate_spread'), (6, 'gate_groups'), (7, 'gate_cost'), (8, 'gate_safety'), (9, 'gate_survey'))
SELECT gate, COALESCE(CASE gate
  WHEN 'gate_first_week' THEN (SELECT SUM(completed) * 1.0 / NULLIF(SUM(starters), 0) >= 0.7 FROM gate_first_week)
  WHEN 'gate_main' THEN (SELECT SUM(qualified) >= 10 AND MIN(qualified) >= 4 FROM gate_main)
  WHEN 'gate_always_on' THEN (SELECT SUM(qualified) >= 8 FROM gate_always_on)
  WHEN 'gate_always_on block rate' THEN (SELECT SUM(blocked) * 1.0 / NULLIF(SUM(starters), 0) < 0.1 FROM gate_always_on)
  WHEN 'gate_spread' THEN (SELECT joiners_week2 >= 10 FROM gate_spread)
  WHEN 'gate_groups' THEN (SELECT groups_with_outcome >= 10 FROM gate_groups)
  WHEN 'gate_cost' THEN (SELECT MAX(hit_cap * 1.0 / wau) < 0.2 FROM gate_cost)
  WHEN 'gate_safety' THEN (SELECT incidents = 0 AND red_team_passes = 0 FROM gate_safety)
  WHEN 'gate_survey' THEN (SELECT very * 1.0 / NULLIF(active, 0) >= 0.4 FROM gate_survey)
END, 0) AS passed
FROM gates ORDER BY n;
