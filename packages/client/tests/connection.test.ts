import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WS_CLOSE_QUIT, WS_CLOSE_DISPLACED } from "@muddown/shared";
import { buildWsUrl, MUDdownConnection } from "../src/connection.js";

describe("buildWsUrl", () => {
  it("converts http to ws", () => {
    expect(buildWsUrl("http://localhost:3300")).toBe("ws://localhost:3300/ws");
  });

  it("converts https to wss", () => {
    expect(buildWsUrl("https://example.com")).toBe("wss://example.com/ws");
  });

  it("accepts a custom path", () => {
    expect(buildWsUrl("http://localhost:3300", "/game")).toBe("ws://localhost:3300/game");
  });

  it("preserves port in the URL", () => {
    expect(buildWsUrl("http://localhost:8080")).toBe("ws://localhost:8080/ws");
  });

  it("ignores input path and uses only host", () => {
    expect(buildWsUrl("http://localhost:3300/api")).toBe("ws://localhost:3300/ws");
  });

  it("ignores trailing slash on input", () => {
    expect(buildWsUrl("http://localhost:8080/")).toBe("ws://localhost:8080/ws");
  });

  it("throws on invalid URL input", () => {
    expect(() => buildWsUrl("not-a-url")).toThrow();
  });

  it("passes through ws: protocol unchanged", () => {
    expect(buildWsUrl("ws://localhost:3300")).toBe("ws://localhost:3300/ws");
  });

  it("passes through wss: protocol unchanged", () => {
    expect(buildWsUrl("wss://example.com")).toBe("wss://example.com/ws");
  });

  it("throws on unsupported protocol", () => {
    expect(() => buildWsUrl("ftp://example.com")).toThrow("Unsupported protocol");
  });
});

// ── MUDdownConnection tests ─────────────────────────────────────────

/** Minimal mock WebSocket that exposes handler triggers. */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static readonly instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Simulate async open
    queueMicrotask(() => this.onopen?.(new Event("open")));
  }

  send(data: string) { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; }

  // Test helpers
  simulateMessage(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  simulateClose(code = 1000) {
    const event = { type: "close", code, reason: "", wasClean: true } as CloseEvent;
    this.onclose?.(event);
  }
  simulateError() {
    this.onerror?.(new Event("error"));
  }
}

