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

/**
 * Throws on contradictory config (bridge or scripted without DEV_MODE, anthropic without a key),
 * so a misconfigured deploy fails on its first request instead of mid-conversation.
 */
export function loadConfig(env: Env): Config {
  throw new Error("not implemented");
}
