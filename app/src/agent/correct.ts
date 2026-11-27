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
  for (let i = 0; i < parts.length; ) {
    if (wrong.every((w, j) => parts[i + j] === w)) {
      out.push(...right);
      i += wrong.length;
    } else {
      out.push(parts[i++]);
    }
  }
  return out.join("-").slice(0, 40).replace(/-+$/, "");
}

/**
 * The model's correction, kept only when it names at least two characters of wrong words, different right words that
 * fit `maxBytes`, and the wrong words appear in what was saved: it can fix a fact, never rewrite the chat at large.
 */
export function checkCorrection(raw: { readonly wrong: string; readonly right: string }, saved: readonly string[], maxBytes: number): CorrectionCheck {
  const correction = { wrong: raw.wrong.trim(), right: raw.right.trim() };
  const { wrong, right } = correction;
  if ([...wrong].length < 2 || right === "" || bytesOf(right) > maxBytes || wrong.toLowerCase() === right.toLowerCase()) {
    return { ok: false, why: "malformed" };
  }
  return saved.some((s) => correctText(s, correction) !== s) ? { ok: true, correction } : { ok: false, why: "not_saved" };
}

export type Fix = { readonly text: (s: string) => string; readonly key: (s: string) => string; readonly ref: (s: string) => string };

const json = <T>(v: string) => JSON.parse(v) as T;
const words = (v: string, f: Fix) => f.text(v);

function correctEvent(e: Record<string, unknown>, f: Fix): Record<string, unknown> {
  if (e.kind === "message" && typeof e.text === "string") return { ...e, text: f.text(e.text) };
  if (e.kind === "wakeup" && typeof e.key === "string" && typeof e.note === "string") return { ...e, key: f.key(e.key), note: f.text(e.note) };
  return e;
}

/** Every column that keeps the person's words, and how a correction rewrites it. */
export const WORD_COLUMNS = {
  memory: { summary: words },
  memory_note: { text: words },
  turn: { text: words },
  proposal: { text: words },
  task: { title: words, ref: (v: string, f: Fix) => f.ref(v) },
  wakeup: { note: words, key: (v: string, f: Fix) => f.key(v) },
  task_fact: {
    detail: (v: string, f: Fix) => JSON.stringify(Object.fromEntries(Object.entries(json<Record<string, unknown>>(v)).map(([k, x]) => [k, typeof x === "string" ? f.text(x) : x]))),
  },
  outbox: { texts: (v: string, f: Fix) => JSON.stringify(json<string[]>(v).map(f.text)) },
  inbox: { payload: (v: string, f: Fix) => JSON.stringify(correctEvent(json<Record<string, unknown>>(v), f)) },
} as const satisfies Record<string, Record<string, (value: string, fix: Fix) => string>>;

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
