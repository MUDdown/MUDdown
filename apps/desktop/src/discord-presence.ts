// Discord Rich Presence helpers (room → activity payload + ≥15 s debounce).
//
// The Rust IPC client gates everything on the user's `discord_rich_presence`
// preference, so these helpers can be called unconditionally from the
// renderer — they're cheap when the toggle is off. Discord's RPC guidance is
// "no more than 1 update per 15 seconds"; this module enforces that as a
// self-imposed debounce floor.

export interface RoomPresence {
  region: string;
  title: string;
}

export interface PresencePayload {
  details: string;
  stateText: string;
  largeText: string;
}

export interface PresenceScheduler {
  schedule(muddown: string): void;
  clear(): void;
}

/** Test-only extension that exposes an explicit drain hook. Tests cast the
 *  scheduler to this shape; production callers in main.ts hold the narrower
 *  `PresenceScheduler` type and cannot reach `flushForTesting`. */
export interface TestablePresenceScheduler extends PresenceScheduler {
  flushForTesting(): void;
}

/** Type-only alias so the test file and main.ts can share a single shape
 *  without leaking the test seam to non-test callers. */
export type TimerHandle = ReturnType<typeof setTimeout>;

export interface PresenceSchedulerOptions {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  debounceMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (id: TimerHandle) => void;
  onError?: (where: "update" | "clear", err: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 15_000;

/**
 * Extract `region` from a `:::room{...}` container's attribute list, plus the
 * first `# ` heading as the room title. Returns `null` if the input doesn't
 * look like a room envelope or has no title.
 */
export function parseRoomPresence(muddown: string): RoomPresence | null {
  const open = /^:::room\{([^}]*)\}/m.exec(muddown);
  if (!open) return null;
  const attrs = open[1];
  const region = /\bregion="([^"]+)"/.exec(attrs)?.[1] ?? "Unknown";
  const title = /^#\s+(.+)$/m.exec(muddown)?.[1]?.trim() ?? "";
  if (!title) return null;
  return { region, title };
}

/**
 * Build the activity payload from a parsed room. Kept separate so tests can
 * pin the exact field shape without invoking the scheduler.
 */
export function buildPresencePayload(room: RoomPresence): PresencePayload {
  return {
    details: `Exploring ${room.region}`,
    stateText: room.title,
    largeText: "MUDdown — open Markdown MUD platform",
  };
}

/**
 * Create a presence scheduler that fires `discord_presence_update` on the
 * leading edge of the debounce window and queues a single trailing flush
 * for any room transitions that arrive inside the window.
 */
export function createPresenceScheduler(opts: PresenceSchedulerOptions): PresenceScheduler {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const now = opts.now ?? Date.now;
  const setTimeoutFn: (fn: () => void, ms: number) => TimerHandle =
    opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as TimerHandle);
  const clearTimeoutFn: (id: TimerHandle) => void =
    opts.clearTimeout ?? ((id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>));

  let lastSentAt = Number.NEGATIVE_INFINITY;
  let timer: TimerHandle | null = null;
  let pending: PresencePayload | null = null;

  function flush(): void {
    if (!pending) {
      timer = null;
      return;
    }
    const payload = pending;
    pending = null;
    timer = null;
    // Stamp lastSentAt optimistically so any synchronous schedule() calls
    // that arrive before the IPC promise settles still get coalesced into
    // the trailing-flush window. If the IPC rejects we roll the stamp back
    // (only when no later send has overwritten it) so the next schedule()
    // fires on the leading edge again rather than waiting out a phantom
    // debounce.
    const sentAt = now();
    const prevSentAt = lastSentAt;
    lastSentAt = sentAt;
    // PresencePayload is a plain object literal of strings; the looser
    // Record<string, unknown> shape on `invoke` is the Tauri JS API
    // signature. The structural compatibility check requires the index
    // signature, hence the explicit spread.
    opts.invoke("discord_presence_update", { ...payload }).catch((err) => {
      if (lastSentAt === sentAt) lastSentAt = prevSentAt;
      opts.onError?.("update", err);
    });
  }

  const scheduler: TestablePresenceScheduler = {
    schedule(muddown: string): void {
      const parsed = parseRoomPresence(muddown);
      if (!parsed) return;
      pending = buildPresencePayload(parsed);
      const elapsed = now() - lastSentAt;
      if (elapsed >= debounceMs) {
        if (timer !== null) {
          clearTimeoutFn(timer);
          timer = null;
        }
        flush();
        return;
      }
      if (timer !== null) return; // a flush is already queued; pending was overwritten
      timer = setTimeoutFn(flush, debounceMs - elapsed);
    },
    clear(): void {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      pending = null;
      lastSentAt = Number.NEGATIVE_INFINITY;
      opts.invoke("discord_presence_clear").catch((err) => {
        opts.onError?.("clear", err);
      });
    },
    flushForTesting(): void {
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
        flush();
      }
    },
  };
  return scheduler;
}
