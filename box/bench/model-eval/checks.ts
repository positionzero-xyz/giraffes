import type { Check, CheckResult, Observation, Phrase } from "./types.ts";

export const REPLY_CAP = 600;

const THAI_DIGITS = /[๐-๙]/g;
export function squash(s: string): string {
  return s
    .replace(THAI_DIGITS, (d) => String(d.charCodeAt(0) - 0x0e50))
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, "")
    .toLowerCase();
}

const has = (text: string, p: Phrase) => p.any.some((a) => squash(text).includes(squash(a)));
const missing = (text: string, ps: readonly Phrase[]) => ps.filter((p) => !has(text, p)).map((p) => p.label);

export function thaiShare(s: string): number {
  const thai = s.match(/[ก-ฮะ-ฺเ-ๅ]/g)?.length ?? 0;
  const latin = s.match(/[A-Za-z]/g)?.length ?? 0;
  return thai + latin === 0 ? 0 : thai / (thai + latin);
}

const JARGON = /schedule_wakeup|cancel_wakeup|set_locale|mcp__|wake-?ups?|\btool(s|\s?calls?)?\b|\bjson\b|\bschema\b|system prompt|claude code|latenotice|unasked messages|\bprompt\b|\bmodel\b/i;

const ASKS = /[?？]|ไหม|มั้ย|หรือเปล่า|รึเปล่า|ป่ะ|กี่โมง|เวลาไหน|ตอนไหน|กี่ทุ่ม|สะดวก/;
const THAI_COUNT = ["", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก"];

export function hourPhrases(h: number, m: number): string[] {
  const mm = String(m).padStart(2, "0");
  const out = [`${h}:${mm}`, `${h}.${mm}`, `${String(h).padStart(2, "0")}:${mm}`, `${String(h).padStart(2, "0")}.${mm}`];
  if (m !== 0) return out;
  if (h >= 13 && h <= 18) {
    const n = h - 12;
    out.push(`${n}โมงเย็น`, `${THAI_COUNT[n]}โมงเย็น`, `${n}โมง`, `${THAI_COUNT[n]}โมง`);
    if (h <= 16) out.push(`บ่าย${n}`, `บ่าย${THAI_COUNT[n]}`);
  }
  if (h >= 19 && h <= 23) {
    const n = h - 18;
    out.push(`${n}ทุ่ม`, `${THAI_COUNT[n]}ทุ่ม`);
    if (n === 1) out.push("ทุ่มนึง", "ทุ่มหนึ่ง");
  }
  return out;
}

type Grader<K extends Check["kind"]> = (c: Extract<Check, { kind: K }>, o: Observation) => Omit<CheckResult, "check">;

const GRADERS: { readonly [K in Check["kind"]]: Grader<K> } = {
  thai: (c, o) => {
    const share = thaiShare(o.text);
    return { pass: share >= c.min, detail: `thai ${share.toFixed(2)} (min ${c.min})` };
  },
  no_jargon: (_, o) => {
    const hit = JARGON.exec(o.text);
    return { pass: hit === null, detail: hit ? `says "${hit[0]}"` : "none" };
  },
  mentions: (c, o) => ({ pass: has(o.text, { label: c.what, any: c.any }), detail: c.what }),
  fits_reply: (_, o) => ({ pass: o.text.length <= REPLY_CAP, detail: `${o.text.length} chars` }),
  worker_accepts: (_, o) => ({ pass: o.rejected.length === 0, detail: o.rejected.join(" ") || "none rejected" }),
  due_at: (c, o) => {
    for (const r of c.readings) {
      const w = o.wakeups.find((x) => x.at === r.at);
      if (!w) continue;
      if (c.repeat && w.repeat !== c.repeat) return { pass: false, detail: `${r.at} but repeat ${w.repeat ?? "none"}, want ${c.repeat}` };
      return { pass: true, detail: `${r.label} ${r.at}${w.repeat ? ` ${w.repeat}` : ""}` };
    }
    return { pass: false, detail: `got ${o.wakeups.map((w) => w.at).join(" ") || "no reminder"}, want ${c.readings.map((r) => r.at).join(" or ")}` };
  },
  asks_or_assumes: (c, o) => {
    const w = o.wakeups[0];
    if (!w) return ASKS.test(o.text) ? { pass: true, detail: "asked back" } : { pass: false, detail: "no reminder and no question" };
    const [h, m] = w.at.slice(11).split(":").map(Number);
    if (h < c.fromHour || h >= c.toHour) return { pass: false, detail: `${w.at} is outside ${c.fromHour}:00-${c.toHour}:00` };
    const said = hourPhrases(h, m).some((p) => squash(o.text).includes(squash(p)));
    return { pass: said, detail: said ? `assumed ${w.at} and said so` : `set ${w.at} without saying when` };
  },
  facts: (c, o) => {
    const gone = missing(o.text, c.facts);
    return { pass: gone.length === 0, detail: gone.length ? `missing ${gone.join(", ")}` : `all ${c.facts.length}` };
  },
  length: (c, o) => ({ pass: o.text.length >= c.min && o.text.length <= c.max, detail: `${o.text.length} chars (${c.min}-${c.max})` }),
  file: (c, o) => ({ pass: (o.files[c.path] ?? "").trim().length > 0, detail: c.path in o.files ? `${o.files[c.path].length} chars` : "absent" }),
  html_complete: (c, o) => {
    const html = (o.files[c.path] ?? "").trim();
    const pass = /<html[\s>]/i.test(html) && /<\/html>$/i.test(html);
    return { pass, detail: pass ? "opens and closes <html>" : "no <html> or cut short" };
  },
  page_has: (c, o) => {
    if (!o.page?.loaded) return { pass: false, detail: "page did not load" };
    const gone = missing(o.page.text, c.items);
    return { pass: gone.length === 0, detail: gone.length ? `missing ${gone.join(", ")}` : `all ${c.items.length}` };
  },
  loads_clean: (_, o) => {
    if (!o.page?.loaded) return { pass: false, detail: "page did not load" };
    return { pass: o.page.errors.length === 0, detail: o.page.errors.slice(0, 3).join(" | ") || "no errors" };
  },
  persists: (c, o) => {
    const p = o.page?.persist;
    if (!p) return { pass: false, detail: "not driven" };
    if (!p.ok) return { pass: false, detail: p.reason };
    if (c.shown && !p.shown) return { pass: false, detail: "saved but not shown after reload" };
    return { pass: true, detail: p.reason };
  },
};

export function grade(c: Check, o: Observation): CheckResult {
  const grader = GRADERS[c.kind] as Grader<typeof c.kind>;
  return { check: c.kind, ...grader(c as never, o) };
}
