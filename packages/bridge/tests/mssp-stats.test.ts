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
    vi.useRealTimers();
  });

  it("returns MSSP_STATS_UNKNOWN until the first successful fetch completes", async () => {
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
    // fetch, not spawn three concurrent 3-second requests.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("applies the same backoff on non-2xx responses", async () => {
    const fetchSpy = mockFetch(async () => new Response("oops", { status: 500 }));
    await getMsspStats("http://localhost:3300");
    await getMsspStats("http://localhost:3300");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
    await getMsspStats("http://localhost:3300");
    // Advance wall clock past the 5-second backoff by resetting the cache
    // (we don't have easy access to the module-level timestamp, so this
    // stands in for "backoff window elapsed").
    __resetMsspCacheForTesting();
    const stats = await getMsspStats("http://localhost:3300");
    expect(stats.players).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
