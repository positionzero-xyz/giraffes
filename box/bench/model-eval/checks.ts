import { AMOUNT } from "./browser.ts";
import { currencyAmounts, numbersIn, plain } from "./page-text.ts";
import type { Check, CheckResult, Observation, Phrase, StructuralSignal, Wakeup } from "./types.ts";
import { TURN } from "./worker.ts";

export const REPLY_CAP: number = TURN.maxTextChars;

const compact = (s: string) => plain(s).replace(/\s+/g, "");
const has = (text: string, p: Phrase) => p.any.some((a) => compact(text).includes(compact(a)));
const BRANDS = /\b(?:LINE MAN|LINE|OA|Shopee|Lazada|Facebook|TikTok|Instagram|IG|Grab|Foodpanda|Messenger)\b/g;

export function thaiShare(s: string): number {
  const letters = s.normalize("NFC").replace(BRANDS, "").match(/\p{L}/gu) ?? [];
  const thai = letters.filter((c) => /\p{Script=Thai}/u.test(c)).length;
  return letters.length === 0 ? 0 : thai / letters.length;
}

type Result = Omit<CheckResult, "check">;
const result = (pass: boolean, detail: string): Result => ({ pass, detail });
const unavailable = (detail: string): Result => ({ pass: false, detail, available: false });

function unexpectedEffects(o: Observation, cancel?: string, notes = 0): Result | null {
  const c = o.workerCommit;
  if (!c) return unavailable("Worker commit unavailable");
  if (c.wakeupsCancel.length !== (cancel === undefined ? 0 : 1) || (cancel !== undefined && c.wakeupsCancel[0] !== cancel)) {
    return result(false, `cancelled ${c.wakeupsCancel.join(", ") || "none"}, expected ${cancel ?? "none"}`);
  }
  if (c.notes.length !== notes) return result(false, `saved ${c.notes.length} notes, expected ${notes}`);
  const other = [
    c.locale && "locale",
    c.wakeupsRetime.length && "retimed wake-ups",
    c.reachability && "reachability",
    c.ensureCheckin && "check-in",
    c.admission && "admission",
    (c.tasks.open.length || c.tasks.propose || c.tasks.facts.length) && "tasks",
    c.wakeupsAdd.some((w) => w.task !== null || w.bookkeeping) && "linked or bookkeeping wake-up",
  ].filter(Boolean);
  return other.length ? result(false, `unrequested effects: ${other.join(", ")}`) : null;
}

function wrongWakeup(o: Observation, repeat: Wakeup["repeat"]): Result | null {
  if (o.wakeups.length !== 1) return result(false, `expected one wake-up, got ${o.wakeups.length}`);
  const [w] = o.wakeups;
  if (!w.asked) return result(false, `${w.at} is not person-requested`);
  if (w.repeat !== repeat) return result(false, `${w.at} repeats ${w.repeat ?? "never"}, expected ${repeat ?? "never"}`);
  return null;
}

type Grader<K extends Check["kind"]> = (c: Extract<Check, { kind: K }>, o: Observation) => Result;

