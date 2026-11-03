import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { verifyBearer, verifyTicket } from "../src/auth.ts";

const VECTOR = {
  secret: "test-secret-0123456789abcdef",
  name: "gbox-0123456789ab",
  token: "b-UiaAiUIgin1zs4CJbKAY68m8rphXVQwWrWHSMO2U4",
  exp: 1790000000000,
  ticket: "1790000000000.AA1PzFmYf_4obmGHsfd0634YPiMbVDnmjYWbmYI62kM",
};

describe("contract test vector", () => {
  it("derives the box token the Worker sends", () => {
    assert.equal(createHmac("sha256", VECTOR.secret).update(`box:${VECTOR.name}`).digest("base64url"), VECTOR.token);
  });

  it("accepts the vector ticket until exp and not at exp", () => {
    assert.equal(verifyTicket(VECTOR.ticket, VECTOR.token, VECTOR.exp - 1), true);
    assert.equal(verifyTicket(VECTOR.ticket, VECTOR.token, VECTOR.exp), false);
  });

  it("rejects the ticket under another token, another exp, or a changed mac", () => {
    const now = VECTOR.exp - 1000;
    assert.equal(verifyTicket(VECTOR.ticket, `${VECTOR.token}x`, now), false);
    assert.equal(verifyTicket(VECTOR.ticket.replace("1790000000000", "1790000000001"), VECTOR.token, now), false);
    assert.equal(verifyTicket(VECTOR.ticket.replace(/.$/, "l"), VECTOR.token, now), false);
    for (const bad of [undefined, 42, "", "1790000000000", ".AA1PzFmYf_4obmGHsfd0634YPiMbVDnmjYWbmYI62kM", `${VECTOR.ticket}.x`]) {
      assert.equal(verifyTicket(bad, VECTOR.token, now), false, String(bad));
    }
  });
});

describe("bearer", () => {
  it("accepts exactly `Bearer <token>`", () => {
    assert.equal(verifyBearer(`Bearer ${VECTOR.token}`, VECTOR.token), true);
    for (const bad of [undefined, "", VECTOR.token, `bearer ${VECTOR.token}`, `Bearer ${VECTOR.token} `, `Bearer ${VECTOR.token.slice(0, -1)}`]) {
      assert.equal(verifyBearer(bad, VECTOR.token), false, String(bad));
    }
  });
});
