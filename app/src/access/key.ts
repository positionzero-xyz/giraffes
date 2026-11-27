import type { AgentKey, EpochMs, LocalDate, MicroUsd } from "../domain";
import { SecretKey, type Endpoint, type KeyFault, type SchemaMode } from "../model/client";
import { defaultModelOf, isProviderId, PROVIDERS, type Auth, type ProviderId } from "../model/providers";
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
  const model = f.model.trim() || defaultModelOf(p) || "";
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

// These formats can be recognized inside URLs and across punctuation, before the token heuristics run.
const KNOWN_FORMAT = new RegExp(
  [
    String.raw`-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----`,
    String.raw`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.(?:[A-Za-z0-9_-]*\.(?:[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)`,
    String.raw`(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@?#]+:)[^\s/?#]+(?=@)`,
    String.raw`(?<![A-Za-z0-9_-])(?:xox[abposre]|xapp)-[A-Za-z0-9-]{10,}`,
    String.raw`(?<![A-Za-z0-9_-])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9_-])`,
    String.raw`(?<![A-Za-z0-9_-])(?:sk-ant-|sk-or-|oc_sk_|sk-|sk_live_|sk_test_|rk_live_|rk_test_|gh[pousr]_|github_pat_|glpat-|gsk_|hf_|xai-|AIza)[A-Za-z0-9_-]{16,}`,
  ].join("|"),
  "g",
);
const AWS_SECRET = /(?<=\baws[_ ]secret(?:[_ ]access[_ ]key)?[ \t]*[:=][ \t]*)[A-Za-z0-9/+=]{40,}/gi;
/** Not after a slash, dot or @, so a link's path, a host name or an address is left alone; after = or : it counts. */
const LONG_TOKEN = /(?<![A-Za-z0-9_\-/.@])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-]|[/=:@.][A-Za-z0-9_-])/g;
/** Apple and Google app passwords are sixteen lowercase letters shown as four groups of four. */
const GROUPED_APP_PASSWORD = /(?<![A-Za-z0-9_-])[a-z]{4}(?:[- ][a-z]{4}){3}(?![A-Za-z0-9_-])/g;
/** Shorter than LONG_TOKEN, so context has to name it as a secret before it is removed. */
const CONTEXT_TOKEN = /(?<![A-Za-z0-9_\-/.@])[A-Za-z0-9][A-Za-z0-9_-]{11,30}(?![A-Za-z0-9_-]|[/=:@.][A-Za-z0-9_-])/g;
/** Thai has no word breaks, so its hints go without `\b`; a bare รหัส (code) counts only on its own, not in รหัสพัสดุ (tracking code). */
const HINT = String.raw`\b(?:app[- ]password|password|passcode|passwd|pwd|pw|api[- ]key|token|secret)\b|รหัสผ่าน|พาสเวิร์ด|รหัส(?=[\s:=]|คือ|$)`;
const HINT_GLOBAL = new RegExp(HINT, "gi");
/** Punctuation labels override the ordinary-word exemption for candidates from the token patterns. */
const LABEL_GAP = /^\s*(?:[^\s:=]{1,16}\s*)?[:=]\s*$/;
/** `password is x`, `password for gmail is x`, `รหัสผ่านคือ x`. */
const SAID_GAP = /^\s*(?:(?:\S+\s+){0,3})(?:is|was|คือ|เป็น)\s*$/i;
/** `Mistral-Small-2603`, `deepseek-v4-1-flash-1017`, `Llama-4-Maverick-17B`: words and versions joined by dashes name a model. */
const PRODUCT_PART = String.raw`(?:[A-Z][A-Za-z0-9]*|[a-z]+|\d+[A-Za-z]{0,2}|v\d+(?:\.\d+)?)`;
const PRODUCT_NAME = new RegExp(String.raw`^(?:${PRODUCT_PART})(?:-(?:${PRODUCT_PART}))+$`);

