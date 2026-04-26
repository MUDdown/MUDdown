/**
 * Pure helpers for the telnet bridge.
 *
 * Extracted from main.ts so they can be unit-tested without importing
 * the full bridge server (which starts TCP listeners).
 */
import type { LinkMode } from "@muddown/client";
import { iacSub, MSSP_VAR, MSSP_VAL, OPT_MSSP } from "./telnet.js";
// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Static MSSP fields advertised to MUD listing crawlers and clients that
 * support the MUD Server Status Protocol.
 *
 * The keyset mirrors the StickMUD example on the Mudlet wiki
 * (https://wiki.mudlet.org/w/Manual:Supported_Protocols#MSSP) so that
 * crawlers parse every field with no surprises. Live values (player count,
 * world counts) come from {@link MsspStats}, not this record.
 */
export interface MsspConfig {
  name: string;
  hostname: string;
  contact: string;
  website: string;
  icon: string;
  discord: string;
  language: string;
  location: string;
  created: string;
  codebase: string;
  genre: string;
  subgenre: string;
  gameplay: string;
  status: string;
  minimumAge: string;
}

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
  /** Static fields advertised via MSSP sub-negotiation. */
  mssp: MsspConfig;
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
    mssp: {
      name: process.env.MSSP_NAME ?? process.env.BRIDGE_SERVER_NAME ?? "MUDdown",
      hostname: process.env.MSSP_HOSTNAME ?? "muddown.com",
      contact: process.env.MSSP_CONTACT ?? "support@muddown.com",
      website: process.env.MSSP_WEBSITE ?? "https://muddown.com",
      icon: process.env.MSSP_ICON ?? "https://muddown.com/favicon.ico",
      discord: process.env.MSSP_DISCORD ?? "https://discord.gg/mDFcMT3egK",
      language: process.env.MSSP_LANGUAGE ?? "English",
      location: process.env.MSSP_LOCATION ?? "United States of America",
      created: process.env.MSSP_CREATED ?? "2026",
      codebase: process.env.MSSP_CODEBASE ?? "MUDdown",
      genre: process.env.MSSP_GENRE ?? "Fantasy",
      subgenre: process.env.MSSP_SUBGENRE ?? "Medieval Fantasy",
      gameplay: process.env.MSSP_GAMEPLAY ?? "Hack and Slash",
      status: process.env.MSSP_STATUS ?? "Alpha",
      minimumAge: process.env.MSSP_MINIMUM_AGE ?? "13",
    },
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
    "  Type 'help' for bridge commands.",
    "",
  ].join("\r\n");
}

// ─── Startup menu ────────────────────────────────────────────────────────────

/**
 * The static menu text shown to every connecting telnet user before the
 * bridge connects to the game server. The runtime dispatch on each choice
 * lives in `TelnetSession.runStartupMenu`.
 */
