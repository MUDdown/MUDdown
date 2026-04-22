/**
 * Pure helpers for the telnet bridge.
 *
 * Extracted from main.ts so they can be unit-tested without importing
 * the full bridge server (which starts TCP listeners).
 */
import type { LinkMode } from "@muddown/client";
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
  /**
   * Public HTTP base URL shown to the user for browser-based login
   * (e.g. "https://muddown.com"). When the bridge runs on the same host
   * as the game server and uses `ws://localhost:3300/ws` internally,
   * set this to the publicly reachable URL so remote telnet clients
   * can open the login link in their browser.
   *
   * When unset, the bridge derives a base URL from `gameServerUrl`,
   * which is only correct when `gameServerUrl` is itself public.
   */
  publicBaseUrl?: string;
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
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || undefined,
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
    "  Type 'linkmode' to cycle link rendering: auto (capability-derived) → plain (TEXT command) → numbered (TEXT [N] shortcuts) → osc8-send (clickable for Mudlet/Fado/MudForge) → auto.",
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

// ─── OSC 8 ──────────────────────────────────────────────────────────────────

/**
 * Strip C0/C1 control bytes and DEL from a string. Prevents injection of
 * embedded escape sequences (notably `ESC`, BEL, and the OSC/ST terminators)
 * into an outer OSC 8 envelope, which would break terminal output or allow
 * attacker-controlled ANSI sequences to leak through the hyperlink wrapper.
 */
function stripControlChars(s: string): string {
  // U+0000–U+001F (C0) + U+007F (DEL) + U+0080–U+009F (C1)
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/**
 * Wrap `text` in an OSC 8 hyperlink pointing at `uri` when `enabled` is true;
 * otherwise return `text` unchanged.
 *
 * Wire format: `ESC ] 8 ; ; URI ESC \ TEXT ESC ] 8 ; ; ESC \`
 *
 * Parameter order matches the OSC 8 wire layout (URI first, then text).
 * When `enabled` is false, returns a plain string so copy/paste still works
 * on clients that do not advertise `OSC_HYPERLINKS`.
 *
 * Both `uri` and `text` are sanitized of C0/C1 control bytes and DEL before
 * being interpolated, so a caller cannot inject a premature ST terminator or
 * nested escape sequence into the outer envelope.
 */
export function buildOsc8Hyperlink(uri: string, text: string, enabled: boolean): string {
  const safeText = stripControlChars(text);
  if (!enabled) return safeText;
  const safeUri = stripControlChars(uri);
  const OSC = "\x1b]";
  const ST = "\x1b\\";
  return `${OSC}8;;${safeUri}${ST}${safeText}${OSC}8;;${ST}`;
}

// ─── Capability interpretation ──────────────────────────────────────────────

/**
 * Interpret a NEW-ENVIRON USERVAR value as a boolean capability flag.
 *
 * Mudlet advertises OSC 8 capabilities with values like "1", "true", or an
 * empty string (presence-only). Treat those as enabled; treat "0", "false",
 * and any other explicit value as disabled.
 */
export function isCapabilityEnabled(value: string): boolean {
  if (value === "") return true;
  const lower = value.toLowerCase();
  return lower === "1" || lower === "true";
}

// ─── Link mode derivation ────────────────────────────────────────────────────


/**
 * Derive the effective link mode from the user's explicit override and the
 * current capability set.
 *
 * - If the user has set an explicit override, return it unchanged.
 * - Otherwise, if the client advertised `OSC_HYPERLINKS_SEND`, prefer
 *   `osc8-send` so game-command links become clickable in the client
 *   (Mudlet, Fado, MudForge, and any other OSC 8-send-aware client).
 * - Otherwise fall back to `plain`.
 */
export function deriveLinkMode(
  override: LinkMode | undefined,
  capabilities: ReadonlySet<string>,
): LinkMode {
  if (override) return override;
  if (capabilities.has("OSC_HYPERLINKS_SEND")) return "osc8-send";
  return "plain";
}

/**
 * Compute the next step in the `linkmode` command cycle.
 *
 * Cycle: `undefined` (auto) → `plain` → `numbered` → (`osc8-send` iff the
 * client advertised `OSC_HYPERLINKS_SEND`) → `undefined`.
 *
 * For non-capable clients the cycle skips `osc8-send` entirely so the user
 * can't manually engage a mode their terminal won't honour.
 */
export function nextLinkMode(
  current: LinkMode | undefined,
  capabilities: ReadonlySet<string>,
): LinkMode | undefined {
  const canSend = capabilities.has("OSC_HYPERLINKS_SEND");
  if (current === undefined) return "plain";
  if (current === "plain") return "numbered";
  if (current === "numbered") return canSend ? "osc8-send" : undefined;
  return undefined;
}
