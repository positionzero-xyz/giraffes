import { says, squash, statedRepeats, statedTimes } from "./thai.ts";
import type { Check, CheckResult, Observation, Phrase, Wakeup } from "./types.ts";

export const REPLY_CAP = 600;

const has = (text: string, p: Phrase) => p.any.some((a) => squash(text).includes(squash(a)));
const missing = (text: string, ps: readonly Phrase[]) => ps.filter((p) => !has(text, p)).map((p) => p.label);

export function thaiShare(s: string): number {
  const thai = s.match(/[ก-ฮะ-ฺเ-ๅ]/g)?.length ?? 0;
  const latin = s.match(/[A-Za-z]/g)?.length ?? 0;
  return thai + latin === 0 ? 0 : thai / (thai + latin);
}

const JARGON = /schedule_wakeup|cancel_wakeup|set_locale|mcp__|wake-?ups?|\btool(s|\s?calls?)?\b|\bjson\b|\bschema\b|system prompt|claude code|latenotice|unasked messages|\bprompt\b|\bmodel\b/i;

const TIME_QUESTION = /กี่โมง|กี่ทุ่ม|เวลาไหน|เวลาอะไร|ตอนไหน|ช่วงไหน|เวลากี่|สะดวกเวลา|whattime/;
const QUESTION = /[?？]|ไหม|มั้ย|ดีคะ|ดีครับ|ดีมั้ย|หรือ|รึ/;

const clock = (w: Wakeup) => w.at.slice(11).split(":").map(Number) as [number, number];

/** Why the one reminder isn't the asked-for one-off or routine about the job, or null when it is. */
function wrongReminder(o: Observation, repeat: Wakeup["repeat"], about: readonly string[]): string | null {
  if (o.wakeups.length !== 1) return o.wakeups.length ? `${o.wakeups.length} reminders` : "no reminder";
  const [w] = o.wakeups;
  if (!w.asked) return `${w.at} marked as not asked for`;
  if (w.repeat !== repeat) return `${w.at} repeats ${w.repeat ?? "never"}, want ${repeat ?? "never"}`;
  if (!about.some((a) => squash(w.note).includes(squash(a)))) return `note "${w.note}" isn't about ${about[0]}`;
  const [h, m] = clock(w);
  if (statedTimes(o.text).length && !says(o.text, h, m)) return `the reply states another time than ${w.at.slice(11)}`;
  const cadence = statedRepeats(o.text);
  if (cadence.length && (repeat === null || cadence.some((c) => c !== repeat))) return `the reply says ${cadence.join(", ")}, set ${repeat ?? "once"}`;
  return null;
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
    const wrong = wrongReminder(o, c.repeat, c.about);
    if (wrong) return { pass: false, detail: wrong };
    const r = c.readings.find((x) => x.at === o.wakeups[0].at);
    return r ? { pass: true, detail: `${r.label} ${r.at}` } : { pass: false, detail: `got ${o.wakeups[0].at}, want ${c.readings.map((x) => x.at).join(" or ")}` };
  },
  asks_or_assumes: (c, o) => {
    if (o.wakeups.length === 0) {
      const asked = TIME_QUESTION.test(squash(o.text)) || (QUESTION.test(o.text) && statedTimes(o.text).some((t) => t.hours.some((h) => h >= c.fromHour && h < c.toHour)));
      return asked ? { pass: true, detail: "asked which time" } : { pass: false, detail: "no reminder and no question about the time" };
    }
    const wrong = wrongReminder(o, null, c.about);
    if (wrong) return { pass: false, detail: wrong };
    const w = o.wakeups[0];
    const [h, m] = clock(w);
    if (w.at.slice(0, 10) !== c.date) return { pass: false, detail: `${w.at} is not on ${c.date}` };
    if (h < c.fromHour || h >= c.toHour) return { pass: false, detail: `${w.at} is outside ${c.fromHour}:00-${c.toHour}:00` };
    return says(o.text, h, m) ? { pass: true, detail: `assumed ${w.at} and said so` } : { pass: false, detail: `set ${w.at} without saying when` };
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
