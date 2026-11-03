import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
const safeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

export function verifyBearer(header: string | undefined, token: string): boolean {
  return header !== undefined && safeEqual(header, `Bearer ${token}`);
}

export function verifyTicket(ticket: unknown, token: string, now: number): boolean {
  if (typeof ticket !== "string") return false;
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!m) return false;
  const [, exp, mac] = m;
  return safeEqual(mac, createHmac("sha256", token).update(`signin:${exp}`).digest("base64url")) && now < Number(exp);
}