const PASSWORD_WORD = String.raw`(?<![A-Za-z0-9])(?:app[- _])?(?:password|passcode|passwd|pwd|pw|pass)\b|รหัสผ่าน(?:แอป)?|พาสเวิร์ด|รหัส(?:แอป)?(?=[\s:=]|คือ|เป็น)`;
const LABELLED_VALUE = new RegExp(
  String.raw`((?:${PASSWORD_WORD})(?:[ \t]+for[ \t]+[^\s:=]+)?["']?[ \t]*` +
    String.raw`([:=][ \t\r\n]{0,31}|\b(?:is|was)[ \t]+|(?:คือ|เป็น)[ \t]*)` +
    String.raw`(?:(?:copy|paste|enter|type|please|plse):?[ \t]+)?)((?:${KEY_REMOVED}|\S)+)`,
  "gi",
);
const PASSWORD_ADVICE = /^(?:use|choose|avoid|must|should|can|could)[ \t]|^(?:at[ \t]+least|do[ \t]+not)\b/i;
const GROUPED_VALUE_START = /^[a-z]{4}(?:[- \t\u00a0]+[a-z]{4}){3}(?![A-Za-z0-9_-])/;
const REVERSE_TOKEN = /(?<![A-Za-z0-9_\-/.@])[a-z]{16}(?=["'”’)\]}>]?[ \t]+(?:is|was)[ \t]+(?:(?:my|the|your)[ \t]+)?(?:access[ -]token|api[ -]key|token|app[ -]password)\b)/gi;
const VALUE_WRAPPERS = new Map([
  ["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"], ['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"], ["`", "`"],
]);

function labelledValue(before: string, separator: string, raw: string, after: string): string | null {
  if (raw === KEY_REMOVED) return null;
  const closing = VALUE_WRAPPERS.get(raw[0]);
  const wrapperEnd = closing === undefined ? -1 : raw.indexOf(closing, 1);
  const wrapped = wrapperEnd > 1 && /^[.,!?;:)\]}>]*$/.test(raw.slice(wrapperEnd + 1));
  const value = wrapped ? raw.slice(1, wrapperEnd) : raw;
  if (value === KEY_REMOVED || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;

  const explicit = separator.startsWith(":") || separator.startsWith("=");
  const onLine = after.split(/[\r\n]/, 1)[0];
  if (explicit && PASSWORD_ADVICE.test(raw + onLine)) return null;
  // Leave a space-grouped app password for the existing four-group matcher.
  const grouped = GROUPED_VALUE_START.exec(raw + onLine)?.[0];
  if (grouped !== undefined && /[ \t\u00a0]/.test(grouped)) return null;

  // A copula can introduce ordinary prose. Require a credential-shaped value in that case.
  if (!explicit) {
    const endsStatement = onLine.trim() === "";
    const candidate = endsStatement ? value : value.replace(/[.,;:!?]+$/, "");
    const strong = /[^\p{L}\p{M}\p{N}_'.-]/u.test(candidate) || (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate) && /\d/.test(candidate));
    if (!wrapped && !strong && !(endsStatement && (mixed(candidate) || /^\d+$/.test(candidate)))) return null;
  }
  return wrapped ? before + raw[0] + KEY_REMOVED + raw.slice(wrapperEnd) : before + KEY_REMOVED;
}

/* About 660 words, so a group of a random app password is one by chance about 1 time in 700; two groups that are words means prose. */
const COMMON_FOUR_LETTER_WORDS = new Set(
  (
    "able acid aged also area army asap aunt away baby back bags baht bake ball band bank bare bark base bath bead beam bean bear beat beds beef been beer bell " +
    "belt bend best bike bill bird bite blue boat body boil bold bolt bomb bond bone book boom boot born boss both bowl buns burn bush busy buzz cafe cage cake " +
    "call calm came camp cans cant card care cart case cash cast cats chat chef chip city clay club coal coat code coin cold come cook cool cope copy cord core " +
    "corn cost cozy crab crew crop cube cups cure cute dark data date dawn days dead deal dear debt deck deep deer desk diet dirt dish dock docs does dogs doll " +
    "done dont door dose down draw drew drop drum duck dull dust duty each earn ease east easy eats edge edit eggs else even ever exam exit face fact fail fair fall " +
    "fame farm fast fate fear feed feel fees feet fell felt figs file fill film find fine fire firm fish fist five flag flat flew flip flow foil folk fond food " +
    "fool foot fork form fort four free frog from fuel full fund gain game gang gate gave gear gift girl give glad glue goal goat goes gold golf gone good grab " +
    "gray grew grey grid grow gulf haha hair half hall hand hang hard harm hate have head heal heap hear heat hehe held hell help herb here hero hide high hike " +
    "hill hint hire hold hole holy home hood hook hope horn hose host hour huge hung hunt hurt idea inch into iron isnt item jack jail jams jars jazz jeep jobs " +
    "join joke july jump june jury just kale keen keep kept keys kick kids kill kind king kiss kite knee knew knit know lack lady laid lake lamb lamp land lane " +
    "last late lawn lazy lead leaf lean left lend lens less lets life lift like lime line link lion list live lmao load loan lock logo long look loop lord lose " +
    "loss lost lots loud love luck lump lung made mail main make male mall many mark mask mass math meal mean meat meet melt memo menu mess mild mile milk mind mine " +
    "mint miss mode mood moon mops more most move much mugs must nail name navy near neat neck need nest news next nice nine none noon nope nose note nuts oats " +
    "okay once only onto open oven over pace pack page paid pain pair palm pans park part pass past path pays peak pear peel pens pick pics pile pill pink pipe " +
    "plan play plot plug plum plus poem poet pole poll pond pool poor pork port pose post pots pour pray pull pump pure push quit race rack rail rain rank rare " +
    "rate read real rear rely rent rest rice rich ride ring rise risk road rock role roll roof room root rope rose rude rule rush safe sage said sail sake sale " +
    "salt same sand save seat seed seek seem seen self sell send sent ship shoe shop shot show shut sick side sign silk sing sink site size skin skip slip slow " +
    "snow soap sock soda sofa soft soil sold sole some song soon sort soup spot star stay step stop such suit sure swim tail take tale talk tall tank tape task " +
    "taxi team tear tell tend tent term test text than thai that them then they thin this tide tidy tile till time tins tiny tips tire tmrw tofu told toll tone " +
    "took tool tour town toys tree trip true tube tuna turn twin type ugly unit upon used user vast very vibe view vote wage wait wake walk wall want warm wash " +
    "wave ways weak wear weds week well went were west what when whom wide wife wifi wild will wind wine wing wipe wire wise wish with wolf wont wood wool word wore " +
    "work yard yeah year yoga your zero zone zoom"
  ).split(" "),
);

function entropyBits(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** Mixed case and digits with some entropy, or 48 or more lowercase hex characters (a Git SHA is 40). */
const keyLike = (t: string) => (/[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && entropyBits(t) >= 3.5) || /^[0-9a-f]{48,}$/.test(t);

/** The text between the end of the last hint and the token; the 32-character allowance is measured here. */
function hintGapBefore(text: string, offset: number): string | undefined {
  const before = text.slice(0, offset);
  HINT_GLOBAL.lastIndex = 0;
  let end = -1;
  for (let m = HINT_GLOBAL.exec(before); m !== null; m = HINT_GLOBAL.exec(before)) end = m.index + m[0].length;
  return end === -1 ? undefined : before.slice(end);
}

/** The text between the end of the token and the start of the first following hint. */
function hintGapAfter(text: string, end: number): string | undefined {
  const after = text.slice(end, end + 96);
  HINT_GLOBAL.lastIndex = 0;
  const m = HINT_GLOBAL.exec(after);
  return m === null ? undefined : after.slice(0, m.index);
}

function punctuationLabelBefore(text: string, offset: number): boolean {
  const gap = hintGapBefore(text, offset);
  return gap !== undefined && gap.length <= 32 && LABEL_GAP.test(gap);
}

function explicitLabelBefore(text: string, offset: number): boolean {
  const gap = hintGapBefore(text, offset);
  return gap !== undefined && gap.length <= 32 && (LABEL_GAP.test(gap) || SAID_GAP.test(gap));
}

const hintNearBefore = (text: string, offset: number) => (hintGapBefore(text, offset)?.length ?? 33) <= 32;
const hintNearAfter = (text: string, end: number) => (hintGapAfter(text, end)?.length ?? 33) <= 32;

/** Without a label, two ordinary words read as prose; a label always wins over that exemption. */
function groupedAppPassword(match: string, offset: number, text: string): string | null {
  if (explicitLabelBefore(text, offset)) return KEY_REMOVED;
  const words = match.split(/[- ]/).filter((w) => COMMON_FOUR_LETTER_WORDS.has(w)).length;
  if (words >= 2) return null;
  const end = offset + match.length;
  if (hintNearBefore(text, offset) || hintNearAfter(text, end) || !match.includes(" ")) return KEY_REMOVED;
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const nextLine = text.indexOf("\n", end);
  const lineEnd = nextLine === -1 ? text.length : nextLine;
  const isolated = text.slice(lineStart, offset).trim() === "" && /^[\s.!?]*$/.test(text.slice(end, lineEnd));
  return isolated ? KEY_REMOVED : null;
}

/** Letters with digits, or a capital inside lower case: what a generated password has and a word doesn't. */
const mixed = (t: string) => (/[A-Za-z]/.test(t) && /\d/.test(t)) || /[a-z][A-Z]/.test(t);

/**
 * A mixed token with some entropy, scaled down for short ones, goes when a hint is near it on either side. A product
 * name stays intact unless a punctuation label (`password: x`) explicitly calls the token a secret.
 */
function shortSecret(match: string, offset: number, text: string): string | null {
  if (punctuationLabelBefore(text, offset)) return KEY_REMOVED;
  if (PRODUCT_NAME.test(match)) return null;
  if (match.length >= 18 && keyLike(match)) return KEY_REMOVED;
  if (!/[A-Za-z]/.test(match)) return null;
  const bits = entropyBits(match);
  const mixedEnough = mixed(match) && bits >= Math.min(3.5, Math.log2(match.length) - 0.6);
  const end = offset + match.length;
  return mixedEnough && (hintNearBefore(text, offset) || hintNearAfter(text, end)) ? KEY_REMOVED : null;
}

function longSecret(match: string, offset: number, text: string): string | null {
  if (punctuationLabelBefore(text, offset)) return KEY_REMOVED;
  return keyLike(match) && !PRODUCT_NAME.test(match) ? KEY_REMOVED : null;
}

/**
 * Pure. Removes anything that looks like an API key or app password: a known key prefix anywhere, links and query strings
 * included, or a token that looks random, unless it sits in a link's path or a host name, where it is usually an id.
 */
export function redactSecrets(text: string): { readonly text: string; readonly found: boolean } {
  let found = false;
  const secret = (replacement: string | null, original: string) => (replacement === null ? original : ((found = true), replacement));
  const out = text
    .replace(KNOWN_FORMAT, (m) => secret(KEY_REMOVED, m))
    .replace(AWS_SECRET, (m) => secret(KEY_REMOVED, m))
    .replace(LABELLED_VALUE, (m, before: string, separator: string, raw: string, offset: number, whole: string) =>
      secret(labelledValue(before, separator, raw, whole.slice(offset + m.length)), m),
    )
    .replace(REVERSE_TOKEN, (m) => secret(KEY_REMOVED, m))
    .replace(GROUPED_APP_PASSWORD, (m, offset, whole) => secret(groupedAppPassword(m, offset, whole), m))
    .replace(CONTEXT_TOKEN, (m, offset, whole) => secret(shortSecret(m, offset, whole), m))
    .replace(LONG_TOKEN, (m, offset, whole) => secret(longSecret(m, offset, whole), m));
  return { text: out, found };
}
