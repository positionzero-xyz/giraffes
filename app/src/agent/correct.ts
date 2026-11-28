import { bytesOf } from "../model/prompt";
import { NOTICES } from "../notices";

/** The person says a saved fact is wrong: `wrong` gives way to `right` wherever their words are kept. */
export type Correction = { readonly wrong: string; readonly right: string };

export type CorrectionCheck =
  | { readonly ok: true; readonly correction: Correction }
  | { readonly ok: false; readonly why: "malformed" | "not_saved" };

const WORD = /[\p{L}\p{M}\p{N}]/u;
const THAI = /\p{Script=Thai}/u;
const words = new Intl.Segmenter("th", { granularity: "word" });
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function wordMatches(text: string, phrase: string): RegExpMatchArray[] {
  const chars = [...phrase];
  const first = chars[0];
  const last = chars.at(-1) ?? "";
  const thaiStart = THAI.test(first);
  const thaiEnd = THAI.test(last);
  const body = phrase.split(/\s+/).map(escape).join("\\s+");
  const start = !thaiStart && WORD.test(first) ? "(?<![\\p{L}\\p{M}\\p{N}])" : "";
  const end = !thaiEnd && WORD.test(last) ? "(?![\\p{L}\\p{M}\\p{N}])" : "";
  const matches = [...text.matchAll(new RegExp(`${start}${body}${end}`, "giu"))];
  if (matches.length === 0 || (!thaiStart && !thaiEnd)) return matches;
  const segments = words.segment(text);
  return matches.filter((m) => {
    const at = m.index ?? 0;
    const after = at + m[0].length;
    return (!thaiStart || segments.containing(at)?.index === at) &&
      (!thaiEnd || after === text.length || segments.containing(after)?.index === after);
  });
}

/** Replaces every wrong phrase outside an already-correct phrase, using boundaries in the original text. */
export function correctText(text: string, c: Correction): string {
  const wrong = wordMatches(text, c.wrong);
  if (wrong.length === 0) return text;
  const right = wordMatches(text, c.right);
  let out = "";
  let from = 0;
  let i = 0;
  for (const match of wrong) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    while (i < right.length && (right[i].index ?? 0) + right[i][0].length <= start) i++;
    if (i < right.length && (right[i].index ?? 0) < end) continue;
    out += text.slice(from, start) + c.right;
    from = end;
  }
  return out + text.slice(from);
}

export function clipCorrectedCopy(text: string, limit: number): string {
  const end = words.segment(text).containing(limit - 1)?.index ?? 0;
  return text.slice(0, end).trimEnd() + "\u2026";
}

const slugWords = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== "");

/** A wake-up key or task ref with the wrong words' slug swapped for the right ones'; "" when nothing would be left. */
export function correctSlug(slug: string, c: Correction): string {
  const wrong = slugWords(c.wrong);
  if (wrong.length === 0) return slug;
  const right = slugWords(c.right);
  const parts = slug.split("-");
  const out: string[] = [];
  let matched = false;
  for (let i = 0; i < parts.length; ) {
    if (wrong.every((w, j) => parts[i + j] === w)) {
      out.push(...right);
      matched = true;
      i += wrong.length;
    } else {
      out.push(parts[i++]);
    }
  }
  return matched ? out.join("-").replace(/-+$/, "") : slug;
}

/**
 * The model's correction, kept only when it names at least three characters of wrong words, different right words that
 * fit `maxBytes`, and the wrong words appear in what was saved: it can fix a fact, never rewrite the chat at large.
 */
export function checkCorrection(raw: { readonly wrong: string; readonly right: string }, saved: readonly string[], maxBytes: number): CorrectionCheck {
  const control = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  if (control.test(raw.wrong) || control.test(raw.right)) return { ok: false, why: "malformed" };
  const correction = { wrong: raw.wrong.trim(), right: raw.right.trim() };
  const { wrong, right } = correction;
  if ([...wrong].length < 3 || right === "" || bytesOf(right) > maxBytes || wrong.toLowerCase() === right.toLowerCase()) {
    return { ok: false, why: "malformed" };
  }
  return saved.some((s) => correctText(s, correction) !== s) ? { ok: true, correction } : { ok: false, why: "not_saved" };
}

