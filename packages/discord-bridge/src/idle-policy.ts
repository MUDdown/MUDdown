/**
 * Idle eviction policy — pure helpers used by the bridge to decide which
 * Discord-bridge sessions have been idle long enough to evict.
 *
 * "Idle" means the user has not produced inbound activity (DM text,
 * button, or select-menu interaction) within IDLE_TIMEOUT_MS. Server-pushed
 * messages do not refresh the timer; activity must be user-originated so an
 * AFK player whose game pushes ambient updates still ages out.
 */

/** Default time without user activity before a session is eligible for eviction. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

export interface IdleSessionLike {
  discordUserId: string;
  lastActivityAt: Date;
}

/**
 * Returns the IDs of sessions that have been idle for at least `idleTimeoutMs`
 * relative to `now`. Pure: makes no I/O and does not mutate inputs.
 */
export function findIdleSessions(
  now: number,
  sessions: Iterable<IdleSessionLike>,
  idleTimeoutMs: number = IDLE_TIMEOUT_MS,
): string[] {
  if (idleTimeoutMs <= 0) return [];
  const idle: string[] = [];
  for (const session of sessions) {
    const lastActivity = session.lastActivityAt.getTime();
    if (!Number.isFinite(lastActivity)) continue;
    if (now - lastActivity >= idleTimeoutMs) {
      idle.push(session.discordUserId);
    }
  }
  return idle;
}

/**
 * Run a single idle-sweep tick: find idle sessions and close each via the
 * caller-supplied `closeSession` callback (always with notify: true so the
 * user gets a DM explaining the eviction). Per-user errors are caught and
 * routed through `onError` so one failing close cannot starve the rest of
 * the batch. Pure with respect to its own state — all I/O happens in the
 * injected callbacks. Returns the IDs that were attempted.
 */
export function runIdleSweep(
  now: number,
  sessions: Iterable<IdleSessionLike>,
  idleTimeoutMs: number,
  closeSession: (discordUserId: string) => void,
  onError?: (discordUserId: string, error: unknown) => void,
): string[] {
  const idle = findIdleSessions(now, sessions, idleTimeoutMs);
  for (const discordUserId of idle) {
    try {
      closeSession(discordUserId);
    } catch (error) {
      onError?.(discordUserId, error);
    }
  }
  return idle;
}
