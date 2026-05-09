import { describe, it, expect, vi } from "vitest";
import {
  IDLE_CHECK_INTERVAL_MS,
  IDLE_TIMEOUT_MS,
  findIdleSessions,
  runIdleSweep,
  type IdleSessionLike,
} from "../src/idle-policy.js";

function session(id: string, lastActivityAt: Date): IdleSessionLike {
  return { discordUserId: id, lastActivityAt };
}

describe("idle-policy constants", () => {
  it("IDLE_TIMEOUT_MS is positive and at least one minute", () => {
    expect(IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("IDLE_CHECK_INTERVAL_MS is positive and shorter than IDLE_TIMEOUT_MS", () => {
    expect(IDLE_CHECK_INTERVAL_MS).toBeGreaterThan(0);
    expect(IDLE_CHECK_INTERVAL_MS).toBeLessThan(IDLE_TIMEOUT_MS);
  });
});

describe("findIdleSessions", () => {
  const now = Date.UTC(2026, 4, 9, 12, 0, 0);

  it("returns empty when no sessions are provided", () => {
    expect(findIdleSessions(now, [])).toEqual([]);
  });

  it("returns IDs of sessions whose lastActivityAt is older than the timeout", () => {
    const stale = new Date(now - IDLE_TIMEOUT_MS - 1);
    const fresh = new Date(now - 1_000);
    const result = findIdleSessions(now, [session("a", stale), session("b", fresh)]);
    expect(result).toEqual(["a"]);
  });

  it("treats sessions exactly at the timeout boundary as idle", () => {
    const exactly = new Date(now - IDLE_TIMEOUT_MS);
    expect(findIdleSessions(now, [session("a", exactly)])).toEqual(["a"]);
  });

  it("preserves iteration order in output", () => {
    const stale1 = new Date(now - IDLE_TIMEOUT_MS - 5_000);
    const stale2 = new Date(now - IDLE_TIMEOUT_MS - 1_000);
    const result = findIdleSessions(now, [
      session("first", stale1),
      session("second", stale2),
    ]);
    expect(result).toEqual(["first", "second"]);
  });

  it("respects a custom idleTimeoutMs override", () => {
    const recent = new Date(now - 10_000);
    expect(findIdleSessions(now, [session("a", recent)], 5_000)).toEqual(["a"]);
    expect(findIdleSessions(now, [session("a", recent)], 30_000)).toEqual([]);
  });

  it("returns empty when idleTimeoutMs is zero or negative", () => {
    const stale = new Date(now - IDLE_TIMEOUT_MS - 1);
    expect(findIdleSessions(now, [session("a", stale)], 0)).toEqual([]);
    expect(findIdleSessions(now, [session("a", stale)], -1)).toEqual([]);
  });

  it("ignores sessions whose lastActivityAt is non-finite", () => {
    const broken: IdleSessionLike = { discordUserId: "broken", lastActivityAt: new Date(Number.NaN) };
    const stale = new Date(now - IDLE_TIMEOUT_MS - 1);
    expect(findIdleSessions(now, [broken, session("a", stale)])).toEqual(["a"]);
  });
});

describe("runIdleSweep", () => {
  const now = Date.UTC(2026, 4, 9, 12, 0, 0);

  it("calls closeSession for every idle ID and returns the list", () => {
    const stale = new Date(now - IDLE_TIMEOUT_MS - 1);
    const fresh = new Date(now - 1_000);
    const closed: string[] = [];
    const result = runIdleSweep(
      now,
      [session("a", stale), session("b", fresh), session("c", stale)],
      IDLE_TIMEOUT_MS,
      (id) => closed.push(id),
    );
    expect(result).toEqual(["a", "c"]);
    expect(closed).toEqual(["a", "c"]);
  });

  it("does not call closeSession when no sessions are idle", () => {
    const closeSession = vi.fn();
    const result = runIdleSweep(
      now,
      [session("a", new Date(now - 1_000))],
      IDLE_TIMEOUT_MS,
      closeSession,
    );
    expect(result).toEqual([]);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("routes per-user errors through onError without aborting the batch", () => {
    const stale = new Date(now - IDLE_TIMEOUT_MS - 1);
    const closed: string[] = [];
    const errors: Array<[string, unknown]> = [];
    const boom = new Error("boom");
    runIdleSweep(
      now,
      [session("a", stale), session("b", stale), session("c", stale)],
      IDLE_TIMEOUT_MS,
      (id) => {
        if (id === "b") throw boom;
        closed.push(id);
      },
      (id, error) => errors.push([id, error]),
    );
    expect(closed).toEqual(["a", "c"]);
    expect(errors).toEqual([["b", boom]]);
  });

  it("swallows per-user errors silently when onError is not provided", () => {
    const stale = new Date(now - IDLE_TIMEOUT_MS - 1);
    const closed: string[] = [];
    expect(() =>
      runIdleSweep(
        now,
        [session("a", stale), session("b", stale)],
        IDLE_TIMEOUT_MS,
        (id) => {
          if (id === "a") throw new Error("boom");
          closed.push(id);
        },
      ),
    ).not.toThrow();
    expect(closed).toEqual(["b"]);
  });

  it("integrates with setInterval at IDLE_CHECK_INTERVAL_MS cadence", () => {
    vi.useFakeTimers();
    try {
      const stale = new Date(now - IDLE_TIMEOUT_MS - 1);
      const sessions: IdleSessionLike[] = [session("a", stale)];
      const closeSession = vi.fn();
      const timer = setInterval(() => {
        runIdleSweep(Date.now(), sessions, IDLE_TIMEOUT_MS, closeSession);
      }, IDLE_CHECK_INTERVAL_MS);
      vi.setSystemTime(now);
      vi.advanceTimersByTime(IDLE_CHECK_INTERVAL_MS);
      expect(closeSession).toHaveBeenCalledTimes(1);
      expect(closeSession).toHaveBeenCalledWith("a");
      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });
});