describe("MUDdownConnection", () => {
  let origWebSocket: typeof globalThis.WebSocket;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    origWebSocket = globalThis.WebSocket;
    // @ts-expect-error — mock WebSocket
    globalThis.WebSocket = MockWebSocket;
    MockWebSocket.instances.length = 0;
    vi.useFakeTimers();
    // Silence the constructor "no onReconnecting handler" warning and the
    // session-downgrade error log. Most tests in this file exercise those
    // paths intentionally; their own observability is covered by dedicated
    // tests below.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.WebSocket = origWebSocket;
    vi.useRealTimers();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("fires onOpen when connected", async () => {
    const onOpen = vi.fn();
    const conn = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, { onOpen });
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(onOpen).toHaveBeenCalledOnce();
    conn.dispose();
  });

  it("appends ticket to URL when provided", async () => {
    const conn = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, {});
    conn.connect("abc123");
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWebSocket.instances[0].url).toBe("ws://localhost:3300/ws?ticket=abc123");
    conn.dispose();
  });

  it("routes regular messages to onMessage", async () => {
    const onMessage = vi.fn();
    const conn = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, { onMessage });
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    const msg = JSON.stringify({
      v: 1, id: "1", type: "room", timestamp: new Date().toISOString(),
      muddown: "# Town Square\nYou are here.",
    });
    MockWebSocket.instances[0].simulateMessage(msg);

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0]).toBe("# Town Square\nYou are here.");
    expect(onMessage.mock.calls[0][1]).toBe("room");
    conn.dispose();
  });

  it("routes hint blocks to onHint", async () => {
    const onHint = vi.fn();
    const conn = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, { onHint });
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    const msg = JSON.stringify({
      v: 1, id: "2", type: "system", timestamp: new Date().toISOString(),
      muddown: ':::system{type="hint"}\nTry looking around.\n:::',
    });
    MockWebSocket.instances[0].simulateMessage(msg);

    expect(onHint).toHaveBeenCalledOnce();
    expect(onHint.mock.calls[0][0].hint).toBe("Try looking around.");
    conn.dispose();
  });

  it("routes inventory state to onInventory", async () => {
    const onInventory = vi.fn();
    const conn = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, { onInventory });
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    const msg = JSON.stringify({
      v: 1, id: "3", type: "system", timestamp: new Date().toISOString(),
      muddown: "Inventory updated.",
      meta: { inventoryState: { items: [], equipped: {} } },
    });
    MockWebSocket.instances[0].simulateMessage(msg);

    expect(onInventory).toHaveBeenCalledOnce();
    expect(onInventory.mock.calls[0][0]).toEqual({ items: [], equipped: {} });
    conn.dispose();
  });

  it("fires onParseError for invalid JSON", async () => {
    const onParseError = vi.fn();
    const conn = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, { onParseError });
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateMessage("not valid json");

    expect(onParseError).toHaveBeenCalledOnce();
    expect(onParseError.mock.calls[0][0]).toBe("not valid json");
    conn.dispose();
  });

  it("fires onParseError when muddown field is missing", async () => {
    const onParseError = vi.fn();
    const conn = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, { onParseError });
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateMessage(JSON.stringify({ v: 1, id: "x", type: "room" }));

    expect(onParseError).toHaveBeenCalledOnce();
    conn.dispose();
  });

  it("send() returns false when not connected", () => {
    const conn = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, {});
    expect(conn.send("look")).toBe(false);
    conn.dispose();
  });

  it("send() writes a wire protocol envelope", async () => {
    const conn = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, {});
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    const result = conn.send("go north");
    expect(result).toBe(true);

    const ws = MockWebSocket.instances[0];
    expect(ws.sent).toHaveLength(1);
    const envelope = JSON.parse(ws.sent[0]);
    expect(envelope.v).toBe(1);
    expect(envelope.type).toBe("command");
    expect(envelope.command).toBe("go north");
    expect(envelope.id).toBeDefined();
    expect(envelope.timestamp).toBeDefined();
    conn.dispose();
  });

  it("schedules reconnect on close when autoReconnect is true", async () => {
    const onClose = vi.fn();
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 1000 },
      { onClose },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateClose();
    expect(onClose).toHaveBeenCalledWith(true);

    // Advance past reconnect delay — a new WebSocket should be created
    const countBefore = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances.length).toBe(countBefore + 1);
    conn.dispose();
  });

  it("does not reconnect when autoReconnect is false", async () => {
    const onClose = vi.fn();
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", autoReconnect: false },
      { onClose },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateClose();
    expect(onClose).toHaveBeenCalledWith(false);

    const countBefore = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockWebSocket.instances.length).toBe(countBefore);
    conn.dispose();
  });

  it("dispose() prevents further reconnects", async () => {
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      {},
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    conn.dispose();
    expect(conn.connected).toBe(false);

    // Advance timers — no new connections should be made
    const countAfterDispose = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockWebSocket.instances.length).toBe(countAfterDispose);
  });

  it("does not reconnect when server closes with code 4001 (quit)", async () => {
    const onClose = vi.fn();
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 1000 },
      { onClose },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateClose(WS_CLOSE_QUIT);
    expect(onClose).toHaveBeenCalledWith(false);

    const countBefore = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockWebSocket.instances.length).toBe(countBefore);
    conn.dispose();
  });

  it("does not reconnect when server closes with code 4002 (displaced) and fires onDisplaced instead of onClose", async () => {
    const onClose = vi.fn();
    const onDisplaced = vi.fn();
    const onReconnecting = vi.fn();
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      { onClose, onDisplaced, onReconnecting },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateClose(WS_CLOSE_DISPLACED);
    // Displaced fires onDisplaced *instead of* onClose so consumers that
    // wire both don't double-notify the player (e.g. "Disconnected." and
    // then "You were displaced.")
    expect(onClose).not.toHaveBeenCalled();
    expect(onDisplaced).toHaveBeenCalledOnce();

    const countBefore = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockWebSocket.instances.length).toBe(countBefore);
    expect(onReconnecting).not.toHaveBeenCalled();
    conn.dispose();
  });

  it("suppresses reconnect on WS_CLOSE_DISPLACED even when onDisplaced is not wired", async () => {
    // The reconnect-suppression contract must live in the close-code
    // handling, not in the user-facing callback — otherwise a consumer
    // that forgets to wire onDisplaced gets the ping-pong loop back.
    const onReconnecting = vi.fn();
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      { onReconnecting },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateClose(WS_CLOSE_DISPLACED);

    const countBefore = MockWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockWebSocket.instances.length).toBe(countBefore);
    expect(onReconnecting).not.toHaveBeenCalled();
    conn.dispose();
  });

  it("can be reclaimed via connect() after displacement", async () => {
    // Displacement does not dispose the instance — a consumer can call
    // connect() with a fresh ticket to claim the character back. This
    // pins that contract so a future accidental `this.disposed = true`
    // in the displaced branch wouldn't silently break reclaim.
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateClose(WS_CLOSE_DISPLACED);
    const countAfterDisplace = MockWebSocket.instances.length;

    conn.connect("reclaim-ticket");
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWebSocket.instances.length).toBe(countAfterDisplace + 1);
    expect(MockWebSocket.instances[countAfterDisplace].url).toContain("ticket=reclaim-ticket");
    conn.dispose();
  });

  it("logs but does not throw when onDisplaced handler itself throws", async () => {
    errSpy.mockClear();
    const onDisplaced = vi.fn(() => { throw new Error("boom"); });
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      { onDisplaced },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateClose(WS_CLOSE_DISPLACED);
    expect(onDisplaced).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledOnce();
    const [msg, err] = errSpy.mock.calls[0];
    expect(msg).toMatch(/onDisplaced handler threw/);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom");
    conn.dispose();
  });

  it("calls onReconnecting before auto-reconnect and passes ticket", async () => {
    const onReconnecting = vi.fn().mockResolvedValue("fresh-ticket");
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      { onReconnecting },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateClose();
    await vi.advanceTimersByTimeAsync(500);

    expect(onReconnecting).toHaveBeenCalledOnce();
    // The reconnect should have used the ticket
    const lastWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    expect(lastWs.url).toBe("ws://localhost:3300/ws?ticket=fresh-ticket");
    conn.dispose();
  });

  it("reconnects without ticket when onReconnecting returns undefined", async () => {
    const onReconnecting = vi.fn().mockResolvedValue(undefined);
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      { onReconnecting },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateClose();
    await vi.advanceTimersByTimeAsync(500);

    expect(onReconnecting).toHaveBeenCalledOnce();
    const lastWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    expect(lastWs.url).toBe("ws://localhost:3300/ws");
    conn.dispose();
  });

  it("reconnects as guest when onReconnecting throws", async () => {
    const onReconnecting = vi.fn().mockRejectedValue(new Error("token refresh failed"));
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      { onReconnecting },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateClose();
    await vi.advanceTimersByTimeAsync(500);

    expect(onReconnecting).toHaveBeenCalledOnce();
    // Should still reconnect, just without a ticket
    const lastWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    expect(lastWs.url).toBe("ws://localhost:3300/ws");
    conn.dispose();
  });

  it("does not reconnect if disposed during onReconnecting await", async () => {
    let resolveTicket: (v: string | undefined) => void;
    const ticketPromise = new Promise<string | undefined>((resolve) => {
      resolveTicket = resolve;
    });
    const onReconnecting = vi.fn().mockReturnValue(ticketPromise);
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      { onReconnecting },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    MockWebSocket.instances[0].simulateClose();
    await vi.advanceTimersByTimeAsync(500);

    // Dispose while onReconnecting is pending
    const countBefore = MockWebSocket.instances.length;
    conn.dispose();
    resolveTicket!("late-ticket");
    await vi.advanceTimersByTimeAsync(0);

    // No new connection should be created
    expect(MockWebSocket.instances.length).toBe(countBefore);
  });

  // Regression guard: a consumer that wires autoReconnect=true (the default)
  // but forgets to supply onReconnecting silently drops authenticated players
  // to a guest session on every server reboot. The constructor warning makes
  // this loud during development; this test pins the warning behavior so a
  // future refactor doesn't quietly remove it.
  it("warns when autoReconnect is on but onReconnecting is missing", () => {
    warnSpy.mockClear();
    const conn = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, {});
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/onReconnecting/);
    conn.dispose();
  });

  it("does not warn when autoReconnect is disabled", () => {
    warnSpy.mockClear();
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", autoReconnect: false },
      {},
    );
    expect(warnSpy).not.toHaveBeenCalled();
    conn.dispose();
  });

  it("does not warn when onReconnecting is supplied", () => {
    warnSpy.mockClear();
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws" },
      { onReconnecting: () => undefined },
    );
    expect(warnSpy).not.toHaveBeenCalled();
    conn.dispose();
  });

  it("does not warn when reconnectAsGuest opt-out is set", () => {
    warnSpy.mockClear();
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectAsGuest: true },
      {},
    );
    expect(warnSpy).not.toHaveBeenCalled();
    conn.dispose();
  });

  it("warns once per instance, not per construction across instances", () => {
    warnSpy.mockClear();
    const a = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, {});
    const b = new MUDdownConnection({ wsUrl: "ws://localhost:3300/ws" }, {});
    // Each instance fires exactly once; there is no module-level dedup flag
    // that would suppress the second instance's warning.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    a.dispose();
    b.dispose();
  });

  it("calls onReconnecting on every reconnect cycle (no caching)", async () => {
    const onReconnecting = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce("ticket-1")
      .mockResolvedValueOnce("ticket-2");
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      { onReconnecting },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);

    // First reconnect cycle
    MockWebSocket.instances[0].simulateClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(onReconnecting).toHaveBeenCalledTimes(1);
    let lastWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    expect(lastWs.url).toBe("ws://localhost:3300/ws?ticket=ticket-1");

    // Second reconnect cycle should call onReconnecting again with a fresh result
    lastWs.simulateClose();
    await vi.advanceTimersByTimeAsync(500);
    expect(onReconnecting).toHaveBeenCalledTimes(2);
    lastWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    expect(lastWs.url).toBe("ws://localhost:3300/ws?ticket=ticket-2");

    conn.dispose();
  });

  it("routes onReconnecting throw to onReconnectError when provided", async () => {
    const refreshErr = new Error("token refresh failed");
    const onReconnecting = vi.fn().mockRejectedValue(refreshErr);
    const onReconnectError = vi.fn();
    const onError = vi.fn();
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      { onReconnecting, onReconnectError, onError },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);
    MockWebSocket.instances[0].simulateClose();
    await vi.advanceTimersByTimeAsync(500);

    expect(onReconnectError).toHaveBeenCalledWith(refreshErr);
    expect(onError).not.toHaveBeenCalled();
    conn.dispose();
  });

  it("falls back to onError with original error when onReconnectError is absent", async () => {
    const refreshErr = new Error("token refresh failed");
    const onReconnecting = vi.fn().mockRejectedValue(refreshErr);
    const onError = vi.fn();
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      { onReconnecting, onError },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);
    MockWebSocket.instances[0].simulateClose();
    await vi.advanceTimersByTimeAsync(500);

    expect(onError).toHaveBeenCalledOnce();
    // The Event-shaped fallback is constructed as a plain object (not via
    // `new Event(...)`) so it works in non-DOM runtimes like React Native /
    // Hermes; pin that here so a future refactor doesn't reintroduce the
    // Event constructor and break the RN bundle.
    const evt = onError.mock.calls[0][0] as unknown as { type: string; error: unknown };
    expect(evt).not.toBeInstanceOf(Event);
    expect(evt.type).toBe("token-refresh-failed");
    expect(evt.error).toBe(refreshErr);
    conn.dispose();
  });

  it("logs but does not propagate when onReconnectError handler itself throws", async () => {
    errSpy.mockClear();
    const onReconnecting = vi.fn().mockRejectedValue(new Error("token refresh failed"));
    const onReconnectError = vi.fn(() => {
      throw new Error("buggy handler");
    });
    const conn = new MUDdownConnection(
      { wsUrl: "ws://localhost:3300/ws", reconnectDelay: 500 },
      { onReconnecting, onReconnectError },
    );
    conn.connect();
    await vi.advanceTimersByTimeAsync(0);
    MockWebSocket.instances[0].simulateClose();
    await vi.advanceTimersByTimeAsync(500);

    // Reconnect must still proceed despite the buggy callback
    const lastWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    expect(lastWs.url).toBe("ws://localhost:3300/ws");
    // The handler-thrown error must have been logged, not swallowed
    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("handler threw")),
    ).toBe(true);
    conn.dispose();
  });
});
