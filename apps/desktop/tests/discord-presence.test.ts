import { describe, expect, it, vi } from "vitest";
import {
  buildPresencePayload,
  createPresenceScheduler,
  parseRoomPresence,
} from "../src/discord-presence.js";
import type { TestablePresenceScheduler } from "../src/discord-presence.js";

const ROOM_FIXTURE = `:::room{id="town-square" region="greenhaven" lighting="bright"}
# Town Square

A wide cobblestone plaza bordered by lantern posts.
:::`;

const ROOM_NO_LIGHTING = `:::room{id="cellar" region="greenhaven"}
# Damp Cellar

The air is heavy with mildew.
:::`;

const SECOND_ROOM = `:::room{id="market" region="greenhaven" lighting="bright"}
# Market Stalls

Vendors hawk wares from striped awnings.
:::`;

describe("parseRoomPresence", () => {
  it("extracts region and title from a room envelope", () => {
    expect(parseRoomPresence(ROOM_FIXTURE)).toEqual({
      region: "greenhaven",
      title: "Town Square",
    });
  });

  it("parses rooms regardless of optional attributes like lighting", () => {
    const parsed = parseRoomPresence(ROOM_NO_LIGHTING);
    expect(parsed).toEqual({ region: "greenhaven", title: "Damp Cellar" });
  });

  it("returns null for non-room envelopes", () => {
    const system = `:::system{type="info"}
A bell rings somewhere.
:::`;
    expect(parseRoomPresence(system)).toBeNull();
  });

  it("returns null when the room body has no H1 title", () => {
    const titleless = `:::room{id="void" region="nowhere"}

Just a paragraph with no heading.
:::`;
    expect(parseRoomPresence(titleless)).toBeNull();
  });

  it("defaults region to 'Unknown' when the attribute is missing", () => {
    const noRegion = `:::room{id="foo"}
# Foo

Body.
:::`;
    expect(parseRoomPresence(noRegion)).toEqual({
      region: "Unknown",
      title: "Foo",
    });
  });
});

describe("buildPresencePayload", () => {
  it("formats the activity payload from a parsed room", () => {
    expect(
      buildPresencePayload({ region: "greenhaven", title: "Town Square" }),
    ).toEqual({
      details: "Exploring greenhaven",
      stateText: "Town Square",
      largeText: "MUDdown — open Markdown MUD platform",
    });
  });
});

interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  pending: () => number;
}

function makeFakeClock(): FakeClock {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; cb: () => void }>();
  const setTimeoutFn = (cb: () => void, ms: number): number => {
    const id = nextId++;
    timers.set(id, { fireAt: t + ms, cb });
    return id;
  };
  const clearTimeoutFn = (id: number): void => {
    timers.delete(id);
  };
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      // Fire timers whose deadline has passed, in order.
      const due = [...timers.entries()]
        .filter(([, v]) => v.fireAt <= t)
        .sort((a, b) => a[1].fireAt - b[1].fireAt);
      for (const [id, v] of due) {
        timers.delete(id);
        v.cb();
      }
    },
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    pending: () => timers.size,
  };
}

