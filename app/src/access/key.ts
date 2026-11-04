import type { AgentKey, EpochMs, MicroUsd } from "../domain";
import { SecretKey, type Endpoint, type KeyFault, type SchemaMode } from "../model/client";
import { PROVIDERS, type Auth, type ProviderId } from "../model/providers";

export type Sealed = { readonly kid: string; readonly iv: Uint8Array; readonly ciphertext: Uint8Array };
/** `previous` is set only while KEY_SECRET is being rotated. */
export type KeySecrets = { readonly current: string; readonly previous: string | null };

export type KeyHealth =
  | { readonly kind: "ok" }
  | { readonly kind: "resting"; readonly fault: KeyFault; readonly until: EpochMs | null; readonly failures: number; readonly toldAt: EpochMs | null };

/** What the DO holds about a person's own key, still sealed. */
export type StoredKey = {
  readonly provider: ProviderId;
  /** The preset's, or the person's for a custom provider. */
  readonly baseUrl: string;
  /** The provider's own model id. */
  readonly model: string;
  readonly auth: Auth;
  /** Decided by the connect probe. */
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

/** Names a secret without revealing it, so a row says which secret sealed it. */
export const kidOf = async (secret: string): Promise<string> => hex(await digest(`kid:${secret}`)).slice(0, 12);

async function aesKey(secret: string, agent: AgentKey): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", utf8.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: SALT, info: utf8.encode(agent) }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Binds the key to where it may be sent, so a row edited to point at another host fails to open. */
const aad = (provider: ProviderId, baseUrl: string) => utf8.encode(`${provider}\n${baseUrl}`);

/** AES-256-GCM under a key derived from the secret and this person's agent key, so a row copied into another DO fails to open. */
export async function seal(secret: string, agent: AgentKey, draft: Pick<KeyDraft, "provider" | "baseUrl" | "key">): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(draft.provider, draft.baseUrl) },
    await aesKey(secret, agent),
    utf8.encode(draft.key.reveal()),
  );
  return { kid: await kidOf(secret), iv, ciphertext: new Uint8Array(ciphertext) };
}

async function tryOpen(secret: string, agent: AgentKey, k: Pick<StoredKey, "provider" | "baseUrl" | "sealed">): Promise<SecretKey | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: k.sealed.iv, additionalData: aad(k.provider, k.baseUrl) },
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
