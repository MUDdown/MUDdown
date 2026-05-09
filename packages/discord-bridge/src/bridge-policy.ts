import { decodeLinkCustomId, LINK_SELECT_CUSTOM_ID } from "./render.js";

interface SessionLike {
  sessionToken: string;
}

interface SessionExistenceLookup {
  get(discordUserId: string): unknown | undefined;
}

interface SessionTokenLookup {
  get(discordUserId: string): SessionLike | undefined;
}

interface GameplayConnectionLike {
  send(command: string): boolean;
}

interface ConnectionLookup {
  get(discordUserId: string): GameplayConnectionLike | undefined;
}

interface ActivityRecorder {
  touch(discordUserId: string): boolean;
}

/**
 * Conditionally refresh a session's activity timestamp after a successful
 * inbound action and report when `touch()` returns false (the session
 * vanished between the dispatch and the activity update). Pure: all I/O
 * happens through the injected callbacks. Returns the value of `success`
 * unchanged so callers can short-circuit.
 */
export function recordActivityIfDispatched(
  discordUserId: string,
  success: boolean,
  sessions: ActivityRecorder,
  onMissingSession?: (discordUserId: string) => void,
): boolean {
  if (success && !sessions.touch(discordUserId)) {
    onMissingSession?.(discordUserId);
  }
  return success;
}

/**
 * Unconditionally refresh a session's activity timestamp in response to a
 * non-gameplay user interaction (a slash command, a character-select pick,
 * etc.). Returns true if the session existed and was touched, false if no
 * session was found (the no-session case is silently fine for `/play` etc.;
 * pass `onMissingSession` if you want to log it for handlers that require an
 * active session).
 */
export function recordUserInteraction(
  discordUserId: string,
  sessions: ActivityRecorder,
  onMissingSession?: (discordUserId: string) => void,
): boolean {
  const touched = sessions.touch(discordUserId);
  if (!touched) {
    onMissingSession?.(discordUserId);
  }
  return touched;
}

/**
 * Format a "Ns / Nm / Nh" duration string from a non-negative millisecond delta.
 * Used by the `/who` status line. Floors to the nearest unit boundary; clamps
 * negative or non-finite inputs to "0s" so a clock skew can't produce garbage.
 */
export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export interface WhoStatusInput {
  characterId: string | null;
  startedAtMs: number;
  lastActivityAtMs: number;
  connected: boolean;
  /** Idle threshold in milliseconds; activity older than this is shown with an "(idle)" hint. */
  idleTimeoutMs: number;
  /** Wall-clock reference, defaults to Date.now(). Injected for tests. */
  nowMs?: number;
}

/**
 * Render the `/who` status line. Pure: no I/O, no Date.now() unless `nowMs`
 * is omitted at the call site.
 */
export function formatWhoStatus(input: WhoStatusInput): string {
  const now = input.nowMs ?? Date.now();
  const uptime = formatDurationShort(now - input.startedAtMs);
  const idleAge = now - input.lastActivityAtMs;
  const idle = formatDurationShort(idleAge);
  const wsState = input.connected ? "connected" : "disconnected";
  const character = input.characterId ?? "(none)";
  const idleSuffix = idleAge >= input.idleTimeoutMs ? " (idle — eligible for eviction)" : "";
  return `Active session: character ${character}, websocket ${wsState}, uptime ${uptime}, last activity ${idle} ago${idleSuffix}.`;
}

export function resolveGameplayInteractionCommand(customId: string, values: string[]): string | undefined {
  const encoded = customId === LINK_SELECT_CUSTOM_ID ? values[0] : customId;
  if (!encoded) return undefined;
  return decodeLinkCustomId(encoded);
}

export function dispatchGameplayCommand(
  discordUserId: string,
  command: string,
  sessions: SessionExistenceLookup,
  connections: ConnectionLookup,
  closeSession: (discordUserId: string) => void,
): boolean {
  const session = sessions.get(discordUserId);
  const connection = connections.get(discordUserId);
  if (!session || !connection) return false;

  const sent = connection.send(command);
  if (!sent) {
    closeSession(discordUserId);
    return false;
  }

  return true;
}

export async function refreshReconnectTicket(
  discordUserId: string,
  sessions: SessionTokenLookup,
  fetchWsTicket: (sessionToken: string) => Promise<string | undefined>,
): Promise<string> {
  const session = sessions.get(discordUserId);
  if (!session) {
    throw new Error(`No active session available for websocket reconnect for user ${discordUserId}`);
  }

  const refreshedTicket = await fetchWsTicket(session.sessionToken);
  if (!refreshedTicket) {
    throw new Error(`Failed to refresh websocket ticket for user ${discordUserId} while reconnecting`);
  }

  return refreshedTicket;
}

export function handleReconnectError(
  discordUserId: string,
  closeSession: (discordUserId: string, notify: boolean) => void,
): void {
  closeSession(discordUserId, true);
}

export function handleSocketClose(
  discordUserId: string,
  willReconnect: boolean,
  closeSession: (discordUserId: string, notify: boolean) => void,
): void {
  if (willReconnect) return;
  closeSession(discordUserId, true);
}