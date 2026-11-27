-- SQLite can't alter a CHECK constraint. Rebuild the table with tool_refused allowed, preserving rows.
DROP TRIGGER IF EXISTS diagnostic_action_rejection_insert;
DROP TRIGGER IF EXISTS diagnostic_action_rejection_update;
DROP INDEX IF EXISTS action_rejection_agent_time;

ALTER TABLE action_rejection RENAME TO action_rejection_before_tool_refused;

CREATE TABLE action_rejection (
  id        TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  turn_id   TEXT NOT NULL,
  action    TEXT NOT NULL,
  reason    TEXT NOT NULL CHECK (reason IN ('duplicate', 'limit', 'past', 'too_far', 'bad_time', 'bad_key', 'reserved_key', 'task_limit', 'task_unknown', 'task_done', 'plan_empty', 'plan_too_thin', 'too_many_proposals', 'too_many_task_ops', 'not_pending', 'bad_zone', 'too_many_sends', 'too_many_actions', 'too_long', 'tool_refused')),
  at        INTEGER NOT NULL
);

INSERT INTO action_rejection (id, agent_key, turn_id, action, reason, at)
SELECT id, agent_key, turn_id, action, reason, at FROM action_rejection_before_tool_refused;

DROP TABLE action_rejection_before_tool_refused;
CREATE INDEX action_rejection_agent_time ON action_rejection (agent_key, at);

CREATE TRIGGER diagnostic_action_rejection_insert
BEFORE INSERT ON action_rejection
WHEN NEW.action IS NOT ''
  OR typeof(NEW.at) != 'integer'
BEGIN SELECT RAISE(ABORT, 'invalid diagnostic row'); END;

CREATE TRIGGER diagnostic_action_rejection_update
BEFORE UPDATE ON action_rejection
WHEN NEW.action IS NOT ''
  OR typeof(NEW.at) != 'integer'
BEGIN SELECT RAISE(ABORT, 'invalid diagnostic row'); END;