type SpanKind = "person" | "send" | "late" | "plan" | "erase";

export type CorrectionSpan = { readonly kind: SpanKind; readonly start: number; readonly length: number };
export type TrackedText = { readonly text: string; readonly spans?: readonly CorrectionSpan[] };

const dynamic = "\u0000";
const notices = Object.values(NOTICES);
const olderNoteTemplates = notices.flatMap((n) => [n.planAccepted(dynamic), n.reminder(dynamic)].map((t) => t.split(dynamic)));

export function legacyNoteSpans(text: string, eventKey: string): CorrectionSpan[] {
  const wake = eventKey.startsWith("wake:") && /^Wake-up "([^"]+)" \(due [^\n]+\): ([\s\S]*)$/.exec(text);
  if (wake) {
    const key = 'Wake-up "'.length;
    return [
      { kind: "erase", start: key, length: wake[1].length },
      { kind: "erase", start: text.length - wake[2].length, length: wake[2].length },
    ];
  }
  const spans: CorrectionSpan[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const template = olderNoteTemplates.find(([prefix, suffix]) => line.startsWith(prefix) && line.endsWith(suffix));
    if (template) {
      const [prefix, suffix] = template;
      spans.push({ kind: "erase", start: at + prefix.length, length: line.length - prefix.length - suffix.length });
    }
    at += line.length + 1;
  }
  return spans;
}

export function legacyAgentSpans(text: string, eventKey: string, plan: boolean): CorrectionSpan[] {
  const firstLineEnd = text.indexOf("\n");
  const firstLine = text.slice(0, firstLineEnd);
  const late = firstLineEnd >= 0 && (eventKey.startsWith("wake:") || eventKey.startsWith("checkin:")) &&
    notices.some((n) => {
      const [prefix, suffix] = n.lateFallback(dynamic).split(dynamic);
      return firstLine.startsWith(prefix) && firstLine.endsWith(suffix);
    });
  const start = late ? firstLineEnd + 1 : 0;
  return [{ kind: plan ? "plan" : "send", start, length: text.length - start }];
}

export const tracked = (text: string, kind: SpanKind): TrackedText => ({ text, spans: [{ kind, start: 0, length: text.length }] });

export function interpolated(text: string, words: string): TrackedText {
  return { text, spans: [{ kind: "erase", start: text.lastIndexOf(words), length: words.length }] };
}

export function joinTracked(parts: readonly TrackedText[], separator = "\n"): TrackedText {
  const spans: CorrectionSpan[] = [];
  let start = 0;
  for (const part of parts) {
    for (const span of part.spans ?? []) spans.push({ ...span, start: start + span.start });
    start += part.text.length + separator.length;
  }
  return { text: parts.map((part) => part.text).join(separator), spans };
}

export function correctTracked(
  text: string,
  spans: readonly CorrectionSpan[],
  rewrite: (text: string, kind: SpanKind) => string,
): TrackedText | null {
  let from = 0;
  let out = "";
  const next: CorrectionSpan[] = [];
  let erase = false;
  for (const span of spans) {
    const original = text.slice(span.start, span.start + span.length);
    const revised = rewrite(original, span.kind);
    erase ||= span.kind === "erase" && revised !== original;
    out += text.slice(from, span.start);
    next.push({ ...span, start: out.length, length: revised.length });
    out += revised;
    from = span.start + span.length;
  }
  return erase ? null : { text: out + text.slice(from), spans: next };
}

/**
 * Columns a correction can't rewrite in place, so it deletes their rows: the box session, whose transcript lives on the
 * box, and outside writes that mention the wrong words, whose arguments are bound to what the person approved.
 */
export const DELETED_ON_CORRECTION = { box_session: ["memory", "reply_backfill"], outside_write: ["args", "receipt"] } as const;

export function jsonStrings(v: string | null): string[] {
  if (v === null) return [];
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (typeof x === "string") out.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x !== null && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(JSON.parse(v));
  return out;
}
