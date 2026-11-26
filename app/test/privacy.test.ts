import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { SEND_MESSAGE_MAX_CHARS } from "../src/channels/telegram";
import { loadConfig, type Env } from "../src/config";
import { choiceToken, parseChoice } from "../src/domain";
import { NOTICES } from "../src/notices";
import { privacyPage, RETENTION_DAYS } from "../src/privacy";
import worker from "../src/worker";
import { NOTICE_URL, PRIVACY_VARS, TEST_KEY_SECRET } from "./testkit";

const LINE_TEXT_MAX = 5000;
const LINE_QUICK_REPLY_LABEL_MAX = 20;

describe("the consent message", () => {
  test("says who handles a person's words, in English and Thai, word for word", () => {
    expect(NOTICES.en.consentButton).toBe("I'm 20+ and agree");
    expect(NOTICES.en.privacy(NOTICE_URL)).toBe(`Before we start, here is how your messages are handled.
• I keep our chat and the notes, reminders and tasks I make for you, so I can help over time. Send /memory to see your notes, reminders and tasks.
• To answer you, I send your messages and what I've saved to an AI: the one you connect, such as Anthropic or your Claude plan, or on some plans one Giraffe provides. LINE or Telegram also carries every message.
• Our own logs keep your chat app ID, times, counts and costs, never your words.
• Some of these services are outside Thailand.
• If you share health or other private details, I keep them the same way, only to help you.
• You need to be 20 or over.
Who runs Giraffe, how long things are kept, and how to ask for a copy or to delete them: https://giraffes.test/privacy
Tap the button to agree.`);
    expect(NOTICES.th.consentButton).toBe("อายุ 20+ และยอมรับ");
    expect(NOTICES.th.privacy(NOTICE_URL)).toBe(`ก่อนเริ่ม ขอแจ้งให้ทราบว่าข้อความของคุณจะถูกจัดการอย่างไรนะคะ
• เราเก็บแชต รวมถึงโน้ต การเตือน และงานที่บันทึกไว้ให้คุณ เพื่อช่วยคุณได้ต่อเนื่อง ส่ง /memory เพื่อดูโน้ต การเตือน และงานของคุณ
• เพื่อตอบคุณ ข้อความและสิ่งที่บันทึกไว้จะถูกส่งไปยัง AI ที่คุณเชื่อมไว้ เช่น Anthropic หรือแพ็กเกจ Claude ของคุณ หรือ AI ที่ Giraffe จัดให้ในบางแพ็กเกจ และ LINE หรือ Telegram ก็รับส่งทุกข้อความด้วย
• บันทึกของเราเก็บ ID แอปแชต เวลา จำนวนครั้ง และค่าใช้จ่าย ไม่เก็บข้อความของคุณ
• บางบริการเหล่านี้อยู่นอกประเทศไทย
• ถ้าคุณเล่าเรื่องสุขภาพหรือเรื่องส่วนตัวที่อ่อนไหว เราจะเก็บไว้แบบเดียวกัน เพื่อช่วยคุณเท่านั้น
• ต้องมีอายุ 20 ปีขึ้นไป
ใครดูแล Giraffe เก็บข้อมูลนานเท่าไร และวิธีขอสำเนาหรือขอให้ลบ อ่านได้ที่: https://giraffes.test/privacy
กดปุ่มด้านล่างเพื่อยอมรับค่ะ`);
  });

  test.each(["en", "th"] as const)("in %s it names no forget command before one exists, and the button and text agree on age 20", (lang) => {
    const t = NOTICES[lang];
    const text = t.privacy(NOTICE_URL);
    for (const absent of ["forget", "ลืม", "18"]) expect(text + t.consentButton).not.toContain(absent);
    expect(t.consentButton).toContain("20+");
    expect(text).toContain("20");
  });

  test.each(["en", "th"] as const)("in %s it fits one LINE and one Telegram message, and the button fits LINE's quick reply label", (lang) => {
    const t = NOTICES[lang];
    const text = t.privacy("https://giraffes.example-workers-subdomain.workers.dev/privacy");
    expect(text.length).toBeLessThanOrEqual(Math.min(LINE_TEXT_MAX, SEND_MESSAGE_MAX_CHARS));
    expect(t.consentButton.length).toBeLessThanOrEqual(LINE_QUICK_REPLY_LABEL_MAX);
  });
});

