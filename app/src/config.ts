/**
 * Raw bindings in, validated config out. The only file that reads `env.*` strings.
 * Everything downstream takes `Config` and trusts it.
 */
import type { Agent } from "./agent/agent";

/** Wrangler bindings and secrets, exactly as the runtime provides them. */
export interface Env {
  AGENT: DurableObjectNamespace<Agent>;
  LEDGER: D1Database;

  MODEL_BACKEND?: string; // "anthropic" | "bridge" | "scripted"
  ANTHROPIC_API_KEY?: string;
  MODEL_BRIDGE_URL?: string;

  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;

  DEV_MODE?: string; // "1" enables /dev routes, the dev channel and the bridge backend
}

export type Config = {
  readonly devMode: boolean;
  readonly model:
    | { readonly backend: "anthropic"; readonly apiKey: string }
    | { readonly backend: "bridge"; readonly bridgeUrl: string }
    | { readonly backend: "scripted" };
  /** null when the secrets are absent: the adapter answers 404, it doesn't half-work. */
  readonly line: { readonly channelSecret: string; readonly accessToken: string } | null;
  readonly telegram: { readonly botToken: string; readonly webhookSecret: string } | null;
};

const present = (v: string | undefined): v is string => v !== undefined && v !== "";

/** Both secrets or neither; one without the other is a half-configured channel. */
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

/**
 * Throws on contradictory config (bridge or scripted without DEV_MODE, anthropic without a key),
 * so a misconfigured deploy fails on its first request instead of mid-conversation.
 */
export function loadConfig(env: Env): Config {
  const devMode = env.DEV_MODE === "1";
  return {
    devMode,
    model: modelConfig(env, devMode),
    line: pair("LINE", env.LINE_CHANNEL_SECRET, env.LINE_CHANNEL_ACCESS_TOKEN, (channelSecret, accessToken) => ({ channelSecret, accessToken })),
    telegram: pair("Telegram", env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET, (botToken, webhookSecret) => ({ botToken, webhookSecret })),
  };
}
