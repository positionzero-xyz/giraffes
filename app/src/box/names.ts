import type { AgentKey, Brand, EpochMs } from "../domain";

export type BoxName = Brand<string, "BoxName">;
export type BoxToken = Brand<string, "BoxToken">;
/** Random per box setup, so a replacement under the same name has another key and an earlier link can't open it. */
export type BoxSetup = Brand<string, "BoxSetup">;
export type SigninTicket = Brand<string, "SigninTicket">;

const utf8 = new TextEncoder();

async function hmac(key: string, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", utf8.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8.encode(message)));
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function boxName(secret: string, prefix: string, agent: AgentKey): Promise<BoxName> {
  return `${prefix}${hex(await hmac(secret, `name:${agent}`)).slice(0, 16)}` as BoxName;
}

export async function boxSessionOwner(secret: string, agent: AgentKey): Promise<string> {
  return hex(await hmac(secret, `session-owner:${agent}`)).slice(0, 32);
}

export const newBoxSetup = (): BoxSetup => hex(crypto.getRandomValues(new Uint8Array(16))) as BoxSetup;

/** A null setup is a box made before setups existed, or the static box, whose key the operator installed. */
export async function boxToken(secret: string, name: BoxName, setup: BoxSetup | null): Promise<BoxToken> {
  return base64url(await hmac(secret, setup ? `box:${name}:${setup}` : `box:${name}`)) as BoxToken;
}

export async function signinTicket(token: BoxToken, exp: EpochMs): Promise<SigninTicket> {
  return `${exp}.${base64url(await hmac(token, `signin:${exp}`))}` as SigninTicket;
}

export function signinUrl(boxUrl: string, ticket: SigninTicket): string {
  return `${boxUrl}/signin#t=${ticket}`;
}
