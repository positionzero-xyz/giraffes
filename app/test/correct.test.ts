import { describe, expect, test } from "vitest";
import { checkCorrection, correctSlug, correctText } from "../src/agent/correct";

const fix = (wrong: string, right: string) => ({ wrong, right });

describe("the words a correction replaces", () => {
  test("every case and spacing of the wrong words, but never part of a longer word", () => {
    const c = fix("Anna", "Annie");
    expect(correctText("Anna, ANNA and anna's cat", c)).toBe("Annie, Annie and Annie's cat");
    expect(correctText("Annabelle and Joanna", c)).toBe("Annabelle and Joanna");
    expect(correctText("12  Elm\nStreet", fix("12 Elm Street", "4 Oak Road"))).toBe("4 Oak Road");
  });

  test("Thai words, which run together, are matched inside the text", () => {
    expect(correctText("พี่สมชายจะมาวันศุกร์", fix("สมชาย", "สมศรี"))).toBe("พี่สมศรีจะมาวันศุกร์");
  });

  test("symbols in either side are literal", () => {
    expect(correctText("uses C++ (v2) daily", fix("C++ (v2)", "C# $1 [v3]"))).toBe("uses C# $1 [v3] daily");
    expect(correctText('a "quoted" \\ path', fix('"quoted" \\', "plain"))).toBe("a plain path");
  });

  test("right words that contain the wrong ones are left alone, so a repeat changes nothing", () => {
    const c = fix("Anna", "Anna Maria");
    const once = correctText("Anna called. Anna Maria too.", c);
    expect(once).toBe("Anna Maria called. Anna Maria too.");
    expect(correctText(once, c)).toBe(once);
  });
});

describe("keys and refs", () => {
  test("swap the wrong words' slug for the right ones', whole segments only", () => {
    expect(correctSlug("call-zanzibar", fix("Zanzibar", "Mombasa"))).toBe("call-mombasa");
    expect(correctSlug("visit-hat-yai-friday", fix("Hat Yai", "Songkhla"))).toBe("visit-songkhla-friday");
    expect(correctSlug("call-jose", fix("José", "Juan Pablo"))).toBe("call-juan-pablo");
    expect(correctSlug("zanzibarx", fix("Zanzibar", "Mombasa"))).toBe("zanzibarx");
  });

  test("Thai right words leave only the rest of the slug, and nothing at all when that was all of it", () => {
    expect(correctSlug("call-anna", fix("Anna", "แอนนา"))).toBe("call");
    expect(correctSlug("anna", fix("Anna", "แอนนา"))).toBe("");
    expect(correctSlug("call-anna", fix("แอนนา", "Anna"))).toBe("call-anna");
  });
});

describe("which corrections code accepts", () => {
  const saved = ["Sister Zanzibar lives in Hat Yai."];
  test("wrong words found in what was saved, and right words that differ and fit", () => {
    expect(checkCorrection(fix(" Zanzibar ", "Mombasa "), saved, 300)).toEqual({ ok: true, correction: fix("Zanzibar", "Mombasa") });
  });

  test("refuses one character, empty or too long right words, the same words, and words nobody saved", () => {
    expect(checkCorrection(fix("Z", "Mombasa"), saved, 300)).toEqual({ ok: false, why: "malformed" });
    expect(checkCorrection(fix("Zanzibar", "  "), saved, 300)).toEqual({ ok: false, why: "malformed" });
    expect(checkCorrection(fix("Zanzibar", "m".repeat(301)), saved, 300)).toEqual({ ok: false, why: "malformed" });
    expect(checkCorrection(fix("Zanzibar", "ZANZIBAR"), saved, 300)).toEqual({ ok: false, why: "malformed" });
    expect(checkCorrection(fix("Kilimanjaro", "Mombasa"), saved, 300)).toEqual({ ok: false, why: "not_saved" });
    expect(checkCorrection(fix("Zanzi", "Mombasa"), saved, 300)).toEqual({ ok: false, why: "not_saved" });
  });
});
