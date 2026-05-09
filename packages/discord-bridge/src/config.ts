/**
 * Environment-driven configuration for the Discord bridge.
 *
 * Mirrors the BridgeConfig pattern from packages/bridge/src/helpers.ts —
 * a single loader that fails fast on missing required vars so misconfig
 * surfaces at startup rather than on the first DM.
 */

export type WebSocketUrl = `ws://${string}` | `wss://${string}`;

export interface DiscordBridgeConfig {
  /** Bot token from the Discord developer portal. */
  botToken: string;
  /** WebSocket URL of the upstream MUDdown game server. */
  serverUrl: WebSocketUrl;
  /** Optional guild for guild-scoped slash-command registration during development. */
  guildId: string | undefined;
}

export class DiscordBridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordBridgeConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DiscordBridgeConfig {
  const botToken = env.MUDDOWN_DISCORD_BOT_TOKEN?.trim();
  const serverUrl = env.MUDDOWN_SERVER_URL?.trim();
  const guildId = env.MUDDOWN_DISCORD_GUILD_ID?.trim() || undefined;
  if (!botToken) {
    throw new DiscordBridgeConfigError("MUDDOWN_DISCORD_BOT_TOKEN is required");
  }
  if (!serverUrl) {
    throw new DiscordBridgeConfigError("MUDDOWN_SERVER_URL is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new DiscordBridgeConfigError("MUDDOWN_SERVER_URL must be a valid ws:// or wss:// URL");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new DiscordBridgeConfigError("MUDDOWN_SERVER_URL must use ws:// or wss://");
  }
  return {
    botToken,
    serverUrl: serverUrl as WebSocketUrl,
    guildId,
  };
}
