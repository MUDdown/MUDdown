/**
 * Tracks per-user reconnect state for DM-deduplicated notifications.
 *
 * The bridge wants to tell the player exactly once when the upstream
 * WebSocket transitions into a reconnecting state, and exactly once when
 * it returns. The initial connection (onOpen with no prior reconnect
 * marker) must NOT produce a "reconnected" DM.
 *
 * Pure: state is in-memory only and the helper performs no I/O. Callers
 * decide whether and how to deliver the resulting DM.
 */

export class ReconnectNotifier {
  private readonly reconnecting = new Set<string>();

  /**
   * Mark the user as reconnecting. Returns true the first time per
   * reconnect cycle so the caller can emit a one-shot DM and false on
   * subsequent retries within the same cycle.
   */
  markReconnecting(discordUserId: string): boolean {
    if (this.reconnecting.has(discordUserId)) return false;
    this.reconnecting.add(discordUserId);
    return true;
  }

  /**
   * Mark the user as connected. Returns true only when there was a
   * pending reconnect marker (i.e. this open is the resolution of a
   * prior disconnect), false for the initial connect.
   */
  markConnected(discordUserId: string): boolean {
    return this.reconnecting.delete(discordUserId);
  }

  /** Drop any pending reconnect state for the user (e.g. on session close). */
  forget(discordUserId: string): void {
    this.reconnecting.delete(discordUserId);
  }

  /** Drop all pending reconnect state (e.g. on bridge shutdown/reset). */
  clear(): void {
    this.reconnecting.clear();
  }

  /** Test helper / observability: number of users currently in a reconnecting state. */
  size(): number {
    return this.reconnecting.size;
  }
}
