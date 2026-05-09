/**
 * Connection manager — Discord user ID → upstream WebSocket session.
 *
 * Mirrors the per-connection state held by packages/bridge for telnet
 * sockets. One active session per Discord user (matching the WebSocket
 * "one session per connection" invariant); switching characters tears
 * down and rebuilds.
 *
 * This file currently exposes only the type and a minimal in-memory
 * registry — the actual WebSocket lifecycle wiring lands in a
 * follow-up commit alongside the discord.js client integration.
 */

export interface DiscordSession {
  /** Discord user ID (snowflake). */
  discordUserId: string;
  /** Linked MUDdown account ID (set after OAuth verification). */
  accountId: string;
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
    const isNewSession = !this.sessions.has(session.discordUserId);
    this.sessions.set(session.discordUserId, session);
    return isNewSession;
  }

  close(discordUserId: string): boolean {
    if (!discordUserId.trim()) return false;
    return this.sessions.delete(discordUserId);
  }

  size(): number {
    return this.sessions.size;
  }
}
