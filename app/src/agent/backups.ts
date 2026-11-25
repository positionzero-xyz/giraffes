import type { BoxHostKind } from "../box/host";
import type { Backups } from "./forget-text";

/** The receipt may say backup copies expire only when every one has a known expiry no later than this. */
export const BACKUP_WINDOW_DAYS = 30;

/**
 * The longest any backup copy of the person's content stays recoverable at each host, in days; null where no one
 * documents it. Durable Object point-in-time recovery keeps 30 days. A Fly box volume is soft deleted for 1 day, or 7
 * when Fly destroys it moving hosts; its daily snapshots keep Fly's default 5 days, since the Worker never sets a
 * retention and turns new snapshots off. A static box runs on a machine outside our hosts. D1 holds no message text.
 */
export const HOST_BACKUP_DAYS: { readonly durableObject: number } & { readonly [K in BoxHostKind]: readonly (number | null)[] } = {
  durableObject: 30,
  fly: [7, 5],
  static: [null],
};

export function backupsWithin(days: readonly (number | null)[]): Backups {
  return days.every((d) => d !== null && d <= BACKUP_WINDOW_DAYS) ? "expire" : "pending";
}
