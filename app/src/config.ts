import type { Agent } from "./agent/agent";
import { ADMISSION_MODES, type AdmissionMode } from "./agent/admission";
import type { PlanRules } from "./billing/plan";
import type { AgentKey, Identity, MicroUsd } from "./domain";

export interface Env {
  AGENT: DurableObjectNamespace<Agent>;
  LEDGER: D1Database;

  MODEL_BACKEND?: string;
  ANTHROPIC_API_KEY?: string;
  MODEL_BRIDGE_URL?: string;

  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;

  DEV_MODE?: string;
  OPERATOR_CHAT?: string;

  BOX_HOST?: string;
  BOX_SECRET?: string;
  BOX_APP_PREFIX?: string;
  BOX_IMAGE?: string;
  BOX_REGION?: string;
  BOX_VOLUME_GB?: string;
  MAX_BOXES?: string;
  BOX_STATIC_URL?: string;
  BOX_STATIC_OWNER?: string;
  FLY_API_TOKEN?: string;
  FLY_ORG?: string;

  ADMISSION?: string;
  BILLING?: string;
  TRIAL_DAYS?: string;
  PLUS_SEATS?: string;
  PLUS_MAX_SEATS?: string;
  AI_CAP_USD?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_STANDARD?: string;
  STRIPE_PRICE_PLUS?: string;
  STRIPE_PRICE_SEAT?: string;
  STRIPE_PRICE_AI?: string;
  STRIPE_PORTAL_CONFIGURATION?: string;
  PUBLIC_URL?: string;
}

type BoxCommon = { readonly secret: string; readonly appPrefix: string; readonly maxBoxes: number };

export type BoxConfig =
  | { readonly host: "none" }
  | (BoxCommon & {
      readonly host: "fly";
      readonly fly: { readonly apiToken: string; readonly org: string; readonly image: string; readonly region: string; readonly volumeGb: number };
    })
  | (BoxCommon & { readonly host: "static"; readonly staticUrl: string; readonly owner: AgentKey | null });

export type StripeConfig = {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly prices: { readonly standard: string; readonly plus: string; readonly seat: string; readonly ai: string };
  readonly portalConfiguration: string;
  readonly publicUrl: string;
};

export type BillingConfig =
  | { readonly on: false; readonly rules: PlanRules }
  | { readonly on: true; readonly rules: PlanRules; readonly stripe: StripeConfig };

export type Config = {
  readonly devMode: boolean;
  readonly model:
    | { readonly backend: "anthropic"; readonly apiKey: string }
    | { readonly backend: "bridge"; readonly bridgeUrl: string }
    | { readonly backend: "scripted" };
  readonly line: { readonly channelSecret: string; readonly accessToken: string } | null;
  readonly telegram: { readonly botToken: string; readonly webhookSecret: string } | null;
  /** Where operator alerts go; null logs them instead. */
  readonly operatorChat: OperatorChat | null;
  readonly box: BoxConfig;
  readonly billing: BillingConfig;
  /** Who may use the agent. Each mode has one way to redeem a code, so the beta's invites and billing's seats never mix. */
  readonly admission: AdmissionMode;
};

const present = (v: string | undefined): v is string => v !== undefined && v !== "";

function pair<T>(name: string, a: string | undefined, b: string | undefined, make: (a: string, b: string) => T): T | null {
  if (present(a) && present(b)) return make(a, b);
  if (!present(a) && !present(b)) return null;
  throw new Error(`${name}: set both secrets or neither`);
}

