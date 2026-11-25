import { plain, squash } from "./thai.ts";
import type { Fact, Unit } from "./types.ts";

const NUMBER = String.raw`(?<![\d.])(\d+(?:\.\d+)?)(?!\d)`;
const UNITS: Readonly<Record<Unit, RegExp>> = {
  baht: new RegExp(`${NUMBER} ?(?:บาท|฿|\\.-)|฿ ?${NUMBER}`, "g"),
  percent: new RegExp(`${NUMBER} ?(?:%|เปอร์เซ็นต์|เปอร์เซนต์|percent)`, "g"),
  cm: new RegExp(`${NUMBER} ?(?:ซม|เซนติเมตร|เซน|cm)`, "g"),
};

const amounts = (text: string, unit: Unit): number[] => [...plain(text).matchAll(UNITS[unit])].map((m) => Number(m[1] ?? m[2]));

const DECEMBER = String.raw`(?:ธ\.? ?ค\.?|ธันวา(?:คม)?|/ ?12(?!\d))`;
const DAY = String.raw`(?<![\d.])\d{1,2}`;
const DATES = new RegExp(`(?:${DAY} ?${DECEMBER}? ?(?:-|ถึง|จนถึง) ?(?:วันที่ ?)?)?${DAY} ?${DECEMBER}`, "g");

/** Each December date or range the text names, as its days in order. */
const decemberDays = (text: string): number[][] => [...plain(text).matchAll(DATES)].map((m) => [...m[0].replace(/\/ ?12/g, "").matchAll(/\d{1,2}/g)].map((d) => Number(d[0])));

const CUE = /(ปกติ|จาก|เดิม|ราคาเต็ม)|(เหลือ|เพียง|แค่|พิเศษ|ราคาโปร|โปร)/g;

/** Where each price stands in the text, and whether the nearest cue word just before it makes it the old or the new price. */
function pricesAt(text: string, value: number): { readonly at: number; readonly cue: "was" | "now" | null }[] {
  const t = squash(text);
  return [...t.matchAll(new RegExp(String.raw`(?<![\d.])${value}(?!\d)`, "g"))].map((m) => {
    const last = [...t.slice(Math.max(0, m.index - 12), m.index).matchAll(CUE)].at(-1);
    return { at: m.index, cue: last === undefined ? null : last[1] ? "was" : "now" };
  });
}

const has = (text: string, any: readonly string[]) => any.some((a) => squash(text).includes(squash(a)));

/** Why the text gets a fact wrong, or null when it states it and contradicts nothing. */
export function wrongFact(f: Fact, text: string): string | null {
  switch (f.kind) {
    case "says":
      return has(text, f.any) ? null : `missing ${f.label}`;
    case "never":
      return has(text, f.any) ? `claims ${f.label}` : null;
    case "amounts": {
      const got = amounts(text, f.unit);
      const gone = f.need.filter((n) => !got.includes(n));
      if (gone.length) return `missing ${f.label} ${gone.join(", ")}`;
      const odd = got.filter((n) => !f.need.includes(n) && !f.allow.includes(n));
      return odd.length ? `${f.label} also says ${odd.join(", ")}` : null;
    }
    case "dates": {
      const named = decemberDays(text);
      const odd = named.flat().filter((d) => d < f.from || d > f.to);
      if (odd.length) return `${f.label} also names day ${odd.join(", ")}`;
      return named.some((days) => days[0] === f.from && days.at(-1) === f.to) ? null : `missing ${f.label}`;
    }
    case "was_now": {
      const was = pricesAt(text, f.was);
      const now = pricesAt(text, f.now);
      if (!was.length || !now.length) return `missing ${f.label}`;
      if (was.some((p) => p.cue === "now") || now.some((p) => p.cue === "was")) return `${f.label} swapped`;
      const cued = [...was, ...now].some((p) => p.cue !== null);
      return cued || was[0].at < now[0].at ? null : `${f.label} in the wrong order`;
    }
  }
}
