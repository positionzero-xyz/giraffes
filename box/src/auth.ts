import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
const safeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

export function verifyBearer(header: string | undefined, token: string): boolean {
  return header !== undefined && safeEqual(header, `Bearer ${token}`);
}

export type SigninTicket = { readonly value: string; readonly expiresAt: number };

export function readTicket(ticket: unknown, token: string, now: number): SigninTicket | null {
  if (typeof ticket !== "string") return null;
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!m) return null;
  const [, exp, mac] = m;
  const expiresAt = Number(exp);
  if (now >= expiresAt || !safeEqual(mac, createHmac("sha256", token).update(`signin:${exp}`).digest("base64url"))) return null;
  return { value: ticket, expiresAt };
}
