import type { Agent } from "./agent/agent";

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
}

export type Config = {
  readonly devMode: boolean;
  readonly model:
    | { readonly backend: "anthropic"; readonly apiKey: string }
    | { readonly backend: "bridge"; readonly bridgeUrl: string }
    | { readonly backend: "scripted" };
  readonly line: { readonly channelSecret: string; readonly accessToken: string } | null;
  readonly telegram: { readonly botToken: string; readonly webhookSecret: string } | null;
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

export function loadConfig(env: Env): Config {
  const devMode = env.DEV_MODE === "1";
  return {
    devMode,
    model: modelConfig(env, devMode),
    line: pair("LINE", env.LINE_CHANNEL_SECRET, env.LINE_CHANNEL_ACCESS_TOKEN, (channelSecret, accessToken) => ({ channelSecret, accessToken })),
    telegram: pair("Telegram", env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET, (botToken, webhookSecret) => ({ botToken, webhookSecret })),
  };
}
