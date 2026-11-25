import type { Repeat } from "./types.ts";

const DIGITS: Readonly<Record<string, number>> = { ศูนย์: 0, หนึ่ง: 1, นึง: 1, เอ็ด: 1, สอง: 2, ยี่: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9 };
const POWERS: Readonly<Record<string, number>> = { สิบ: 10, ร้อย: 100, พัน: 1_000, หมื่น: 10_000, แสน: 100_000 };
const WORD = new RegExp(`${[...Object.keys(DIGITS), ...Object.keys(POWERS)].join("|")}`, "g");
const RUN = new RegExp(`(?:${WORD.source})+`, "g");

/** A run of Thai number words as a number, or null when the run isn't one number, such as สองสาม for "two or three". */
export function thaiNumber(run: string): number | null {
  const words = run.match(WORD) ?? [];
  let total = 0;
  let digit: number | null = null;
  let lastPower: number | null = null;
  for (const [i, w] of words.entries()) {
    if (w in DIGITS) {
      if (digit !== null) return null;
      if (w === "ยี่" && words[i + 1] !== "สิบ") return null;
      if (w === "เอ็ด" && words[i - 1] !== "สิบ") return null;
      digit = DIGITS[w];
      continue;
    }
    const power = POWERS[w];
    if (lastPower !== null && power >= lastPower) return null;
    total += (digit ?? 1) * power;
    digit = null;
    lastPower = power;
  }
  if (digit === null) return words.length ? total : null;
  // พันห้า is said for 1,500, as หมื่นสอง is for 12,000.
  const spoken = lastPower !== null && lastPower >= 1_000 && words.at(-2) !== undefined && words.at(-2)! in POWERS;
  return total + digit * (spoken ? lastPower! / 10 : 1);
}

/** Thai text with every number in Arabic digits and no thousands separators, dashes unified, lower case, single spaces. */
export function plain(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50))
    .replace(RUN, (run) => String(thaiNumber(run) ?? run))
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export const squash = (s: string): string => plain(s).replace(/ /g, "");

export type Stated = { readonly hours: readonly number[]; readonly minute: number };

const CLOCK = new RegExp(
  [
    String.raw`(?<![\d.,])(?<h24>\d{1,2})[:.](?<m24>\d{2})(?!\d|\.\d)`,
    String.raw`(?<![\d.,])(?<h12>\d{1,2})(?<ampm>am|pm|a\.m\.|p\.m\.)`,
    String.raw`(?<midnight>เที่ยงคืน)`,
    String.raw`(?<noon>เที่ยง)(?:ตรง|วัน)?(?<noonHalf>ครึ่ง)?`,
    String.raw`ตี(?<small>[1-5])(?<smallHalf>ครึ่ง)?`,
    String.raw`บ่าย(?:(?<pm>[1-5])(?:โมง)?|(?<pmOne>โมง))(?<pmHalf>ครึ่ง)?`,
    String.raw`(?<![\d.,])(?<tum>[1-5])?ทุ่ม(?:1(?!\d))?(?<tumHalf>ครึ่ง)?`,
    String.raw`(?<![\d.,])(?<mong>\d{1,2})โมง(?<half1>ครึ่ง)?(?<part>เช้า|เย็น|ตรง)?(?<half2>ครึ่ง)?`,
    String.raw`(?<![\d.,])(?<naliga>\d{1,2})(?:นาฬิกา|น\.)(?:(?<nMin>\d{1,2})นาที)?`,
  ].join("|"),
  "g",
);

/** Thai counts hours in sixes: โมงเช้า in the morning, บ่าย and โมงเย็น after noon, ทุ่ม at night, ตี before dawn. */
function mongHours(n: number, part: string | undefined): number[] {
  if (n > 12) return [n];
  if (part === "เย็น") return n <= 6 ? [n + 12] : [n];
  if (part === "เช้า") return n <= 5 ? [n, n + 6] : [n];
  if (n <= 5) return [n, n + 6, n + 12];
  return n === 12 ? [12] : [n, n + 12];
}

/** Every clock time the text states, each with the hours its words could mean. A duration such as "20 นาที" is not one. */
export function statedTimes(text: string): Stated[] {
  const out: Stated[] = [];
  for (const m of squash(text).matchAll(CLOCK)) {
    const g = m.groups ?? {};
    const half = g.noonHalf || g.smallHalf || g.pmHalf || g.tumHalf || g.half1 || g.half2 ? 30 : 0;
    if (g.h24) out.push({ hours: [Number(g.h24)], minute: Number(g.m24) });
    else if (g.h12) out.push({ hours: [(Number(g.h12) % 12) + (g.ampm.startsWith("p") ? 12 : 0)], minute: 0 });
    else if (g.midnight) out.push({ hours: [0], minute: 0 });
    else if (g.noon) out.push({ hours: [12], minute: half });
    else if (g.small) out.push({ hours: [Number(g.small)], minute: half });
    else if (g.pm || g.pmOne) out.push({ hours: [12 + Number(g.pm ?? 1)], minute: half });
    else if (m[0].includes("ทุ่ม")) out.push({ hours: [18 + Number(g.tum ?? 1)], minute: half });
    else if (g.mong) out.push({ hours: mongHours(Number(g.mong), g.part), minute: half });
    else if (g.naliga) out.push({ hours: [Number(g.naliga)], minute: Number(g.nMin ?? 0) });
  }
  return out.filter((t) => t.hours.every((h) => h >= 0 && h <= 23) && t.minute <= 59);
}

export const says = (text: string, hour: number, minute: number): boolean => statedTimes(text).some((t) => t.hours.includes(hour) && t.minute === minute);

const DAYS = "จันทร์|อังคาร|พุธ|พฤหัส(?:บดี)?|ศุกร์|เสาร์|อาทิตย์";
const CADENCE: readonly (readonly [Repeat, RegExp])[] = [
  ["weekdays", /วันธรรมดา|จันทร์(?:ถึง|-)ศุกร์|ทุกวันทำงาน|weekdays?/],
  ["weekly", new RegExp(`ทุก(?:วัน)?(?:${DAYS})|ทุกสัปดาห์|ทุกอาทิตย์|every(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week)|weekly`)],
  ["daily", new RegExp(`ทุกวัน(?!${DAYS}|ธรรมดา|ทำงาน|ที่)|ทุกเช้า|ทุกเย็น|daily|everyday`)],
];

/** The repeats the text claims, such as ทุกวันจันทร์ for weekly. */
export const statedRepeats = (text: string): Repeat[] => CADENCE.filter(([, re]) => re.test(squash(text))).map(([r]) => r);
