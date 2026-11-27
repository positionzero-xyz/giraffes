import { describe, expect, test } from "vitest";
import { devChat, fakeBox, scripted } from "./testkit";

async function planOnly(user: string) {
  const box = fakeBox({ signedIn: true });
  const c = await devChat(user, { model: scripted([]), at: "2099-11-04T08:00", box: box.deps });
  await c.say("/claude");
  await c.received();
  return { box, c };
}

const turns = (c: Awaited<ReturnType<typeof planOnly>>["c"]) => c.logs("turn").map((r) => [r.eventKind, r.outcome]);

describe("a check-in on a plan-only person's box that fails every time", () => {
  test("an unreachable box sends nothing, not an apology for a message the person never sent", async () => {
    const { box, c } = await planOnly("down");
    box.replies.push(...Array.from({ length: 10 }, () => ({ kind: "status" as const, status: 503 })));

    await c.advanceTo("2099-11-04T09:30");

    expect(await c.received()).toEqual([]);
    expect(turns(c)).toEqual([
      ["message", "no_model"],
      ["checkin", "model_failed"],
    ]);
    box.replies.length = 0;
  });

  test("a signed-out box sends the sign-in notice once, and the next morning's check-in stays quiet", async () => {
    const { box, c } = await planOnly("gone");
    box.signedIn = false;
    box.replies.push(...Array.from({ length: 10 }, () => ({ kind: "signed_out" as const })));

    await c.advanceTo("2099-11-04T09:30");
    const first = await c.received();
    await c.advanceTo("2099-11-05T09:30");

    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/^Your Claude plan is signed out.*Once you sign in, I'll answer requests from the last 24 hours\./s);
    expect(await c.received()).toEqual([]);
    expect(turns(c)).toEqual([
      ["message", "no_model"],
      ["checkin", "no_access"],
      ["checkin", "no_access"],
    ]);
    expect(box.replies).toHaveLength(9);
    box.replies.length = 0;
  // This drive walks check-in alarms across two mornings while the box keeps failing.
  }, 10_000);
});
