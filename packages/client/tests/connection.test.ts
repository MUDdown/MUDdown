import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WS_CLOSE_QUIT } from "@muddown/shared";
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

  beforeEach(() => {
    origWebSocket = globalThis.WebSocket;
    // @ts-expect-error — mock WebSocket
    globalThis.WebSocket = MockWebSocket;
    MockWebSocket.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.WebSocket = origWebSocket;
    vi.useRealTimers();
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
});
