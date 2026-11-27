-- Activation is the first AI-backed call that produced a response. Gate starters are only participants with that signal;
-- people without it stay visible as not_connected instead of reading as product failure.
DROP VIEW IF EXISTS gate_first_week;
DROP VIEW IF EXISTS participant;

CREATE VIEW participant AS
SELECT e.agent_key, e.cohort, e.half, e.inviter, e.channel, c.at AS admitted_at,
       (SELECT MIN(m.at) FROM model_call m
         WHERE m.agent_key = e.agent_key AND m.status IN ('settled', 'usage_missing')) AS connected_ai_at,
       CASE e.cohort WHEN 'recruit' THEN b.starts_at ELSE c.at END AS week0
FROM enrollment e
JOIN (SELECT agent_key, MIN(at) AS at FROM admission_log WHERE change = 'consented' GROUP BY agent_key) c USING (agent_key)
JOIN beta b;

CREATE VIEW gate_first_week AS
WITH halves(half) AS (VALUES ('th_line'), ('intl_telegram'))
SELECT h.half,
       COALESCE(SUM(p.connected_ai_at IS NOT NULL), 0) AS starters,
       COALESCE(SUM(p.connected_ai_at IS NULL AND p.agent_key IS NOT NULL), 0) AS not_connected,
       COALESCE(SUM(p.connected_ai_at IS NOT NULL AND EXISTS (SELECT 1 FROM completion c WHERE c.agent_key = p.agent_key AND c.week = 0)), 0) AS completed
FROM halves h LEFT JOIN participant p ON p.half = h.half AND p.cohort = 'recruit'
GROUP BY h.half;

-- usd_per_wau is only spend Giraffe pays for. Key and plan spend are split out instead of being read as ours.
DROP VIEW IF EXISTS gate_cost;
CREATE VIEW gate_cost AS
WITH cost AS (
  SELECT (m.at - b.starts_at) / 604800000 AS beta_week,
         CASE m.backend WHEN 'key' THEN 'key' WHEN 'box' THEN 'plan' ELSE 'giraffe' END AS payer,
         SUM(m.cost_micro) AS cost_micro
  FROM model_call m JOIN participant q USING (agent_key) JOIN beta b
  WHERE q.cohort IN ('recruit', 'joiner') AND m.at >= b.starts_at
  GROUP BY beta_week, payer
)
SELECT w.beta_week, COUNT(*) AS wau,
       SUM(EXISTS (SELECT 1 FROM model_call m JOIN beta b
                   WHERE m.agent_key = w.agent_key AND m.status = 'refused_user_cap'
                     AND m.at >= b.starts_at AND (m.at - b.starts_at) / 604800000 = w.beta_week)) AS hit_cap,
       COALESCE((SELECT c.cost_micro FROM cost c WHERE c.beta_week = w.beta_week AND c.payer = 'giraffe'), 0) / 1e6 / COUNT(*) AS usd_per_wau,
       COALESCE((SELECT c.cost_micro FROM cost c WHERE c.beta_week = w.beta_week AND c.payer = 'key'), 0) / 1e6 / COUNT(*) AS key_usd_per_wau,
       COALESCE((SELECT c.cost_micro FROM cost c WHERE c.beta_week = w.beta_week AND c.payer = 'plan'), 0) / 1e6 / COUNT(*) AS plan_usd_per_wau,
       (SELECT COUNT(*) FROM completion c JOIN beta b
         WHERE c.cohort IN ('recruit', 'joiner') AND (c.at - b.starts_at) / 604800000 = w.beta_week) * 1.0 / COUNT(*) AS tasks_per_wau
FROM weekly_active w GROUP BY w.beta_week;
