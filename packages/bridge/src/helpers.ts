/**
 * Pure helpers for the telnet bridge.
 *
 * Extracted from main.ts so they can be unit-tested without importing
 * the full bridge server (which starts TCP listeners).
 */

// ─── Configuration ───────────────────────────────────────────────────────────

export interface BridgeConfig {
  /** TLS listen port (default 2323). */
  port: number;
  /** TLS certificate file path. */
  tlsCert: string;
  /** TLS key file path. */
  tlsKey: string;
  /** Game server WebSocket URL (default wss://muddown.com/ws). */
  gameServerUrl: string;
  /** Keepalive interval in ms (default 30000). */
  keepaliveMs: number;
  /** Bridge server name shown in banner. */
  serverName: string;
}

export function loadConfig(): BridgeConfig {
  const port = parseInt(process.env.BRIDGE_PORT ?? "", 10);
  const keepaliveMs = parseInt(process.env.TELNET_KEEPALIVE_MS ?? "", 10);
  return {
    port: Number.isNaN(port) ? 2323 : port,
    tlsCert: process.env.TELNET_TLS_CERT ?? "",
    tlsKey: process.env.TELNET_TLS_KEY ?? "",
    gameServerUrl: process.env.GAME_SERVER_URL ?? "wss://muddown.com/ws",
    keepaliveMs: Number.isNaN(keepaliveMs) ? 30000 : keepaliveMs,
    serverName: process.env.BRIDGE_SERVER_NAME ?? "MUDdown",
  };
}

// ─── ASCII Banner ────────────────────────────────────────────────────────────

export function getBanner(serverName: string): string {
  return [
    "",
    "  __  __ _   _ ____      _                    ",
    " |  \\/  | | | |  _ \\  __| | _____      ___ __ ",
    " | |\\/| | | | | | | |/ _` |/ _ \\ \\ /\\ / / '_ \\",
    " | |  | | |_| | |_| | (_| | (_) \\ V  V /| | | |",
    " |_|  |_|\\___/|____/ \\__,_|\\___/ \\_/\\_/ |_| |_|",
    "",
    `  Welcome to ${serverName}!`,
    "",
    "  Type 'help' for commands, 'login' to authenticate,",
    "  or just start playing as a guest.",
    "",
    "  Type 'linkmode' to toggle numbered link shortcuts.",
    "",
  ].join("\r\n");
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

export function wsToHttpBase(wsUrl: string): string {
  if (wsUrl.startsWith("wss://")) return "https://" + wsUrl.slice(6).replace(/\/ws$/, "");
  if (wsUrl.startsWith("ws://")) return "http://" + wsUrl.slice(5).replace(/\/ws$/, "");
  return wsUrl;
}

// ─── TTYPE cycling ───────────────────────────────────────────────────────────

/**
 * Update the TTYPE cycle state given a newly received terminal type string.
 * Returns whether the cycle is complete and the updated types array.
 *
 * RFC 1091: the client cycles through its terminal types in order; when it
 * repeats a value already seen, the cycle is complete.
 */
export function updateTtypeCycle(
  existing: string[],
  incoming: string | undefined,
): { done: boolean; types: string[] } {
  if (!incoming) {
    // Malformed TTYPE response — finish with what we have
    return { done: true, types: existing };
  }
  if (existing.includes(incoming)) {
    // Repeated value signals end of cycle
    return { done: true, types: existing };
  }
  return { done: false, types: [...existing, incoming] };
}
