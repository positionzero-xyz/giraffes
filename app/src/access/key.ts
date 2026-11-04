import type { AgentKey, EpochMs, LocalDate, MicroUsd } from "../domain";
import { SecretKey, type Endpoint, type KeyFault, type SchemaMode } from "../model/client";
import { isProviderId, PROVIDERS, type Auth, type ProviderId } from "../model/providers";
import type { KeyPageError } from "../notices";

export type Sealed = { readonly kid: string; readonly iv: Uint8Array; readonly ciphertext: Uint8Array };
/** `previous` is set only while KEY_SECRET is being rotated. */
export type KeySecrets = { readonly current: string; readonly previous: string | null };

export type KeyHealth =
  | { readonly kind: "ok" }
  /**
   * `toldOn`: the person's local date of the last notice, so they hear about it at most once a day. `under`: for an
   * unreadable key, the fingerprint of the secrets configured when it failed to open, so a changed secret retries it.
   */
  | {
      readonly kind: "resting";
      readonly fault: KeyFault;
      readonly until: EpochMs | null;
      readonly failures: number;
      readonly toldOn: LocalDate | null;
      readonly under: string | null;
    };

export type StoredKey = {
  readonly provider: ProviderId;
  readonly baseUrl: string;
  readonly model: string;
  readonly auth: Auth;
  readonly mode: SchemaMode;
  readonly sealed: Sealed;
  /** The key's last 4 characters, for /key. */
  readonly hint: string;
  readonly capMicro: MicroUsd;
  /** True only when the person said yes to using the key while their own plan's box can't answer. */
  readonly backup: boolean;
  readonly backupAskedAt: EpochMs | null;
  readonly revision: number;
  readonly connectedAt: EpochMs;
  readonly health: KeyHealth;
};

/** A key the person entered, checked for shape but not yet by its provider. */
export type KeyDraft = {
  readonly provider: ProviderId;
  readonly baseUrl: string;
  readonly model: string;
  readonly auth: Auth;
  readonly key: SecretKey;
};

const utf8 = new TextEncoder();
const SALT = utf8.encode("giraffes model key v1");

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(text)));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const FINGERPRINT_LABEL = "giraffes key fingerprint";

/** Names a secret without revealing it, a short HMAC of a fixed label, so a row says which secret sealed it. */
export async function kidOf(secret: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8.encode(FINGERPRINT_LABEL)))).slice(0, 12);
}

/** The secrets this deploy holds, by fingerprint; "" with keys off. A key that failed to open is tried again once it changes. */
export async function secretsFingerprint(secrets: KeySecrets | null): Promise<string> {
  if (secrets === null) return "";
  return [await kidOf(secrets.current), ...(secrets.previous === null ? [] : [await kidOf(secrets.previous)])].join(",");
}

async function aesKey(secret: string, agent: AgentKey): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", utf8.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: SALT, info: utf8.encode(agent) }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Binds a sealed key to its provider and base URL, so a row pointed at another host fails to open. */
const sealBinding = (provider: ProviderId, baseUrl: string) => utf8.encode(`${provider}\n${baseUrl}`);

/** AES-256-GCM under a key derived from the secret and this person's agent key, so a row copied into another DO fails to open. */
export async function seal(secret: string, agent: AgentKey, draft: Pick<KeyDraft, "provider" | "baseUrl" | "key">): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: sealBinding(draft.provider, draft.baseUrl) },
    await aesKey(secret, agent),
    utf8.encode(draft.key.reveal()),
  );
  return { kid: await kidOf(secret), iv, ciphertext: new Uint8Array(ciphertext) };
}

async function tryOpen(secret: string, agent: AgentKey, k: Pick<StoredKey, "provider" | "baseUrl" | "sealed">): Promise<SecretKey | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: k.sealed.iv, additionalData: sealBinding(k.provider, k.baseUrl) },
      await aesKey(secret, agent),
      k.sealed.ciphertext,
    );
    return SecretKey.from(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

export type Opened = { readonly kind: "open"; readonly key: SecretKey } | { readonly kind: "resealed"; readonly key: SecretKey; readonly again: Sealed } | { readonly kind: "unreadable" };

/** Tries the current secret, then the previous one; a key the previous secret opened comes back resealed with the current. */
export async function open(secrets: KeySecrets, agent: AgentKey, k: Pick<StoredKey, "provider" | "baseUrl" | "sealed">): Promise<Opened> {
  const current = await tryOpen(secrets.current, agent, k);
  if (current) return { kind: "open", key: current };
  if (secrets.previous === null) return { kind: "unreadable" };
  const old = await tryOpen(secrets.previous, agent, k);
  if (!old) return { kind: "unreadable" };
  return { kind: "resealed", key: old, again: await seal(secrets.current, agent, { provider: k.provider, baseUrl: k.baseUrl, key: old }) };
}

export function endpointOf(k: Pick<StoredKey, "provider" | "baseUrl" | "auth">, key: SecretKey, session: string): Endpoint {
  const p = PROVIDERS[k.provider];
  return { provider: k.provider, protocol: p.protocol, baseUrl: k.baseUrl, auth: k.auth, key, headers: p.headers({ session }), body: p.body };
}

/** A stable, opaque id for a person's conversation, for providers that ask for one. */
export const sessionOf = async (agent: AgentKey): Promise<string> => hex(await digest(`session:${agent}`)).slice(0, 32);

/** What the key page posts, before anything is checked. */
export type KeyFields = { readonly provider: string; readonly model: string; readonly baseUrl: string; readonly key: string };

export type DraftError = Extract<KeyPageError, "unknown_provider" | "bad_url" | "no_model" | "key_shape">;

const MODEL_ID = /^[\x21-\x7e]{1,200}$/;
const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

function baseUrlOf(raw: string, allow: "public" | "dev" | "loopback"): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost") || IP_HOST.test(url.hostname);
  const https = url.protocol === "https:";
  const ok = allow === "public" ? https && !local : allow === "dev" ? https || (url.protocol === "http:" && local) : local && (https || url.protocol === "http:");
  if (!ok || url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, "");
}

