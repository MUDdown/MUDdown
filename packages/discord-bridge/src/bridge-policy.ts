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