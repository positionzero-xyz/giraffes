/**
 * Zone math. Pure. Uses `Intl.DateTimeFormat` (Workers ship full ICU tz data).
 * Every conversion between instants and wall time in the codebase goes through this file.
 */
import type { EpochMs, LocalDate, LocalDateTime, MonthKey, TimeZone } from "../domain";

export const DEFAULT_TIME_ZONE = "Asia/Bangkok" as TimeZone;

/** Boundary constructor. Returns null for anything `Intl` rejects. */
export function parseTimeZone(raw: string): TimeZone | null {
  // TODO: try { new Intl.DateTimeFormat("en", { timeZone: raw }); return raw as TimeZone } catch { return null }
  throw new Error("not implemented");
}

/** Boundary constructor for model output. Accepts exactly "YYYY-MM-DDTHH:mm" with a real calendar date. */
export function parseLocalDateTime(raw: string): LocalDateTime | null {
  throw new Error("not implemented");
}

export function toLocal(t: EpochMs, tz: TimeZone): LocalDateTime {
  throw new Error("not implemented");
}

/**
 * Wall time to instant.
 * Invariant: never throws for a parsed LocalDateTime. A DST gap resolves forward to the first valid
 * minute; an overlap resolves to the earlier instant. (Asia/Bangkok has neither; Telegram users elsewhere do.)
 */
export function fromLocal(l: LocalDateTime, tz: TimeZone): EpochMs {
  // TODO: guess = Date.UTC(fields); offset = offsetAt(guess, tz); candidate = guess - offset;
  //       re-check offsetAt(candidate) and adjust once (handles transitions).
  throw new Error("not implemented");
}

export function localDate(t: EpochMs, tz: TimeZone): LocalDate {
  throw new Error("not implemented");
}

/** UTC month. Spend uses one calendar for the user cap and the global ceiling so they roll over together. */
export function monthKey(t: EpochMs): MonthKey {
  throw new Error("not implemented");
}

/** Next instant strictly after `after` whose wall time in `tz` is `hh:mm`. */
export function nextLocalTime(after: EpochMs, tz: TimeZone, hhmm: `${number}:${number}`): EpochMs {
  throw new Error("not implemented");
}
