/**
 * WebSocket connection manager for MUDdown.
 *
 * Handles connecting with optional auth tickets, automatic reconnection,
 * and message parsing.  Exposes typed callbacks so any UI framework can
 * consume server messages without knowing about the wire protocol.
 */

import { WS_CLOSE_QUIT } from "@muddown/shared";
import type { ServerMessage } from "@muddown/shared";
import type { InvState } from "./inventory.js";
import { isInvState } from "./inventory.js";
import { parseHintBlock } from "./hints.js";
import type { ParsedHint } from "./hints.js";

/** Events emitted by {@link MUDdownConnection}. */
export interface ConnectionEvents {
  /** Fired when the WebSocket connection opens. */
  onOpen?: () => void;
  /** Fired when a game message (non-hint) is received. */
  onMessage?: (muddown: string, type: string, raw: ServerMessage) => void;
  /** Fired when a hint block is received. */
  onHint?: (hint: ParsedHint) => void;
  /** Fired when an inventory state update arrives in `meta`. */
  onInventory?: (state: InvState) => void;
  /** Fired when the connection closes. `willReconnect` is true if auto-reconnect is scheduled. */
  onClose?: (willReconnect: boolean) => void;
  /** Fired on WebSocket error. */
  onError?: (event: Event) => void;
  /**
   * Fired when a token-refresh or reconnect attempt fails (distinct from a
   * WebSocket-level error).  Receives the thrown error directly.  Falls back
   * to {@link onError} (with a synthetic `Event`) if not provided.
   */
  onReconnectError?: (error: unknown) => void;
  /** Fired when a raw message cannot be parsed. */
  onParseError?: (data: string, error: unknown) => void;
  /**
   * Fired before an auto-reconnect attempt.  Return a ticket string to
   * authenticate the reconnection, or `undefined` to reconnect as a guest.
   * If not provided, reconnects without a ticket.
   */
  onReconnecting?: () => Promise<string | undefined> | string | undefined;
}

export interface ConnectionOptions {
  /** Full WebSocket URL base, e.g. `wss://example.com/ws`. */
  wsUrl: string;
  /** Delay in ms before attempting reconnection (default 3000). */
  reconnectDelay?: number;
  /** Set to false to disable automatic reconnection (default true). */
  autoReconnect?: boolean;
}

export class MUDdownConnection {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private opts: Required<ConnectionOptions>;
  private events: ConnectionEvents;
  private disposed = false;

  constructor(options: ConnectionOptions, events: ConnectionEvents = {}) {
    this.opts = {
      wsUrl: options.wsUrl,
      reconnectDelay: options.reconnectDelay ?? 3000,
      autoReconnect: options.autoReconnect ?? true,
    };
    this.events = events;
  }

  /** Open the WebSocket connection, optionally with a single-use auth ticket. */
  connect(ticket?: string): void {
    if (this.disposed) return;
    this.cleanup();
    const url = ticket
      ? `${this.opts.wsUrl}?ticket=${encodeURIComponent(ticket)}`
      : this.opts.wsUrl;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.events.onOpen?.();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };

    this.ws.onclose = (event: CloseEvent) => {
      const willReconnect = this.opts.autoReconnect && !this.disposed && event.code !== WS_CLOSE_QUIT;
      this.events.onClose?.(willReconnect);
      if (willReconnect) {
        this.reconnectTimer = setTimeout(() => void this.reconnect(), this.opts.reconnectDelay);
      }
    };

    this.ws.onerror = (event: Event) => {
      this.events.onError?.(event);
      this.ws?.close();
    };
  }

  /** Internal: handle auto-reconnect, optionally requesting a fresh ticket. */
  private async reconnect(): Promise<void> {
    if (this.disposed) return;
    let ticket: string | undefined;
    try {
      ticket = await this.events.onReconnecting?.();
    } catch (e) {
      console.warn("MUDdownConnection: token refresh failed — reconnecting as guest", e);
      try {
        if (this.events.onReconnectError) {
          this.events.onReconnectError(e);
        } else {
          this.events.onError?.(new Event("token-refresh-failed"));
        }
      } catch { /* don't let a callback exception block reconnect */ }
      // ticket remains undefined; reconnect proceeds without auth
    }
    if (this.disposed) return;
    this.connect(ticket);
  }

  /** Send a command to the server using the wire protocol envelope. */
  send(command: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    let id: string;
    try {
      id = crypto.randomUUID();
    } catch {
      id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const msg = {
      v: 1,
      id,
      type: "command",
      timestamp: new Date().toISOString(),
      command,
    };
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Whether there is an open WebSocket connection. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Close the connection and stop reconnection attempts. */
  dispose(): void {
    this.disposed = true;
    this.cleanup();
  }

  /** Close any existing WebSocket and clear pending reconnect timers. */
  private cleanup(): void {
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private handleMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
      if (typeof msg.muddown !== "string") throw new Error("Missing muddown field");
    } catch (err) {
      this.events.onParseError?.(data, err);
      return;
    }
    try {
      // Inventory state update
      if (msg.meta?.inventoryState !== undefined) {
        if (isInvState(msg.meta.inventoryState)) {
          this.events.onInventory?.(msg.meta.inventoryState);
        } else {
          console.warn("MUDdownConnection: malformed inventoryState payload", msg.meta.inventoryState);
        }
      }

      // Hint block detection
      if (msg.muddown) {
        const hint = parseHintBlock(msg.muddown);
        if (hint) {
          this.events.onHint?.(hint);
        } else {
          this.events.onMessage?.(msg.muddown, msg.type || "narrative", msg);
        }
      }
    } catch (err) {
      console.error("MUDdownConnection: error in message callback:", err);
    }
  }
}

/** Build the WebSocket URL from an HTTP API base URL. */
export function buildWsUrl(apiBase: string, path = "/ws"): string {
  const url = new URL(apiBase);
  let protocol: "ws:" | "wss:";
  switch (url.protocol) {
    case "http:":
    case "ws:":
      protocol = "ws:";
      break;
    case "https:":
    case "wss:":
      protocol = "wss:";
      break;
    default:
      throw new Error(`Unsupported protocol for WebSocket URL: ${url.protocol}`);
  }
  return `${protocol}//${url.host}${path}`;
}
