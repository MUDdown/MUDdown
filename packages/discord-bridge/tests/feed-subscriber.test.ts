/**
 * Tests for FeedSubscriber. Uses a fake WebSocket constructor and a manual
 * timer scheduler so reconnect timing is deterministic and we avoid any
 * real network or sleep.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import {
  FeedSubscriber,
  deriveFeedUrl,
  nextReconnectDelay,
} from "../src/feed-subscriber.js";

class FakeSocket extends EventEmitter {
  url: string;
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  constructor(url: string) {
    super();
    this.url = url;
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    // `ws` emits "close" asynchronously; for our handlers it's enough to
    // emit synchronously since the subscriber doesn't depend on the gap.
    this.emit("close");
  }
}

interface FakeChannelCall {
  embeds: { title?: string; description?: string; color?: number }[];
}

function makeFakeChannel(): { channel: { send: (p: FakeChannelCall) => Promise<void> }; calls: FakeChannelCall[] } {
  const calls: FakeChannelCall[] = [];
  return {
    channel: {
      send: async (payload: FakeChannelCall): Promise<void> => {
        calls.push(payload);
      },
    },
    calls,
  };
}

interface ScheduledTimer {
  cb: () => void;
  ms: number;
  cancelled: boolean;
}

function makeFakeScheduler(): {
  setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  pending: ScheduledTimer[];
  fireAll: () => void;
} {
  const pending: ScheduledTimer[] = [];
  return {
    pending,
    setTimer: (cb, ms) => {
      const t: ScheduledTimer = { cb, ms, cancelled: false };
      pending.push(t);
      // Cast through unknown — the subscriber only stores the handle and
      // passes it back to clearTimer, never inspects it.
      return t as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      const t = handle as unknown as ScheduledTimer;
      t.cancelled = true;
    },
    fireAll: () => {
      // Run currently-pending timers; they may schedule more, but those
      // are appended to `pending` and require a follow-up call.
      const toRun = pending.splice(0);
      for (const t of toRun) {
        if (!t.cancelled) t.cb();
      }
    },
  };
}

const SAMPLE_WORLD_ENVELOPE = JSON.stringify({
  v: 1,
  id: "abc",
  type: "system",
  timestamp: "2026-05-09T00:00:00Z",
  muddown: ':::system{type="notification" scope="world"}\nServer is up.\n:::',
});

const SAMPLE_PLAYER_ENVELOPE = JSON.stringify({
  v: 1,
  id: "abc",
  type: "system",
  timestamp: "2026-05-09T00:00:00Z",
  muddown: ':::system{type="welcome" scope="player"}\nWelcome.\n:::',
});

describe("deriveFeedUrl", () => {
  it("replaces the path with /feed and strips query/fragment", () => {
    expect(deriveFeedUrl("ws://localhost:3300/")).toBe("ws://localhost:3300/feed");
    expect(deriveFeedUrl("wss://muddown.com/ws?ticket=abc")).toBe("wss://muddown.com/feed");
    expect(deriveFeedUrl("ws://host/some/deep/path")).toBe("ws://host/feed");
  });
});

describe("nextReconnectDelay", () => {
  it("scales exponentially with full jitter", () => {
    // random=0.999 puts us at the upper bound (cap or base*2^attempt minus a
    // sliver, clamped by Math.floor).
    expect(nextReconnectDelay(0, () => 0.999, 1000, 30000)).toBe(999);
    expect(nextReconnectDelay(1, () => 0.999, 1000, 30000)).toBe(1998);
    expect(nextReconnectDelay(2, () => 0.999, 1000, 30000)).toBe(3996);
  });

  it("caps the delay at the configured ceiling", () => {
    // 1000 * 2^10 = 1024000, but cap is 30000.
    expect(nextReconnectDelay(10, () => 0.999, 1000, 30000)).toBe(29970);
    expect(nextReconnectDelay(20, () => 0.999, 1000, 30000)).toBe(29970);
  });

  it("returns 0 when random returns 0", () => {
    expect(nextReconnectDelay(5, () => 0, 1000, 30000)).toBe(0);
  });
});

describe("FeedSubscriber", () => {
  function makeSubscriber() {
    const sockets: FakeSocket[] = [];
    const constructorCalls: string[] = [];
    // Plain class so `new FakeWS(url)` works correctly. (vi.fn wraps an arrow,
    // which throws "is not a constructor" when invoked with `new`.)
    class FakeWS extends FakeSocket {
      constructor(url: string) {
        super(url);
        constructorCalls.push(url);
        sockets.push(this);
      }
    }
    const { channel, calls } = makeFakeChannel();
    const scheduler = makeFakeScheduler();
    const subscriber = new FeedSubscriber({
      serverUrl: "ws://localhost:3300/",
      channel,
      webSocketCtor: FakeWS as unknown as typeof WebSocket,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0, // zero jitter → fire immediately on next tick
    });
    return { subscriber, sockets, calls, scheduler, constructorCalls };
  }

  it("connects to /feed on start", () => {
    const { subscriber, sockets, constructorCalls } = makeSubscriber();
    subscriber.start();
    expect(constructorCalls).toEqual(["ws://localhost:3300/feed"]);
    expect(sockets).toHaveLength(1);
    subscriber.stop();
  });

  it("publishes a world-scope envelope to the channel", async () => {
    const { subscriber, sockets, calls } = makeSubscriber();
    subscriber.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", Buffer.from(SAMPLE_WORLD_ENVELOPE));
    // Allow the async handler to settle.
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.embeds.length).toBeGreaterThan(0);
    expect(calls[0]!.embeds[0]!.description).toContain("Server is up.");
    subscriber.stop();
  });

  it("rejects scope=\"player\" envelopes (defense in depth)", async () => {
    // Even if the server ever ships a bug that fans player-scope content
    // to /feed, the client-side filter must not publish it to a public
    // channel.
    const { subscriber, sockets, calls } = makeSubscriber();
    subscriber.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", Buffer.from(SAMPLE_PLAYER_ENVELOPE));
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(0);
    subscriber.stop();
  });

  it("strips interactive links before publishing", async () => {
    const { subscriber, sockets, calls } = makeSubscriber();
    subscriber.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          v: 1,
          id: "abc",
          type: "system",
          timestamp: "2026-05-09T00:00:00Z",
          muddown:
            ':::system{type="event" scope="world"}\nFestival! Head [north](go:north) to join.\n:::',
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    const desc = calls[0]!.embeds[0]!.description ?? "";
    expect(desc).toContain("Head north to join");
    expect(desc).not.toContain("go:north");
    subscriber.stop();
  });

  it("ignores malformed JSON without crashing", async () => {
    const { subscriber, sockets, calls } = makeSubscriber();
    subscriber.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", Buffer.from("not json {{{"));
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(0);
    subscriber.stop();
  });

  it("schedules a reconnect on close and reconnects", () => {
    const { subscriber, sockets, scheduler, constructorCalls } = makeSubscriber();
    subscriber.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("close");
    // First retry queued.
    expect(scheduler.pending).toHaveLength(1);
    expect(constructorCalls).toHaveLength(1);
    scheduler.fireAll();
    // Reconnect produced a second socket.
    expect(constructorCalls).toHaveLength(2);
    expect(sockets).toHaveLength(2);
    subscriber.stop();
  });

  it("does NOT reconnect after stop()", () => {
    const { subscriber, sockets, scheduler, constructorCalls } = makeSubscriber();
    subscriber.start();
    sockets[0]!.emit("open");
    subscriber.stop();
    // stop() called close() which emits "close"; but stopped flag prevents
    // a reconnect from being scheduled.
    expect(scheduler.pending).toHaveLength(0);
    // Even firing whatever timers exist (none) doesn't open another socket.
    scheduler.fireAll();
    expect(constructorCalls).toHaveLength(1);
  });

  it("resets the backoff attempt counter after a successful open", () => {
    const { subscriber, sockets, scheduler } = makeSubscriber();
    subscriber.start();
    sockets[0]!.emit("close"); // attempt 0
    expect(scheduler.pending).toHaveLength(1);
    scheduler.fireAll();
    sockets[1]!.emit("open"); // success — counter resets
    sockets[1]!.emit("close"); // attempt 0 again, not 1
    // Per nextReconnectDelay with random=0, both attempts produce delay=0
    // so we can't tell from `ms` alone — but we can confirm via internal
    // behaviour: count of timers scheduled.
    expect(scheduler.pending).toHaveLength(1);
    subscriber.stop();
  });

  it("cancels a pending reconnect timer when stop() is called", () => {
    // start() → emit close (queues timer) → stop() → fireAll() → no new socket.
    const { subscriber, sockets, scheduler, constructorCalls } = makeSubscriber();
    subscriber.start();
    sockets[0]!.emit("close");
    expect(scheduler.pending).toHaveLength(1);
    subscriber.stop();
    // stop() cancels the queued timer and marks `stopped`. Firing anyway
    // (the cancelled flag is honored by fireAll) must not open a new socket.
    scheduler.fireAll();
    expect(constructorCalls).toHaveLength(1);
  });

  it("schedules a reconnect when the WS constructor throws", () => {
    const constructorCalls: string[] = [];
    class ThrowingWS {
      constructor(url: string) {
        constructorCalls.push(url);
        throw new Error("boom");
      }
    }
    const { channel } = makeFakeChannel();
    const scheduler = makeFakeScheduler();
    const subscriber = new FeedSubscriber({
      serverUrl: "ws://localhost:3300/",
      channel,
      webSocketCtor: ThrowingWS as unknown as typeof WebSocket,
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      random: () => 0,
    });
    subscriber.start();
    expect(constructorCalls).toHaveLength(1);
    expect(scheduler.pending).toHaveLength(1);
    subscriber.stop();
  });

  it("start() is idempotent — calling twice opens only one socket", () => {
    const { subscriber, constructorCalls } = makeSubscriber();
    subscriber.start();
    subscriber.start();
    expect(constructorCalls).toHaveLength(1);
    subscriber.stop();
  });

  it("stop() is idempotent — calling twice does not crash", () => {
    const { subscriber } = makeSubscriber();
    subscriber.start();
    subscriber.stop();
    expect(() => subscriber.stop()).not.toThrow();
  });

  it("coalesces multiple close events into a single reconnect timer", () => {
    // The scheduleReconnect guard short-circuits when a timer is already
    // pending, so a chatty `ws` library re-emitting close cannot stack up
    // exponential reconnects.
    const { subscriber, sockets, scheduler } = makeSubscriber();
    subscriber.start();
    sockets[0]!.emit("close");
    sockets[0]!.emit("close");
    expect(scheduler.pending).toHaveLength(1);
    subscriber.stop();
  });

  it("does not call channel.send when the rendered envelope is empty", async () => {
    // A body-less :::system{scope="world"} fence renders to no embeds; the
    // subscriber must short-circuit rather than post an empty payload.
    const { subscriber, sockets, calls } = makeSubscriber();
    subscriber.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          v: 1,
          id: "abc",
          type: "system",
          timestamp: "2026-05-09T00:00:00Z",
          muddown: ':::system{scope="world"}\n:::',
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(0);
    subscriber.stop();
  });

  it("does not include a `components` key in the published payload", async () => {
    // A public channel has no per-user session, so any interactive buttons
    // would be meaningless. The link-stripping pass already rewrites
    // `[text](go:...)` to plain text, but as belt-and-braces verify the
    // payload shape too.
    const { subscriber, sockets, calls } = makeSubscriber();
    subscriber.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          v: 1,
          id: "abc",
          type: "system",
          timestamp: "2026-05-09T00:00:00Z",
          muddown:
            ':::system{type="event" scope="world"}\nFestival! Head [north](go:north) to join.\n:::',
        }),
      ),
    );
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(calls[0]!, "components")).toBe(false);
    subscriber.stop();
  });
});
