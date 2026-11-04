/**
 * The SQL that sets the beta's start, week 0 for every recruit. Without `force` an existing start is kept. The first
 * statement reports the old start, the new one, and what the second statement does, so the operator sees both dates.
 */
export function betaStartSql(startsAt: number, force: boolean): readonly [report: string, write: string] {
  const iso = new Date(startsAt).toISOString();
  const moves = force ? "1" : "NOT EXISTS (SELECT 1 FROM beta) OR (SELECT starts_at FROM beta) = " + String(startsAt);
  return [
    `SELECT COALESCE((SELECT strftime('%Y-%m-%dT%H:%M:%SZ', starts_at / 1000, 'unixepoch') FROM beta), 'none') AS old_start, '${iso}' AS new_start, ` +
      `CASE WHEN ${moves} THEN 'set' ELSE 'kept the old start: pass --force to move it' END AS outcome;`,
    `INSERT INTO beta (one, starts_at) VALUES (1, ${startsAt}) ON CONFLICT (one) DO ${force ? "UPDATE SET starts_at = excluded.starts_at" : "NOTHING"};`,
  ];
}