/**
 * Pure. A custom base URL must be https and not a local or IP-literal host; DEV_MODE also allows a loopback http stub,
 * and lets a preset point at one, so a dev run exercises that preset's own route without calling the provider.
 */
export function draftKey(f: KeyFields, opts: { readonly devMode: boolean }): { readonly ok: true; readonly value: KeyDraft } | { readonly ok: false; readonly error: DraftError } {
  if (!isProviderId(f.provider)) return { ok: false, error: "unknown_provider" };
  const p = PROVIDERS[f.provider];
  const stub = opts.devMode && p.baseUrl !== null && f.baseUrl.trim() !== "";
  const baseUrl = stub ? baseUrlOf(f.baseUrl, "loopback") : (p.baseUrl ?? baseUrlOf(f.baseUrl, opts.devMode ? "dev" : "public"));
  if (baseUrl === null) return { ok: false, error: "bad_url" };
  const model = f.model.trim() || p.defaultModel || "";
  if (!MODEL_ID.test(model)) return { ok: false, error: "no_model" };
  const key = SecretKey.from(f.key);
  if (!key || (p.keyShape && !p.keyShape.test(key.reveal()))) return { ok: false, error: "key_shape" };
  return { ok: true, value: { provider: f.provider, baseUrl, model, auth: p.auth, key } };
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

async function ticketMac(secret: string, payload: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8.encode(`key ticket:${payload}`)));
}

/** The DO stores only this, so its rows can't be turned back into a working link. */
export const ticketHash = async (nonce: string): Promise<string> => b64url(await digest(`ticket:${nonce}`));

export type Ticket = { readonly token: string; readonly nonceHash: string; readonly expiresAt: EpochMs };

/** `<DO id>.<expiry>.<nonce>.<mac>`: the Worker checks the MAC and expiry before it wakes any DO, and the id names no chat. */
export async function issueTicket(secret: string, doId: string, expiresAt: EpochMs): Promise<Ticket> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const payload = `${doId}.${expiresAt}.${nonce}`;
  return { token: `${payload}.${b64url(await ticketMac(secret, payload))}`, nonceHash: await ticketHash(nonce), expiresAt };
}

export type ReadTicket = { readonly doId: string; readonly expiresAt: EpochMs; readonly nonceHash: string };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function readTicket(secrets: KeySecrets, token: string, now: EpochMs): Promise<ReadTicket | null> {
  const m = /^([0-9a-f]{64})\.(\d{1,15})\.([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const [, doId, exp, nonce, mac] = m;
  const payload = `${doId}.${exp}.${nonce}`;
  const given = utf8.encode(mac);
  const valid = async (s: string | null) => s !== null && sameBytes(utf8.encode(b64url(await ticketMac(s, payload))), given);
  if (!(await valid(secrets.current)) && !(await valid(secrets.previous))) return null;
  if (Number(exp) <= now) return null;
  return { doId, expiresAt: Number(exp) as EpochMs, nonceHash: await ticketHash(nonce) };
}

export const KEY_REMOVED = "<a key, removed>";

const PREFIXED = /(?<![A-Za-z0-9_-])(?:sk-ant-|sk-or-|oc_sk_|sk-)[A-Za-z0-9_-]{16,}/g;
/** Not after a slash, dot or @, so a link's path, a host name or an address is left alone; after = or : it counts. */
const LONG_TOKEN = /(?<![A-Za-z0-9_\-/.@])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_\-/=.:@])/g;

function entropyBits(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** Mixed case and digits with some entropy, or 48 or more lowercase hex characters (a Git SHA is 40). */
const keyLike = (t: string) => (/[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && entropyBits(t) >= 3.5) || /^[0-9a-f]{48,}$/.test(t);

/**
 * Pure. Removes anything that looks like an API key: a known key prefix anywhere, links and query strings included,
 * or a long token that looks random, unless it sits in a link's path or a host name, where it is usually an id.
 */
export function redactSecrets(text: string): { readonly text: string; readonly found: boolean } {
  let found = false;
  const out = text
    .replace(PREFIXED, () => ((found = true), KEY_REMOVED))
    .replace(LONG_TOKEN, (m) => (keyLike(m) ? ((found = true), KEY_REMOVED) : m));
  return { text: out, found };
}
