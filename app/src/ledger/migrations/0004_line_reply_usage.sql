CREATE TABLE IF NOT EXISTS line_reply_usage (
  month TEXT PRIMARY KEY,
  used  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS line_reply_quota_alert (
  month   TEXT NOT NULL,
  percent INTEGER NOT NULL,
  via     TEXT NOT NULL CHECK (via IN ('line', 'telegram', 'log')),
  at      INTEGER NOT NULL,
  PRIMARY KEY (month, percent)
);
