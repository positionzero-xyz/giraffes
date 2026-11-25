import { describe, expect, test } from "vitest";
import { chat, devChat, fakeBox, scripted } from "./testkit";

/** The model eval in box/bench/model-eval builds its box turns from this capture; `vitest -u` refreshes it after a prompt change. */
describe("the first box turn a LINE person sends, as the model eval replays it", () => {
  test("matches the captured request", async () => {
    const box = fakeBox({ signedIn: true });
    const c = await devChat("eval", { model: scripted([]), at: "2026-11-26T10:00", box: box.deps, channel: "line" });
    await c.say("/claude");
    box.replies.push({ kind: "reply", step: chat("ได้เลย") });
    const message = "อีก 20 นาทีเตือนให้ไปปิดเตาแก๊สด้วยนะ";
    await c.say(message);
    expect(box.agentBodies).toHaveLength(1);
    const capture = { channel: "line", now: "2026-11-26T10:00", message, request: box.agentBodies[0] };
    await expect(`${JSON.stringify(capture, null, 2)}\n`).toMatchFileSnapshot("./fixtures/box-first-turn-line.json");
  });
});
