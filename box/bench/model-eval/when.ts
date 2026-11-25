import type { Reading, Wall } from "./types.ts";

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, "0");

export function parseWall(raw: string): Wall | null {
  const m = WALL.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && h < 24 && mi < 60 ? (raw as Wall) : null;
}

const wallAsUtc = (w: Wall) => new Date(`${w}:00Z`);
const fromDate = (t: Date) => `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` as Wall;

export const addMinutes = (w: Wall, n: number): Wall => fromDate(new Date(wallAsUtc(w).getTime() + n * 60_000));
export const dateOf = (w: Wall): string => w.slice(0, 10);

export const dayAt = (w: Wall, days: number, hhmm: string): Wall => `${dateOf(addMinutes(w, days * 1440))}T${hhmm}` as Wall;

export const mondayIndex = (w: Wall): number => (wallAsUtc(w).getUTCDay() + 6) % 7;

export function nextWeekday(w: Wall, weekday: number, hhmm: string): Wall {
  const days = (weekday - mondayIndex(w) + 7) % 7;
  const same = dayAt(w, days, hhmm);
  return same > w ? same : dayAt(w, days + 7, hhmm);
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** A weekly routine's first time: the next one, or now as well when asked at its very minute, since the Worker takes a reminder due this minute. */
export function weeklyReadings(w: Wall, weekday: number, hhmm: string): Reading[] {
  const next = { label: `next ${DAYS[weekday]} ${hhmm}`, at: nextWeekday(w, weekday, hhmm) };
  return mondayIndex(w) === weekday && w.slice(11) === hhmm ? [{ label: "starting now", at: w }, next] : [next];
}

/** "Next Friday" names a later day than today: the coming one, or the one a week after it. */
export function nextWeekReadings(w: Wall, weekday: number, hhmm: string): Reading[] {
  const coming = dayAt(w, (weekday - mondayIndex(w) + 7) % 7 || 7, hhmm);
  const nextWeek = dayAt(w, weekday - mondayIndex(w) + 7, hhmm);
  return coming === nextWeek ? [{ label: "next week", at: nextWeek }] : [{ label: "coming", at: coming }, { label: "next week", at: nextWeek }];
}

const BUDDHIST_ERA_OFFSET = 543;
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

export function thaiDate(w: Wall): string {
  const [y, m, d] = dateOf(w).split("-").map(Number);
  return `${d} ${THAI_MONTHS[m - 1]} ${y + BUDDHIST_ERA_OFFSET}`;
}

export function todayAt(clock: Date, tz: string, hhmm: string): Wall {
  return `${clock.toLocaleDateString("en-CA", { timeZone: tz })}T${hhmm}` as Wall;
}