const GRADERS: { readonly [K in Check["kind"]]: Grader<K> } = {
  thai: (c, o) => {
    const share = thaiShare(o.text);
    return result(share >= c.min, `thai ${share.toFixed(2)} (min ${c.min})`);
  },
  fits_reply: (_, o) => result(o.raw.trim().length <= REPLY_CAP, `${o.raw.trim().length} chars`),
  replies: (_, o) => result(o.answered && o.text.trim() !== "", o.answered ? "sent" : "no model reply delivered"),
  stops_clean: (_, o) => o.stop === undefined ? unavailable("stop reason unavailable") : result(o.stop === "end", o.stop),
  due_at: (c, o) => {
    const wrong = unexpectedEffects(o, c.cancel, c.notes) ?? wrongWakeup(o, c.repeat);
    if (wrong) return wrong;
    const got = o.wakeups[0].at;
    const reading = c.readings.find((r) => r.at === got);
    return reading ? result(true, `${reading.label} ${got}`) : result(false, `got ${got}, expected ${c.readings.map((r) => r.at).join(" or ")}`);
  },
  asks_or_assumes: (c, o) => {
    const other = unexpectedEffects(o);
    if (other) return other;
    if (o.wakeups.length === 0) return result(true, "no wake-up committed");
    const wrong = wrongWakeup(o, null);
    if (wrong) return wrong;
    const { at } = o.wakeups[0];
    const hour = Number(at.slice(11, 13));
    return result(at.slice(0, 10) === c.date && hour >= c.fromHour && hour < c.toHour, `${at}, expected ${c.date} ${c.fromHour}:00–${c.toHour}:00`);
  },
  length: (c, o) => result(o.text.length >= c.min && o.text.length <= c.max, `${o.text.length} chars (${c.min}–${c.max})`),
  file: (c, o) => result(Boolean(o.files[c.path]?.trim()), `${o.files[c.path]?.length ?? 0} chars`),
  page_has: (c, o) => {
    const page = o.page;
    if (!page?.loaded) return result(false, "page did not load");
    const gone = c.items.filter((p) => !has(page.text, p)).map((p) => p.label);
    return result(gone.length === 0, gone.length ? `missing ${gone.join(", ")}` : `all ${c.items.length}`);
  },
  loads_clean: (_, o) => {
    if (!o.page?.loaded) return result(false, "page did not load");
    return result(o.page.errors.length === 0, o.page.errors.slice(0, 3).join(" | ") || "no errors");
  },
  persists: (c, o) => {
    const p = o.page?.persist;
    if (!p?.ok) return result(false, p?.reason ?? "form not driven");
    if (p.missing.length) return result(false, `no complete entry: ${p.missing.join(", ")}`);
    return result(!c.shown || p.shown, c.shown && !p.shown ? "entry not shown after reload" : p.reason);
  },
  priced: (c, o) => {
    const groups = o.page?.priceGroups;
    if (!o.page?.loaded || !groups) return result(false, "no rendered price groups");
    const wrong = c.items.flatMap((i) => {
      const got = pricesOf(groups, i, c.items);
      return got.length && got.every((p) => p === i.price) ? [] : [`${i.label} ${got.join("/") || "unpriced"}, expected ${i.price}`];
    });
    return result(wrong.length === 0, wrong.join("; ") || `all ${c.items.length}`);
  },
  total_adds: (_, o) => {
    const p = o.page?.persist;
    if (!p?.ok || p.totalBefore === null || p.totalAfter === null) return result(false, "no reliable total before submit and after reload");
    const grew = p.totalAfter - p.totalBefore;
    return result(Math.abs(grew - Number(AMOUNT)) < 0.000001, `total ${p.totalBefore} to ${p.totalAfter} after adding ${AMOUNT}`);
  },
  order_flow: (_, o) => result(o.page?.order?.ok === true, o.page?.order?.detail ?? "order not driven"),
};

function pricesOf(groups: readonly string[], item: Phrase, all: readonly Phrase[]): number[] {
  const rows = groups.filter((s) => has(s, item) && all.every((p) => p === item || !has(s, p)));
  const priced = rows.flatMap(currencyAmounts);
  if (priced.length) return [...new Set(priced)];
  return [...new Set(rows.flatMap((s) => {
    const values = numbersIn(s);
    return values.length === 1 && !/[+−]|จำนวน|รายการ/i.test(s) ? values : [];
  }))];
}

export function grade(c: Check, o: Observation): CheckResult {
  const grader = GRADERS[c.kind] as Grader<typeof c.kind>;
  return { check: c.kind, ...grader(c, o) };
}

export function structuralSignals(r: {
  readonly stopReason?: string | null;
  readonly status: string;
  readonly refusedCalls: readonly unknown[];
  readonly rejected: readonly string[];
  readonly overReplyCap: boolean;
}): StructuralSignal[] {
  const signals: StructuralSignal[] = [];
  if (r.stopReason === "max_tokens" || r.stopReason === "refusal" || r.status === "cut_off" || r.status === "refused") signals.push("stop_reason");
  if (r.refusedCalls.length || r.rejected.length) signals.push("tool_rejection");
  if (r.overReplyCap) signals.push("reply_cap");
  if (r.status === "invalid_output") signals.push("schema_failure");
  return signals;
}
