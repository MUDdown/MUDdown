import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenBucket } from "../src/helpers.js";

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to capacity", () => {
    const bucket = new TokenBucket(5, 1);
    for (let i = 0; i < 5; i++) {
      expect(bucket.consume()).toBe(true);
    }
  });

  it("rejects when bucket is empty", () => {
    const bucket = new TokenBucket(3, 1);
    for (let i = 0; i < 3; i++) {
      bucket.consume();
    }
    expect(bucket.consume()).toBe(false);
  });

  it("refills tokens over time", () => {
    const bucket = new TokenBucket(5, 2); // 2 tokens/sec
    // Drain the bucket
    for (let i = 0; i < 5; i++) {
      bucket.consume();
    }
    expect(bucket.consume()).toBe(false);

    // Advance 1 second — should refill 2 tokens
    vi.advanceTimersByTime(1000);
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(false);
  });

  it("does not exceed capacity on refill", () => {
    const bucket = new TokenBucket(3, 10); // 10 tokens/sec but cap is 3
    // Use 1 token
    bucket.consume();
    // Wait a long time
    vi.advanceTimersByTime(5000);
    // Should still only allow 3 total (capped at capacity)
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(false);
  });

  it("handles partial refill correctly", () => {
    const bucket = new TokenBucket(10, 5); // 5 tokens/sec
    // Drain all
    for (let i = 0; i < 10; i++) {
      bucket.consume();
    }
    // Advance 500ms — should refill 2.5 tokens
    vi.advanceTimersByTime(500);
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(true);
    // Third should fail (0.5 remaining < 1)
    expect(bucket.consume()).toBe(false);
  });

  it("simulates speedwalk burst then steady commands", () => {
    // Realistic config: burst 20, refill 5/sec
    const bucket = new TokenBucket(20, 5);
    // Speedwalk: 15 rapid commands
    for (let i = 0; i < 15; i++) {
      expect(bucket.consume()).toBe(true);
    }
    // 5 remaining in burst
    // 5 remaining + 5 refilled (1s × 5/sec) = 10; well under cap of 20
    vi.advanceTimersByTime(1000);
    // Should have 5 + 5 = 10 tokens
    for (let i = 0; i < 10; i++) {
      expect(bucket.consume()).toBe(true);
    }
    expect(bucket.consume()).toBe(false);
  });

  it("rejects sustained abuse", () => {
    const bucket = new TokenBucket(20, 5);
    // Drain all 20
    for (let i = 0; i < 20; i++) {
      bucket.consume();
    }
    // Try to send 10 commands/sec (double the refill rate)
    // After 1 second, only 5 should be allowed
    vi.advanceTimersByTime(1000);
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (bucket.consume()) allowed++;
    }
    expect(allowed).toBe(5);
  });

  it("throws when capacity is zero", () => {
    expect(() => new TokenBucket(0, 5)).toThrow("capacity must be a positive finite number");
  });

  it("throws on zero refillRate", () => {
    expect(() => new TokenBucket(10, 0)).toThrow("refillRate must be a positive finite number");
  });

  it("throws on negative capacity", () => {
    expect(() => new TokenBucket(-1, 5)).toThrow("capacity must be a positive finite number");
  });

  it("throws on negative refillRate", () => {
    expect(() => new TokenBucket(10, -1)).toThrow("refillRate must be a positive finite number");
  });

  it("throws on Infinity capacity", () => {
    expect(() => new TokenBucket(Infinity, 5)).toThrow("capacity must be a positive finite number");
  });

  it("throws on NaN capacity", () => {
    expect(() => new TokenBucket(NaN, 5)).toThrow("capacity must be a positive finite number");
  });

  it("throws on Infinity refillRate", () => {
    expect(() => new TokenBucket(10, Infinity)).toThrow("refillRate must be a positive finite number");
  });

  it("throws on NaN refillRate", () => {
    expect(() => new TokenBucket(10, NaN)).toThrow("refillRate must be a positive finite number");
  });
});
