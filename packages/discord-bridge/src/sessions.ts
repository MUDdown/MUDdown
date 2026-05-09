/**
 * Connection manager — Discord user ID → upstream WebSocket session.
 *
 * Mirrors the per-connection state held by packages/bridge for telnet
 * sockets. One active session per Discord user (matching the WebSocket
 * "one session per connection" invariant); switching characters tears
 * down and rebuilds.
 */

export interface DiscordSession {
  /** Discord user ID (snowflake). */
  discordUserId: string;
  /** Linked MUDdown account ID (set after OAuth verification). */
  accountId: string;
  /** Bearer token for authenticated upstream API calls (/auth/me, /auth/characters, /auth/select-character, /auth/ws-ticket). */
  sessionToken: string;
  /** Currently selected character ID — null while the picker is open. */
  characterId: string | null;
  /** Wall-clock start time, used for idle eviction and play-time tracking. */
  startedAt: Date;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, DiscordSession>();

  get(discordUserId: string): DiscordSession | undefined {
    if (!discordUserId.trim()) return undefined;
    return this.sessions.get(discordUserId);
  }

  open(session: DiscordSession): boolean {
    if (!session.discordUserId.trim()) return false;
    if (this.sessions.has(session.discordUserId)) return false;
    this.sessions.set(session.discordUserId, session);
    return true;
  }

  close(discordUserId: string): boolean {
    if (!discordUserId.trim()) return false;
    return this.sessions.delete(discordUserId);
  }

  size(): number {
    return this.sessions.size;
  }

  clear(): number {
    const cleared = this.sessions.size;
    this.sessions.clear();
    return cleared;
  }
}
