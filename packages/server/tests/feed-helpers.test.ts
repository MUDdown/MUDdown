import { describe, it, expect } from "vitest";
import { getClientIp, canAcceptFeedConnection } from "../src/helpers.js";

describe("getClientIp", () => {
  it("returns socket peer when trustProxy is false", () => {
    expect(getClientIp({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.1", false)).toBe("10.0.0.1");
  });

  it("returns the rightmost X-Forwarded-For entry when trustProxy is true", () => {
    // The reverse-proxy hop is the LAST entry; earlier entries are
    // client-supplied and therefore untrusted.
    expect(
      getClientIp({ "x-forwarded-for": "client-spoofed, 198.51.100.1, 10.0.0.5" }, "127.0.0.1", true),
    ).toBe("10.0.0.5");
  });

  it("falls back to socket peer when X-Forwarded-For is missing even with trustProxy", () => {
    expect(getClientIp({}, "10.0.0.1", true)).toBe("10.0.0.1");
  });

  it("falls back to socket peer when X-Forwarded-For is empty/whitespace", () => {
    expect(getClientIp({ "x-forwarded-for": "  ,  ," }, "10.0.0.1", true)).toBe("10.0.0.1");
  });

  it("handles X-Forwarded-For provided as an array", () => {
    expect(
      getClientIp({ "x-forwarded-for": ["198.51.100.1", "10.0.0.5"] }, "127.0.0.1", true),
    ).toBe("10.0.0.5");
  });

  it("returns 'unknown' when no address can be resolved", () => {
    expect(getClientIp({}, undefined, false)).toBe("unknown");
    expect(getClientIp({ "x-forwarded-for": "" }, "", false)).toBe("unknown");
  });
});

describe("canAcceptFeedConnection", () => {
  it("admits a fresh connection under both caps", () => {
    expect(canAcceptFeedConnection("1.2.3.4", new Map(), 0, 4, 100)).toEqual({ ok: true });
  });

  it("rejects when the global cap is reached", () => {
    expect(canAcceptFeedConnection("1.2.3.4", new Map(), 100, 4, 100)).toEqual({
      ok: false,
      reason: "global-cap",
    });
  });

  it("rejects when the per-IP cap is reached", () => {
    const counts = new Map([["1.2.3.4", 4]]);
    expect(canAcceptFeedConnection("1.2.3.4", counts, 50, 4, 100)).toEqual({
      ok: false,
      reason: "per-ip-cap",
    });
  });

  it("checks global cap before per-IP cap", () => {
    // When both caps would be exceeded, surface the global reason — it's the
    // more important operational signal (whole instance is saturated, not
    // just one client).
    const counts = new Map([["1.2.3.4", 4]]);
    expect(canAcceptFeedConnection("1.2.3.4", counts, 100, 4, 100)).toEqual({
      ok: false,
      reason: "global-cap",
    });
  });

  it("treats a missing per-IP entry as zero", () => {
    const counts = new Map([["other", 99]]);
    expect(canAcceptFeedConnection("fresh", counts, 99, 4, 100)).toEqual({ ok: true });
  });

  it("admits exactly at one-below-cap and rejects at the cap", () => {
    const counts = new Map([["1.2.3.4", 3]]);
    expect(canAcceptFeedConnection("1.2.3.4", counts, 50, 4, 100)).toEqual({ ok: true });
    counts.set("1.2.3.4", 4);
    expect(canAcceptFeedConnection("1.2.3.4", counts, 50, 4, 100)).toEqual({
      ok: false,
      reason: "per-ip-cap",
    });
  });

  it("admits exactly at one-below the global cap and rejects at the global cap", () => {
    expect(canAcceptFeedConnection("1.2.3.4", new Map(), 99, 4, 100)).toEqual({ ok: true });
    expect(canAcceptFeedConnection("1.2.3.4", new Map(), 100, 4, 100)).toEqual({
      ok: false,
      reason: "global-cap",
    });
  });

  it("treats non-positive caps as 'no limit' rather than deny-all", () => {
    const counts = new Map([["1.2.3.4", 9999]]);
    // capTotal <= 0 → global cap disabled
    expect(canAcceptFeedConnection("fresh", new Map(), 1_000_000, 4, 0)).toEqual({ ok: true });
    expect(canAcceptFeedConnection("fresh", new Map(), 1_000_000, 4, -1)).toEqual({ ok: true });
    // capPerIp <= 0 → per-IP cap disabled
    expect(canAcceptFeedConnection("1.2.3.4", counts, 50, 0, 100)).toEqual({ ok: true });
    expect(canAcceptFeedConnection("1.2.3.4", counts, 50, -1, 100)).toEqual({ ok: true });
    // Both disabled → admits regardless of counts
    expect(canAcceptFeedConnection("1.2.3.4", counts, 1_000_000, 0, 0)).toEqual({ ok: true });
  });
});