test("a consent button from an older consent message is not consent to this one", () => {
  expect(choiceToken({ kind: "consent" })).toBe("c2");
  expect(parseChoice("c2")).toEqual({ kind: "consent" });
  expect(parseChoice("c")).toBeNull();
});

describe("the privacy notice page", () => {
  test("the link in the consent message serves the notice in both languages, naming the operator and contact", async () => {
    const link = /https:\/\/\S+/.exec(NOTICES.en.privacy(loadConfig(env as Env).privacy.url))?.[0];
    expect(link).toBe(NOTICE_URL);
    const res = await worker.fetch(new Request(link!), env as Env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const page = await res.text();
    for (const shown of ["Giraffe privacy notice", "ประกาศความเป็นส่วนตัวของ Giraffe", PRIVACY_VARS.PRIVACY_CONTROLLER, PRIVACY_VARS.PRIVACY_CONTACT]) {
      expect(page).toContain(shown);
    }
  });

  test("states the retention periods the store enforces", () => {
    expect(RETENTION_DAYS).toEqual({ sentCopies: 30, handledIncoming: 14, unusedBox: 2, boxAfterPlanEnds: 14 });
    const page = privacyPage({ controller: PRIVACY_VARS.PRIVACY_CONTROLLER, contact: PRIVACY_VARS.PRIVACY_CONTACT });
    expect(page).toContain(`Copies of messages Giraffe sent you: removed at the first cleanup after ${RETENTION_DAYS.sentCopies} days.`);
    expect(page).toContain(`ข้อความขาเข้า หลังจาก Giraffe จัดการแล้ว: ลบในการล้างข้อมูลครั้งแรกหลัง ${RETENTION_DAYS.handledIncoming} วัน`);
  });

  test("escapes the operator's name and contact", () => {
    const page = privacyPage({ controller: `<script>alert("x")</script> & Co`, contact: "a'b@example.test" });
    expect(page).not.toContain("<script>");
    expect(page).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co");
    expect(page).toContain("a&#39;b@example.test");
  });
});

describe("privacy configuration", () => {
  const live = (vars: Record<string, string>) => ({ KEY_SECRET: TEST_KEY_SECRET, PUBLIC_URL: "https://giraffes.test/", ...vars }) as unknown as Env;

  test("a live deploy needs the operator's name and contact, and links to PUBLIC_URL/privacy", () => {
    expect(() => loadConfig(live({ PRIVACY_CONTACT: PRIVACY_VARS.PRIVACY_CONTACT }))).toThrow("PRIVACY_CONTROLLER");
    expect(() => loadConfig(live({ PRIVACY_CONTROLLER: PRIVACY_VARS.PRIVACY_CONTROLLER }))).toThrow("PRIVACY_CONTACT");
    expect(loadConfig(live(PRIVACY_VARS)).privacy).toEqual({ url: NOTICE_URL, controller: PRIVACY_VARS.PRIVACY_CONTROLLER, contact: PRIVACY_VARS.PRIVACY_CONTACT });
  });

  test("a dev run without them shows a placeholder operator that can't be mistaken for a real one", () => {
    expect(loadConfig({ MODEL_BACKEND: "scripted", DEV_MODE: "1" } as unknown as Env).privacy).toEqual({
      url: "http://localhost:8787/privacy",
      controller: "Giraffe development build (not a real service)",
      contact: "privacy@example.invalid",
    });
  });
});
