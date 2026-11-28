import { bytesOf } from "../model/prompt";

/** The person says a saved fact is wrong: `wrong` gives way to `right` wherever their words are kept. */
export type Correction = { readonly wrong: string; readonly right: string };

export type CorrectionCheck =
  | { readonly ok: true; readonly correction: Correction }
  | { readonly ok: false; readonly why: "malformed" | "not_saved" };

const WORD = /[\p{L}\p{N}]/u;
// Thai runs words together, so its words have no edges a match could check.
const UNSPACED = /\p{Script=Thai}/u;
const edged = (ch: string | undefined) => ch !== undefined && WORD.test(ch) && !UNSPACED.test(ch);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `words` anywhere, ignoring case and how much space sits between them, but not inside a longer word. */
function wordsPattern(words: string): RegExp {
  const chars = [...words];
  const body = words.split(/\s+/).map(escape).join("\\s+");
  const start = edged(chars[0]) ? "(?<![\\p{L}\\p{N}])" : "";
  const end = edged(chars.at(-1)) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${start}${body}${end}`, "giu");
}

/** Replaces every `wrong` that isn't already part of a `right`, so a second pass changes nothing. */
export function correctText(text: string, c: Correction): string {
  const right = wordsPattern(c.right);
  const wrong = wordsPattern(c.wrong);
  let out = "";
  let from = 0;
  for (const m of text.matchAll(right)) {
    out += text.slice(from, m.index).replace(wrong, () => c.right) + m[0];
    from = m.index + m[0].length;
  }
  return out + text.slice(from).replace(wrong, () => c.right);
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
 * The model's correction, kept only when it names at least two characters of wrong words, different right words that
 * fit `maxBytes`, and the wrong words appear in what was saved: it can fix a fact, never rewrite the chat at large.
 */
export function checkCorrection(raw: { readonly wrong: string; readonly right: string }, saved: readonly string[], maxBytes: number): CorrectionCheck {
  const control = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
  if (control.test(raw.wrong) || control.test(raw.right)) return { ok: false, why: "malformed" };
  const correction = { wrong: raw.wrong.trim(), right: raw.right.trim() };
  const { wrong, right } = correction;
  if ([...wrong].length < 2 || right === "" || bytesOf(right) > maxBytes || wrong.toLowerCase() === right.toLowerCase()) {
    return { ok: false, why: "malformed" };
  }
  return saved.some((s) => correctText(s, correction) !== s) ? { ok: true, correction } : { ok: false, why: "not_saved" };
}

type SpanKind = "person" | "send" | "late" | "plan" | "erase";

export type CorrectionSpan = { readonly kind: SpanKind; readonly start: number; readonly length: number };
export type TrackedText = { readonly text: string; readonly spans?: readonly CorrectionSpan[] };

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
