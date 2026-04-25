import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getMsspStats, __resetMsspCacheForTesting } from "../src/bridge.js";
import { MSSP_STATS_UNKNOWN } from "../src/helpers.js";

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch(impl: Parameters<FetchMock>[0]): FetchMock {
  const m = vi.fn(impl);
  (globalThis as { fetch: unknown }).fetch = m;
  return m;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("getMsspStats", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __resetMsspCacheForTesting();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns parsed MSSP stats after the first successful fetch", async () => {
    mockFetch(async () => jsonResponse({
      players: 3, areas: 5, rooms: 47, objects: 120,
      mobiles: 23, helpfiles: 12, classes: 4, levels: 0,
    }));
    const stats = await getMsspStats("http://localhost:3300");
    expect(stats.players).toBe(3);
    expect(stats.rooms).toBe(47);
    expect(stats.levels).toBe(0);
  });

  it("overrides uptime with the bridge process start time (not the /stats value)", async () => {
    mockFetch(async () => jsonResponse({
      players: 0, uptime: 999, areas: 0, rooms: 0, objects: 0,
      mobiles: 0, helpfiles: 0, classes: 0, levels: 0,
    }));
    const stats = await getMsspStats("http://localhost:3300");
    // BRIDGE_STARTED_AT is captured at module load; it must be a recent
    // positive unix-seconds value, not the 999 from the response.
    expect(stats.uptime).not.toBe(999);
    expect(stats.uptime).toBeGreaterThan(1_700_000_000);
  });

  it("falls back to -1 for any field that is missing or wrong-typed in the response", async () => {
    mockFetch(async () => jsonResponse({
      players: 3,
      // everything else missing or wrong type
      areas: "five",
      rooms: null,
    }));
    const stats = await getMsspStats("http://localhost:3300");
    expect(stats.players).toBe(3);
    expect(stats.areas).toBe(-1);
    expect(stats.rooms).toBe(-1);
    expect(stats.objects).toBe(-1);
    expect(stats.mobiles).toBe(-1);
    expect(stats.helpfiles).toBe(-1);
    expect(stats.classes).toBe(-1);
    expect(stats.levels).toBe(-1);
  });

  it("caches successful results for MSSP_STATS_TTL_MS (30s)", async () => {
    const fetchSpy = mockFetch(async () => jsonResponse({
      players: 1, areas: 1, rooms: 1, objects: 1,
      mobiles: 1, helpfiles: 1, classes: 1, levels: 0,
    }));
    await getMsspStats("http://localhost:3300");
    await getMsspStats("http://localhost:3300");
    await getMsspStats("http://localhost:3300");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns MSSP_STATS_UNKNOWN when the first fetch fails", async () => {
    mockFetch(async () => { throw new Error("connection refused"); });
    const stats = await getMsspStats("http://localhost:3300");
    expect(stats).toEqual(MSSP_STATS_UNKNOWN);
  });

  it("applies a 5-second backoff on fetch failure (does not hammer the server)", async () => {
    const fetchSpy = mockFetch(async () => { throw new Error("boom"); });
    await getMsspStats("http://localhost:3300");
    await getMsspStats("http://localhost:3300");
    await getMsspStats("http://localhost:3300");
    // A storm of crawler DO MSSP requests should share one in-flight
    // fetch, not spawn three concurrent 3-second `fetchWithTimeout`
    // calls. (3s = per-fetch timeout; 5s = backoff between retries.)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("applies the same backoff on non-2xx responses", async () => {
    const fetchSpy = mockFetch(async () => new Response("oops", { status: 500 }));
    await getMsspStats("http://localhost:3300");
    await getMsspStats("http://localhost:3300");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent callers to a single in-flight /stats fetch", async () => {
    // Hold the response until we have queued up multiple concurrent
    // callers, then resolve. Without the in-flight dedupe each caller
    // would pass the TTL guard (msspStatsFetchedAt === 0) and spawn its
    // own fetchWithTimeout call.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchSpy = mockFetch(async () => {
      await gate;
      return jsonResponse({
        players: 7, areas: 1, rooms: 1, objects: 1,
        mobiles: 1, helpfiles: 1, classes: 1, levels: 0,
      });
    });
    const a = getMsspStats("http://localhost:3300");
    const b = getMsspStats("http://localhost:3300");
    const c = getMsspStats("http://localhost:3300");
    release();
    const [sa, sb, sc] = await Promise.all([a, b, c]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sa.players).toBe(7);
    expect(sb).toEqual(sa);
    expect(sc).toEqual(sa);
  });

  it("applies the 5s failure backoff when a fetch fails after a previous success", async () => {
    // Regression: TTL/backoff selection must depend on the *last fetch
    // result*, not on whether the cache happens to equal MSSP_STATS_UNKNOWN.
    // Otherwise a success-then-failure sequence would stick with the 30s
    // success TTL because the last-good snapshot is still in the cache.
    let call = 0;
    const fetchSpy = mockFetch(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          players: 1, areas: 1, rooms: 1, objects: 1,
          mobiles: 1, helpfiles: 1, classes: 1, levels: 0,
        });
      }
      throw new Error("boom");
    });
    vi.useFakeTimers();
    try {
      // First call succeeds.
      const first = await getMsspStats("http://localhost:3300");
      expect(first.players).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // Past the 30s success TTL so the next call attempts a refetch.
      vi.advanceTimersByTime(31_000);
      // Second call fails; cache stays at the last-good snapshot but
      // the *next* backoff should be the short 5s window, not 30s,
      // because the last fetch result was a failure.
      const second = await getMsspStats("http://localhost:3300");
      expect(second.players).toBe(1); // last-good still served
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // 4s after the failure: still within the 5s backoff -> no refetch.
      vi.advanceTimersByTime(4_000);
      await getMsspStats("http://localhost:3300");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // 6s after the failure: past the 5s backoff -> refetch.
      // (If the bug were present, we'd have had to wait 30s here.)
      vi.advanceTimersByTime(2_000);
      await getMsspStats("http://localhost:3300");
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries after the failure backoff window expires", async () => {
    let call = 0;
    const fetchSpy = mockFetch(async () => {
      call += 1;
      if (call === 1) throw new Error("transient");
      return jsonResponse({
        players: 2, areas: 1, rooms: 1, objects: 1,
        mobiles: 1, helpfiles: 1, classes: 1, levels: 0,
      });
    });
    vi.useFakeTimers();
    try {
      await getMsspStats("http://localhost:3300");
      // Within the backoff window: served from UNKNOWN cache, no refetch.
      await getMsspStats("http://localhost:3300");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // Past the 5s backoff: should refetch and pick up the recovered server.
      vi.advanceTimersByTime(5001);
      const stats = await getMsspStats("http://localhost:3300");
      expect(stats.players).toBe(2);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
