/**
 * Environment-driven configuration for the Discord bridge.
 *
 * Mirrors the BridgeConfig pattern from packages/bridge/src/helpers.ts —
 * a single loader that fails fast on missing required vars so misconfig
 * surfaces at startup rather than on the first DM.
 */

export interface DiscordBridgeConfig {
  /** Bot token from the Discord developer portal. */
  botToken: string;
  /** WebSocket URL of the upstream MUDdown game server. */
  serverUrl: string;
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
  return {
    botToken,
    serverUrl,
    guildId,
  };
}
