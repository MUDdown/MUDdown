/**
 * Environment-driven configuration for the Discord bridge.
 *
 * Mirrors the BridgeConfig pattern from packages/bridge/src/helpers.ts —
 * a single loader that fails fast on missing required vars so misconfig
 * surfaces at startup rather than on the first DM.
 */

import {
  GAMEPLAY_DELIVERY_BACKOFF_MS,
  GAMEPLAY_DELIVERY_RETRIES,
  MAX_CONSECUTIVE_DELIVERY_FAILURES,
  MAX_GAMEPLAY_DELIVERY_BACKOFF_MS,
} from "./delivery-policy.js";
import { IDLE_CHECK_INTERVAL_MS, IDLE_TIMEOUT_MS } from "./idle-policy.js";

export type WebSocketUrl = `ws://${string}` | `wss://${string}`;

/**
 * Numeric runtime knobs. Each has a sensible default; operators may override
 * any of them via env vars at startup. All values are positive finite integers
 * (validated by the loader).
 */
export interface DiscordBridgeTunables {
  /** Inactivity threshold before a session is evicted by the idle sweep. */
  readonly idleTimeoutMs: number;
  readonly idleCheckIntervalMs: number;
  /** Per-envelope retry attempts when DM delivery fails. */
  readonly deliveryRetries: number;
  /** Linear-backoff base between retries (`backoff = base × attempt`). */
  readonly deliveryBackoffMs: number;
  /** Hard cap on per-attempt backoff. */
  readonly maxDeliveryBackoffMs: number;
  /** Consecutive envelope failures that terminate the session. */
  readonly maxConsecutiveDeliveryFailures: number;
}

export interface DiscordBridgeConfig {
  /** Bot token from the Discord developer portal. */
  botToken: string;
  /** WebSocket URL of the upstream MUDdown game server. */
  serverUrl: WebSocketUrl;
  /** Optional guild for guild-scoped slash-command registration during development. */
  guildId: string | undefined;
  /** Numeric runtime knobs (defaults applied when env vars are unset). */
  tunables: DiscordBridgeTunables;
}

export class DiscordBridgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordBridgeConfigError";
  }
}

/**
 * Parse a positive-integer env var. The raw value is trimmed first; an unset
 * variable, an empty string, or a whitespace-only string returns the default.
 * Any other value must parse as a positive finite integer; otherwise this
 * throws `DiscordBridgeConfigError` (rejects non-numeric, zero, negative,
 * non-integer, and non-finite inputs).
 */
export function parsePositiveIntEnv(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (!Number.isFinite(defaultValue) || !Number.isInteger(defaultValue) || defaultValue <= 0) {
    throw new DiscordBridgeConfigError(
      `internal: default for ${name} must be a positive integer (got ${defaultValue})`,
    );
  }
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return defaultValue;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new DiscordBridgeConfigError(
      `${name} must be a positive integer (got ${JSON.stringify(raw)})`,
    );
  }
  return parsed;
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

  const tunables: DiscordBridgeTunables = {
    idleTimeoutMs: parsePositiveIntEnv(
      "MUDDOWN_DISCORD_IDLE_TIMEOUT_MS",
      env.MUDDOWN_DISCORD_IDLE_TIMEOUT_MS,
      IDLE_TIMEOUT_MS,
    ),
    idleCheckIntervalMs: parsePositiveIntEnv(
      "MUDDOWN_DISCORD_IDLE_CHECK_INTERVAL_MS",
      env.MUDDOWN_DISCORD_IDLE_CHECK_INTERVAL_MS,
      IDLE_CHECK_INTERVAL_MS,
    ),
    deliveryRetries: parsePositiveIntEnv(
      "MUDDOWN_DISCORD_DELIVERY_RETRIES",
      env.MUDDOWN_DISCORD_DELIVERY_RETRIES,
      GAMEPLAY_DELIVERY_RETRIES,
    ),
    deliveryBackoffMs: parsePositiveIntEnv(
      "MUDDOWN_DISCORD_DELIVERY_BACKOFF_MS",
      env.MUDDOWN_DISCORD_DELIVERY_BACKOFF_MS,
      GAMEPLAY_DELIVERY_BACKOFF_MS,
    ),
    maxDeliveryBackoffMs: parsePositiveIntEnv(
      "MUDDOWN_DISCORD_MAX_DELIVERY_BACKOFF_MS",
      env.MUDDOWN_DISCORD_MAX_DELIVERY_BACKOFF_MS,
      MAX_GAMEPLAY_DELIVERY_BACKOFF_MS,
    ),
    maxConsecutiveDeliveryFailures: parsePositiveIntEnv(
      "MUDDOWN_DISCORD_MAX_CONSECUTIVE_DELIVERY_FAILURES",
      env.MUDDOWN_DISCORD_MAX_CONSECUTIVE_DELIVERY_FAILURES,
      MAX_CONSECUTIVE_DELIVERY_FAILURES,
    ),
  };

  // Cross-field invariants. Both represent operator misconfigurations that
  // would silently degrade behavior (the idle sweep would run less often than
  // the timeout, so idle sessions could linger up to a full extra check
  // interval before eviction; the backoff cap would clamp the very first
  // retry below its base) rather than fail at startup, so we surface them
  // here.
  if (tunables.idleCheckIntervalMs >= tunables.idleTimeoutMs) {
    throw new DiscordBridgeConfigError(
      `MUDDOWN_DISCORD_IDLE_CHECK_INTERVAL_MS (${tunables.idleCheckIntervalMs}) must be less than MUDDOWN_DISCORD_IDLE_TIMEOUT_MS (${tunables.idleTimeoutMs})`,
    );
  }
  if (tunables.deliveryBackoffMs > tunables.maxDeliveryBackoffMs) {
    throw new DiscordBridgeConfigError(
      `MUDDOWN_DISCORD_DELIVERY_BACKOFF_MS (${tunables.deliveryBackoffMs}) must not exceed MUDDOWN_DISCORD_MAX_DELIVERY_BACKOFF_MS (${tunables.maxDeliveryBackoffMs})`,
    );
  }

  return {
    botToken,
    serverUrl: serverUrl as WebSocketUrl,
    guildId,
    tunables,
  };
}