function modelConfig(env: Env, devMode: boolean): Config["model"] {
  const backend = env.MODEL_BACKEND ?? "anthropic";
  switch (backend) {
    case "anthropic":
      if (!present(env.ANTHROPIC_API_KEY)) throw new Error("MODEL_BACKEND=anthropic needs ANTHROPIC_API_KEY");
      return { backend, apiKey: env.ANTHROPIC_API_KEY };
    case "bridge":
      if (!devMode) throw new Error("MODEL_BACKEND=bridge needs DEV_MODE=1");
      if (!present(env.MODEL_BRIDGE_URL)) throw new Error("MODEL_BACKEND=bridge needs MODEL_BRIDGE_URL");
      return { backend, bridgeUrl: env.MODEL_BRIDGE_URL.replace(/\/+$/, "") };
    case "scripted":
      if (!devMode) throw new Error("MODEL_BACKEND=scripted needs DEV_MODE=1");
      return { backend };
    default:
      throw new Error(`unknown MODEL_BACKEND: ${backend}`);
  }
}

const BOX_DEFAULTS = { appPrefix: "gbox-", region: "sin", volumeGb: 5, maxBoxes: 10 } as const;
const MIN_SECRET_CHARS = 16;

function required(env: Env, name: keyof Env, why: string): string {
  const v = env[name];
  if (typeof v !== "string" || v === "") throw new Error(`${why} needs ${name}`);
  return v;
}

function count(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!present(raw)) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

function boxCommon(env: Env, why: string): BoxCommon {
  const secret = required(env, "BOX_SECRET", why);
  if (secret.length < MIN_SECRET_CHARS) throw new Error(`BOX_SECRET must be at least ${MIN_SECRET_CHARS} characters`);
  const appPrefix = present(env.BOX_APP_PREFIX) ? env.BOX_APP_PREFIX : BOX_DEFAULTS.appPrefix;
  if (!/^[a-z][a-z0-9-]{0,29}$/.test(appPrefix)) throw new Error("BOX_APP_PREFIX must be lowercase letters, digits and dashes, starting with a letter");
  return { secret, appPrefix, maxBoxes: count("MAX_BOXES", env.MAX_BOXES, BOX_DEFAULTS.maxBoxes, 0, 100_000) };
}

function boxConfig(env: Env, devMode: boolean): BoxConfig {
  const host = present(env.BOX_HOST) ? env.BOX_HOST : "none";
  switch (host) {
    case "none":
      return { host };
    case "fly": {
      const why = "BOX_HOST=fly";
      const region = present(env.BOX_REGION) ? env.BOX_REGION : BOX_DEFAULTS.region;
      if (!/^[a-z]{3}$/.test(region)) throw new Error("BOX_REGION must be a three-letter Fly region");
      return {
        host,
        ...boxCommon(env, why),
        fly: {
          apiToken: required(env, "FLY_API_TOKEN", why),
          org: required(env, "FLY_ORG", why),
          image: required(env, "BOX_IMAGE", why),
          region,
          volumeGb: count("BOX_VOLUME_GB", env.BOX_VOLUME_GB, BOX_DEFAULTS.volumeGb, 1, 500),
        },
      };
    }
    case "static": {
      const why = "BOX_HOST=static";
      const owner = present(env.BOX_STATIC_OWNER) ? env.BOX_STATIC_OWNER : null;
      if (owner === null && !devMode) throw new Error("BOX_HOST=static shares one Claude login, so it needs DEV_MODE=1 or BOX_STATIC_OWNER");
      if (owner !== null && !/^p:[a-z]+:\S+$/.test(owner)) throw new Error("BOX_STATIC_OWNER must be an agent key, such as p:telegram:12345");
      return {
        host,
        ...boxCommon(env, why),
        staticUrl: httpUrl("BOX_STATIC_URL", required(env, "BOX_STATIC_URL", why)),
        owner: owner as AgentKey | null,
      };
    }
    default:
      throw new Error(`unknown BOX_HOST: ${host}`);
  }
}

const PLAN_DEFAULTS = { trialDays: 14, plusSeats: 3, plusMaxSeats: 6, aiCapUsd: 1 } as const;

function httpUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an http or https URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must be an http or https URL`);
  return raw.replace(/\/+$/, "");
}

function planRules(env: Env): PlanRules {
  const plusSeats = count("PLUS_SEATS", env.PLUS_SEATS, PLAN_DEFAULTS.plusSeats, 1, 50);
  const plusMaxSeats = count("PLUS_MAX_SEATS", env.PLUS_MAX_SEATS, PLAN_DEFAULTS.plusMaxSeats, plusSeats, 50);
  const usd = present(env.AI_CAP_USD) ? Number(env.AI_CAP_USD) : PLAN_DEFAULTS.aiCapUsd;
  if (!Number.isFinite(usd) || usd < 0 || usd > 1000) throw new Error("AI_CAP_USD must be a number of dollars from 0 to 1000");
  return {
    trialDays: count("TRIAL_DAYS", env.TRIAL_DAYS, PLAN_DEFAULTS.trialDays, 0, 365),
    plusSeats,
    plusMaxSeats,
    aiCapMicro: Math.round(usd * 1_000_000) as MicroUsd,
  };
}

function billingConfig(env: Env): BillingConfig {
  const rules = planRules(env);
  const mode = present(env.BILLING) ? env.BILLING : "off";
  switch (mode) {
    case "off":
      return { on: false, rules };
    case "on": {
      const why = "BILLING=on";
      return {
        on: true,
        rules,
        stripe: {
          secretKey: required(env, "STRIPE_SECRET_KEY", why),
          webhookSecret: required(env, "STRIPE_WEBHOOK_SECRET", why),
          prices: {
            standard: required(env, "STRIPE_PRICE_STANDARD", why),
            plus: required(env, "STRIPE_PRICE_PLUS", why),
            seat: required(env, "STRIPE_PRICE_SEAT", why),
            ai: required(env, "STRIPE_PRICE_AI", why),
          },
          portalConfiguration: required(env, "STRIPE_PORTAL_CONFIGURATION", why),
          publicUrl: httpUrl("PUBLIC_URL", required(env, "PUBLIC_URL", why)),
        },
      };
    }
    default:
      throw new Error(`unknown BILLING: ${mode}`);
  }
}

const OPERATOR_CHAT = /^(?:telegram:(-?\d{1,20})|line:(U[0-9a-f]{32}))$/;

export type OperatorChat = Identity & { readonly channel: "line" | "telegram" };

function operatorChat(raw: string | undefined, configured: Readonly<Record<OperatorChat["channel"], boolean>>): OperatorChat | null {
  if (!present(raw)) return null;
  const m = OPERATOR_CHAT.exec(raw);
  if (!m) throw new Error("OPERATOR_CHAT must be telegram:<chat id> or line:<user id>");
  const chat: OperatorChat = m[1] !== undefined ? { channel: "telegram", channelUserId: m[1] } : { channel: "line", channelUserId: m[2] };
  if (!configured[chat.channel]) throw new Error(`OPERATOR_CHAT is on ${chat.channel}, which isn't configured`);
  return chat;
}

/** Defaults to beta, so a deploy that forgets it stays closed. */
function admissionMode(raw: string | undefined, billing: BillingConfig): AdmissionMode {
  const mode = present(raw) ? raw : "beta";
  if (!ADMISSION_MODES.some((m) => m === mode)) throw new Error(`unknown ADMISSION: ${mode}`);
  if (mode === "beta" && billing.on) throw new Error("ADMISSION=beta can't run with BILLING=on; set ADMISSION=open to sell plans");
  return mode as AdmissionMode;
}

export function loadConfig(env: Env): Config {
  const devMode = env.DEV_MODE === "1";
  const billing = billingConfig(env);
  const line = pair("LINE", env.LINE_CHANNEL_SECRET, env.LINE_CHANNEL_ACCESS_TOKEN, (channelSecret, accessToken) => ({ channelSecret, accessToken }));
  const telegram = pair("Telegram", env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET, (botToken, webhookSecret) => ({ botToken, webhookSecret }));
  return {
    devMode,
    model: modelConfig(env, devMode),
    line,
    telegram,
    operatorChat: operatorChat(env.OPERATOR_CHAT, { line: line !== null, telegram: telegram !== null }),
    box: boxConfig(env, devMode),
    billing,
    admission: admissionMode(env.ADMISSION, billing),
  };
}