export function getStartupMenu(): string {
  return [
    "",
    "What would you like to do?",
    "",
    "  [1] Log in to an existing character",
    "  [2] Create a new character",
    "  [3] Play as a guest",
    "",
    "",
  ].join("\r\n");
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

/**
 * Canonical display casing for OAuth provider IDs returned by
 * /auth/providers (which are lowercase: "discord", "github", "microsoft",
 * "google"). Falls back to capitalising the first letter for unknown
 * values so future providers render reasonably without a code change.
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  discord: "Discord",
  github: "GitHub",
  microsoft: "Microsoft",
  google: "Google",
};

export function displayProviderName(provider: string): string {
  const known = PROVIDER_DISPLAY_NAMES[provider.toLowerCase()];
  if (known) return known;
  if (provider.length === 0) return provider;
  return provider[0].toUpperCase() + provider.slice(1);
}

/**
 * Build the public OAuth login URL the user opens (or clicks via OSC 8) to
 * authenticate with `provider`. The bridge generates `nonce` up front and
 * polls `/auth/token-poll` for the same value, so the same nonce must end
 * up in the URL the user opens — that's what makes the click-to-login flow
 * work in OSC 8-capable clients.
 */
export function buildLoginUrl(publicBase: string, provider: string, nonce: string): string {
  const url = new URL(publicBase);
  // Append /auth/login to any path prefix the operator configured (e.g.
  // a reverse-proxy mount under /api). Strip a trailing slash on the
  // base path first so we don't double up.
  url.pathname = url.pathname.replace(/\/$/, "") + "/auth/login";
  url.searchParams.set("provider", provider);
  url.searchParams.set("login_nonce", nonce);
  return url.toString();
}

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

// ─── MSSP (MUD Server Status Protocol) ───────────────────────────────────────

/**
 * Live counters sourced from the game server via `GET /stats`. Each field
 * becomes the value of the matching MSSP variable; `-1` signals "unknown"
 * per the MSSP spec.
 *
 * `uptime` is the bridge process start time (unix seconds), not a game-server
 * timestamp — the bridge captures it at module load and passes it through.
 */
export interface MsspStats {
  players: number;
  uptime: number;
  areas: number;
  rooms: number;
  objects: number;
  mobiles: number;
  helpfiles: number;
  classes: number;
  levels: number;
}

/** Fallback stats used before the first `/stats` fetch completes. */
export const MSSP_STATS_UNKNOWN: MsspStats = {
  players: -1,
  uptime: -1,
  areas: -1,
  rooms: -1,
  objects: -1,
  mobiles: -1,
  helpfiles: -1,
  classes: -1,
  levels: -1,
};

/**
 * Build the ordered MSSP variable set. The keyset matches the StickMUD
 * example documented on the Mudlet wiki
 * (https://wiki.mudlet.org/w/Manual:Supported_Protocols#MSSP), plus the
 * official MSSP spec's `XTERM TRUE COLORS` key
 * (https://mudhalla.net/tintin/protocols/mssp/) since the bridge
 * negotiates 24-bit color via TTYPE/COLORTERM. No other custom keys.
 *
 * `bridgePort` is the telnet port the bridge itself listens on. MSSP expects
 * `PORT`, `TLS`, and `SSL` to all advertise that same value; `SSL` is a
 * legacy duplicate that Mudlet's example still carries. This assumes the
 * bridge is TLS-only (true today); if a plaintext listener is ever added,
 * split `PORT` from `TLS`/`SSL` so crawlers see the correct protocol tier.
 *
 * `ip` is included only when non-empty so a failed DNS lookup at startup
 * doesn't advertise a bogus value. `RACES` and `SKILLS` are emitted as
 * `-1` until those systems ship.
 */
export function buildMsspVars(
  config: MsspConfig,
  stats: MsspStats,
  bridgePort: number,
  ip: string,
): Record<string, string> {
  const vars: Record<string, string> = {
    "NAME": config.name,
    "PLAYERS": String(stats.players),
    "UPTIME": String(stats.uptime),
    "HOSTNAME": config.hostname,
    "PORT": String(bridgePort),
    "TLS": String(bridgePort),
    "SSL": String(bridgePort),
  };
  if (ip) vars["IP"] = ip;
  Object.assign(vars, {
    "CONTACT": config.contact,
    "WEBSITE": config.website,
    "ICON": config.icon,
    "DISCORD": config.discord,
    "LANGUAGE": config.language,
    "LOCATION": config.location,
    "CREATED": config.created,
    "CODEBASE": config.codebase,
    "FAMILY": "Custom",
    "GAMESYSTEM": "Custom",
    "GENRE": config.genre,
    "SUBGENRE": config.subgenre,
    "GAMEPLAY": config.gameplay,
    "STATUS": config.status,
    "INTERMUD": "-1",
    "MINIMUM AGE": config.minimumAge,
    "PUEBLO": "0",
    "AREAS": String(stats.areas),
    "ROOMS": String(stats.rooms),
    "OBJECTS": String(stats.objects),
    "MOBILES": String(stats.mobiles),
    "HELPFILES": String(stats.helpfiles),
    "CLASSES": String(stats.classes),
    "LEVELS": String(stats.levels),
    "RACES": "-1",
    "SKILLS": "-1",
    "ANSI": "1",
    "UTF-8": "1",
    "VT100": "0",
    "XTERM 256 COLORS": "1",
    "XTERM TRUE COLORS": "1",
    "MXP": "0",
    "MSP": "0",
    "MCP": "0",
    "MCCP": "0",
    "GMCP": "0",
    "MSDP": "0",
    "PAY TO PLAY": "0",
    "PAY FOR PERKS": "0",
    "HIRING BUILDERS": "0",
    "HIRING CODERS": "0",
  });
  return vars;
}

/**
 * Build the MSSP sub-negotiation payload:
 * `IAC SB MSSP (MSSP_VAR <name> MSSP_VAL <value>)* IAC SE`.
 *
 * Per https://tintin.mudhalla.net/protocols/mssp/, the spec describes names
 * and values as ASCII. This implementation is more permissive: strings are
 * Latin-1 encoded (Buffer.from(s, "latin1")), so bytes 0x80–0xFF are allowed
 * to support extended-ASCII content. Strings may not contain NUL,
 * `MSSP_VAR` (0x01), or `MSSP_VAL` (0x02) after latin1 encoding — any such
 * byte desynchronises a crawler's parser, so callers that supply one trigger
 * a `RangeError` rather than producing a malformed payload. (Note: code
 * points ≥ 0x100 are truncated to their low byte by latin1 encoding, so
 * validation runs on the encoded bytes, not the source code units.) IAC
 * (0xFF) is handled differently: `iacSub` silently doubles it per RFC 854,
 * so 0xFF in a value is safe and survives the wire round-trip.
 */
export function buildMsspSubneg(vars: Record<string, string>): Buffer {
  const bytes: number[] = [];
  for (const [name, value] of Object.entries(vars)) {
    const nameBuf = Buffer.from(name, "latin1");
    const valueBuf = Buffer.from(value, "latin1");
    for (const [s, buf] of [[name, nameBuf], [value, valueBuf]] as const) {
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i]!;
        if (b === 0 || b === MSSP_VAR || b === MSSP_VAL) {
          throw new RangeError(
            `buildMsspSubneg: ${JSON.stringify(s)} contains reserved byte ` +
            `0x${b.toString(16).padStart(2, "0")} at index ${i}`,
          );
        }
      }
    }
    bytes.push(MSSP_VAR);
    for (const b of nameBuf) bytes.push(b);
    bytes.push(MSSP_VAL);
    for (const b of valueBuf) bytes.push(b);
  }
  return iacSub(OPT_MSSP, ...bytes);
}
