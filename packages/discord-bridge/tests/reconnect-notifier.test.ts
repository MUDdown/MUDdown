import { describe, expect, it } from "vitest";

import { ReconnectNotifier } from "../src/reconnect-notifier.js";

describe("ReconnectNotifier", () => {
  it("returns true the first time a user enters a reconnecting state", () => {
    const notifier = new ReconnectNotifier();
    expect(notifier.markReconnecting("user-a")).toBe(true);
  });

  it("returns false on repeated reconnecting marks within the same cycle", () => {
    const notifier = new ReconnectNotifier();
    notifier.markReconnecting("user-a");
    expect(notifier.markReconnecting("user-a")).toBe(false);
    expect(notifier.markReconnecting("user-a")).toBe(false);
  });

  it("tracks reconnecting state per user independently", () => {
    const notifier = new ReconnectNotifier();
    expect(notifier.markReconnecting("user-a")).toBe(true);
    expect(notifier.markReconnecting("user-b")).toBe(true);
    expect(notifier.markReconnecting("user-a")).toBe(false);
  });

  it("returns false from markConnected when the user was not reconnecting (initial connect)", () => {
    const notifier = new ReconnectNotifier();
    expect(notifier.markConnected("user-a")).toBe(false);
  });

  it("returns true from markConnected exactly once after a reconnecting mark", () => {
    const notifier = new ReconnectNotifier();
    notifier.markReconnecting("user-a");
    expect(notifier.markConnected("user-a")).toBe(true);
    expect(notifier.markConnected("user-a")).toBe(false);
  });

  it("resets to a fresh cycle after markConnected, allowing a new reconnecting mark", () => {
    const notifier = new ReconnectNotifier();
    notifier.markReconnecting("user-a");
    notifier.markConnected("user-a");
    expect(notifier.markReconnecting("user-a")).toBe(true);
  });

  it("forget removes pending state so the next markConnected returns false", () => {
    const notifier = new ReconnectNotifier();
    notifier.markReconnecting("user-a");
    notifier.forget("user-a");
    expect(notifier.markConnected("user-a")).toBe(false);
  });

  it("forget on an unknown user is a no-op", () => {
    const notifier = new ReconnectNotifier();
    expect(() => notifier.forget("nobody")).not.toThrow();
  });

  it("clear drops state for all users", () => {
    const notifier = new ReconnectNotifier();
    notifier.markReconnecting("user-a");
    notifier.markReconnecting("user-b");
    notifier.clear();
    expect(notifier.size()).toBe(0);
    expect(notifier.markConnected("user-a")).toBe(false);
    expect(notifier.markConnected("user-b")).toBe(false);
  });

  it("size reflects the number of users currently reconnecting", () => {
    const notifier = new ReconnectNotifier();
    expect(notifier.size()).toBe(0);
    notifier.markReconnecting("user-a");
    notifier.markReconnecting("user-b");
    expect(notifier.size()).toBe(2);
    notifier.markConnected("user-a");
    expect(notifier.size()).toBe(1);
  });
});
