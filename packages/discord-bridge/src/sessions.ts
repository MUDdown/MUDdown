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
  /** Wall-clock start time, used for play-time tracking. */
  startedAt: Date;
  /** Wall-clock time of the most recent user-originated activity; refreshed by `touch()`. */
  lastActivityAt: Date;
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

  /**
   * Mark a user-originated activity for the given session. Returns true when
   * the session exists and the timestamp was updated, false otherwise.
   */
  touch(discordUserId: string, when: Date = new Date()): boolean {
    if (!discordUserId.trim()) return false;
    const session = this.sessions.get(discordUserId);
    if (!session) return false;
    session.lastActivityAt = when;
    return true;
  }

  values(): IterableIterator<DiscordSession> {
    return this.sessions.values();
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
