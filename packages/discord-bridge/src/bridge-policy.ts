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