describe("createPresenceScheduler", () => {
  it("fires immediately on the leading edge", () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const clock = makeFakeClock();
    const s = createPresenceScheduler({
      invoke,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    s.schedule(ROOM_FIXTURE);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("discord_presence_update", {
      details: "Exploring greenhaven",
      stateText: "Town Square",
      largeText: "MUDdown — open Markdown MUD platform",
    });
  });

  it("queues a single trailing flush and coalesces rapid room transitions", () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const clock = makeFakeClock();
    const s = createPresenceScheduler({
      invoke,
      debounceMs: 15_000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    // Leading-edge fire.
    s.schedule(ROOM_FIXTURE);
    expect(invoke).toHaveBeenCalledTimes(1);

    // Three more rooms inside the 15 s window — only the latest should be
    // flushed when the timer fires.
    clock.advance(2_000);
    s.schedule(SECOND_ROOM);
    clock.advance(2_000);
    s.schedule(ROOM_FIXTURE);
    clock.advance(2_000);
    s.schedule(SECOND_ROOM);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(1);

    // Advance past the debounce floor — exactly one trailing flush, with the
    // most recent room's payload.
    clock.advance(15_000);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("discord_presence_update", {
      details: "Exploring greenhaven",
      stateText: "Market Stalls",
      largeText: "MUDdown — open Markdown MUD platform",
    });
  });

  it("ignores envelopes that aren't rooms", () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const clock = makeFakeClock();
    const s = createPresenceScheduler({
      invoke,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    s.schedule(`:::system{type="info"}\nHello.\n:::`);
    expect(invoke).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it("clear() invokes discord_presence_clear and drops pending state", () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const clock = makeFakeClock();
    const s = createPresenceScheduler({
      invoke,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    s.schedule(ROOM_FIXTURE); // leading-edge update
    clock.advance(1_000);
    s.schedule(SECOND_ROOM); // queued flush
    expect(clock.pending()).toBe(1);

    s.clear();
    expect(invoke).toHaveBeenLastCalledWith("discord_presence_clear");
    expect(clock.pending()).toBe(0);

    // After clear, lastSentAt resets to 0, so the very next schedule should
    // fire immediately again rather than re-queueing.
    s.schedule(ROOM_FIXTURE);
    expect(invoke).toHaveBeenLastCalledWith("discord_presence_update", expect.any(Object));
  });

  it("forwards invoke errors to the onError callback (no-Discord fallback)", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("Discord not running"));
    const clock = makeFakeClock();
    const onError = vi.fn();
    const s = createPresenceScheduler({
      invoke,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onError,
    });
    s.schedule(ROOM_FIXTURE);
    // Let the rejected promise settle (two microtask hops: invoke() → .catch).
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith("update", expect.any(Error));
  });

  it("does not advance lastSentAt when the update IPC fails", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("Discord not running"))
      .mockResolvedValue(undefined);
    const clock = makeFakeClock();
    const s = createPresenceScheduler({
      invoke,
      debounceMs: 15_000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onError: () => {},
    });
    s.schedule(ROOM_FIXTURE); // leading-edge — invoke #1, rejects
    await Promise.resolve();
    await Promise.resolve();
    // Without rolling lastSentAt back, the next schedule inside the window
    // would queue a trailing flush instead of firing immediately.
    s.schedule(SECOND_ROOM);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("discord_presence_update", {
      details: "Exploring greenhaven",
      stateText: "Market Stalls",
      largeText: "MUDdown — open Markdown MUD platform",
    });
    expect(clock.pending()).toBe(0);
  });

  it("forwards invoke errors from clear() to the onError callback", async () => {
    const invoke = vi.fn().mockImplementation((cmd: string) => {
      return cmd === "discord_presence_clear"
        ? Promise.reject(new Error("clear failed"))
        : Promise.resolve(undefined);
    });
    const clock = makeFakeClock();
    const onError = vi.fn();
    const s = createPresenceScheduler({
      invoke,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onError,
    });
    s.clear();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith("clear", expect.any(Error));
  });

  it("clear() cancels a pending trailing-flush timer", () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const clock = makeFakeClock();
    const s = createPresenceScheduler({
      invoke,
      debounceMs: 15_000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    s.schedule(ROOM_FIXTURE); // leading-edge update
    clock.advance(1_000);
    s.schedule(SECOND_ROOM); // queues trailing flush
    expect(clock.pending()).toBe(1);
    expect(invoke).toHaveBeenCalledTimes(1); // only the leading edge so far

    s.clear();
    const callsAfterClear = invoke.mock.calls.length;
    clock.advance(60_000); // would have fired the trailing flush
    expect(invoke.mock.calls.length).toBe(callsAfterClear); // no phantom flush
  });

  it("flushForTesting() drains a pending trailing flush immediately", () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const clock = makeFakeClock();
    const s = createPresenceScheduler({
      invoke,
      debounceMs: 15_000,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    }) as TestablePresenceScheduler;
    s.schedule(ROOM_FIXTURE); // leading-edge
    clock.advance(1_000);
    s.schedule(SECOND_ROOM); // queued
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(1);

    s.flushForTesting();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("discord_presence_update", {
      details: "Exploring greenhaven",
      stateText: "Market Stalls",
      largeText: "MUDdown — open Markdown MUD platform",
    });
    expect(clock.pending()).toBe(0);
  });
});
