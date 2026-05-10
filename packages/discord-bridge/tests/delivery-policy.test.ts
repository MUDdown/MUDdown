import { describe, expect, it } from "vitest";
import {
  GAMEPLAY_DELIVERY_BACKOFF_MS,
  GAMEPLAY_DELIVERY_RETRIES,
  MAX_GAMEPLAY_DELIVERY_BACKOFF_MS,
  MAX_CONSECUTIVE_DELIVERY_FAILURES,
  gameplayDeliveryBackoffMs,
  nextDeliveryFailure,
} from "../src/delivery-policy.js";

describe("delivery-policy constants", () => {
  it("uses expected retry and threshold defaults", () => {
    expect(GAMEPLAY_DELIVERY_RETRIES).toBe(3);
    expect(GAMEPLAY_DELIVERY_BACKOFF_MS).toBe(250);
    expect(MAX_GAMEPLAY_DELIVERY_BACKOFF_MS).toBe(5000);
    expect(MAX_CONSECUTIVE_DELIVERY_FAILURES).toBe(3);
  });
});

describe("gameplayDeliveryBackoffMs", () => {
  it("returns zero for non-positive attempts", () => {
    expect(gameplayDeliveryBackoffMs(0)).toBe(0);
    expect(gameplayDeliveryBackoffMs(-1)).toBe(0);
  });

  it("scales linearly by attempt number", () => {
    expect(gameplayDeliveryBackoffMs(1)).toBe(GAMEPLAY_DELIVERY_BACKOFF_MS * 1);
    expect(gameplayDeliveryBackoffMs(2)).toBe(GAMEPLAY_DELIVERY_BACKOFF_MS * 2);
    expect(gameplayDeliveryBackoffMs(3)).toBe(GAMEPLAY_DELIVERY_BACKOFF_MS * 3);
  });

  it("caps very large attempts at the max backoff", () => {
    expect(gameplayDeliveryBackoffMs(10_000)).toBe(MAX_GAMEPLAY_DELIVERY_BACKOFF_MS);
  });

  it("honours operator-overridden backoff base and cap", () => {
    expect(gameplayDeliveryBackoffMs(1, 100, 500)).toBe(100);
    expect(gameplayDeliveryBackoffMs(3, 100, 500)).toBe(300);
    expect(gameplayDeliveryBackoffMs(6, 100, 500)).toBe(500); // capped at custom max
  });

  it("clamps the first attempt when the cap is below the base", () => {
    // Operator-misconfig case (also rejected at startup by loadConfig's
    // cross-field check, but the helper itself must remain monotonic).
    expect(gameplayDeliveryBackoffMs(1, 100, 50)).toBe(50);
  });
});

describe("nextDeliveryFailure", () => {
  it("increments failure count from undefined", () => {
    expect(nextDeliveryFailure(undefined)).toEqual({
      failures: 1,
      shouldTerminate: false,
    });
  });

  it("increments failure count from zero", () => {
    expect(nextDeliveryFailure(0)).toEqual({
      failures: 1,
      shouldTerminate: false,
    });
  });

  it("requires threshold consecutive failures before termination", () => {
    expect(nextDeliveryFailure(MAX_CONSECUTIVE_DELIVERY_FAILURES - 2)).toEqual({
      failures: MAX_CONSECUTIVE_DELIVERY_FAILURES - 1,
      shouldTerminate: false,
    });
    expect(nextDeliveryFailure(MAX_CONSECUTIVE_DELIVERY_FAILURES - 1)).toEqual({
      failures: MAX_CONSECUTIVE_DELIVERY_FAILURES,
      shouldTerminate: true,
    });
  });

  it("continues terminating when failures already exceed threshold", () => {
    expect(nextDeliveryFailure(3)).toEqual({ failures: 4, shouldTerminate: true });
  });

  it("honours an operator-overridden maxConsecutive threshold", () => {
    expect(nextDeliveryFailure(1, 2)).toEqual({ failures: 2, shouldTerminate: true });
    expect(nextDeliveryFailure(1, 3)).toEqual({ failures: 2, shouldTerminate: false });
  });
});