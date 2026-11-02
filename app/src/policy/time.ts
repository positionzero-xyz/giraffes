/**
 * Zone math. Pure. Uses `Intl.DateTimeFormat` (Workers ship full ICU tz data).
 * Every conversion between instants and wall time in the codebase goes through this file.
 */
import type { EpochMs, LocalDate, LocalDateTime, MonthKey, TimeOfDay, TimeZone } from "../domain";

export const DEFAULT_TIME_ZONE = "Asia/Bangkok" as TimeZone;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Boundary constructor. Returns null for anything `Intl` rejects. */
export function parseTimeZone(raw: string): TimeZone | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw as TimeZone;
  } catch {
    return null;
  }
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Boundary constructor for model output. Accepts exactly "YYYY-MM-DDTHH:mm" with a real calendar date. */
export function parseLocalDateTime(raw: string): LocalDateTime | null {
  const m = LOCAL_DATE_TIME.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  if (h > 23 || mi > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return raw as LocalDateTime;
}

type Fields = { y: number; mo: number; d: number; h: number; mi: number; s: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: TimeZone): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

function fieldsAt(t: number, tz: TimeZone): Fields {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(t)) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour, mi: parts.minute, s: parts.second };
}

/** The instant's wall clock in `tz`, written as if it were UTC. */
function wallMs(t: number, tz: TimeZone): number {
  const f = fieldsAt(t, tz);
  return Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
}

/** Local minus UTC at instant `t`, in ms. */
function offsetAt(t: number, tz: TimeZone): number {
  return wallMs(t, tz) - Math.floor(t / 1000) * 1000;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function toLocal(t: EpochMs, tz: TimeZone): LocalDateTime {
  const f = fieldsAt(t, tz);
  return `${pad(f.y, 4)}-${pad(f.mo)}-${pad(f.d)}T${pad(f.h)}:${pad(f.mi)}` as LocalDateTime;
}

function localWall(l: LocalDateTime): number {
  return Date.UTC(+l.slice(0, 4), +l.slice(5, 7) - 1, +l.slice(8, 10), +l.slice(11, 13), +l.slice(14, 16));
}

/**
 * Wall time to instant.
 * Invariant: never throws for a parsed LocalDateTime. A DST gap resolves forward to the first valid
 * minute; an overlap resolves to the earlier instant. (Asia/Bangkok has neither; Telegram users elsewhere do.)
 */
export function fromLocal(l: LocalDateTime, tz: TimeZone): EpochMs {
  const wall = localWall(l);
  const before = wall - offsetAt(wall - DAY, tz);
  const after = wall - offsetAt(wall + DAY, tz);
  const exact = [before, after].filter((c) => wallMs(c, tz) === wall);
  if (exact.length > 0) return Math.min(...exact) as EpochMs;
  // A gap: the wall clock jumps over `wall` somewhere between the two candidates. Find the first
  // minute whose wall time is at or past it.
  let lo = Math.min(before, after);
  let hi = Math.max(before, after);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (wallMs(mid, tz) >= wall) hi = mid;
    else lo = mid;
  }
  return hi as EpochMs;
}

export function localDate(t: EpochMs, tz: TimeZone): LocalDate {
  return toLocal(t, tz).slice(0, 10) as LocalDate;
}

/** The instant the local day containing `t` began. */
export function startOfLocalDay(t: EpochMs, tz: TimeZone): EpochMs {
  return fromLocal(`${localDate(t, tz)}T00:00` as LocalDateTime, tz);
}

/** UTC month. Spend uses one calendar for the user cap and the global ceiling so they roll over together. */
export function monthKey(t: EpochMs): MonthKey {
  return new Date(t).toISOString().slice(0, 7) as MonthKey;
}

function addDays(day: LocalDate, n: number): LocalDate {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + n));
  return d.toISOString().slice(0, 10) as LocalDate;
}

function atLocal(day: LocalDate, hhmm: TimeOfDay, tz: TimeZone): EpochMs {
  return fromLocal(`${day}T${hhmm}` as LocalDateTime, tz);
}

/** Next instant strictly after `after` whose wall time in `tz` is `hhmm` (or the gap's end, on a DST day). */
export function nextLocalTime(after: EpochMs, tz: TimeZone, hhmm: TimeOfDay): EpochMs {
  let day = localDate(after, tz);
  for (;;) {
    const t = atLocal(day, hhmm, tz);
    if (t > after) return t;
    day = addDays(day, 1);
  }
}

export function localHour(t: EpochMs, tz: TimeZone): number {
  return fieldsAt(t, tz).h;
}

const weekdays = new Map<string, Intl.DateTimeFormat>();
export function weekday(t: EpochMs, tz: TimeZone): string {
  let f = weekdays.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" });
    weekdays.set(tz, f);
  }
  return f.format(t);
}
