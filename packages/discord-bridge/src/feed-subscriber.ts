/**
 * Public-feed subscriber.
 *
 * Maintains a single read-only WebSocket to the game server's `/feed`
 * endpoint and posts every world-scope envelope it receives to a configured
 * Discord channel. Designed to run alongside the per-user DM gameplay flow
 * without touching it: the subscriber holds no `PlayerSession`, never sends
 * commands, and ignores anything that isn't a `:::system{scope="world"}`
 * envelope.
 *
 * Reconnect strategy: exponential backoff with full jitter, base 1s, capped
 * at 30s — matches the behaviour the project plan called out for slice 3b.
 *
 * Defense in depth: the server is the authoritative source of `scope="world"`
 * routing (only `broadcastWorld()` writes to feed subscribers), but every
 * envelope is re-checked here via {@link isWorldScopeEnvelope} so a future
 * server bug or attribute drift can never cause `scope="player"` content
 * to leak into a public channel.
 */

import WebSocket from "ws";
import type { ServerMessage } from "@muddown/shared";
import { renderEnvelope } from "./render.js";
import { isWorldScopeEnvelope, stripInteractiveLinks } from "./feed.js";

/** Channel-shaped surface — anything that accepts an embeds payload via `send`. */
export interface FeedChannel {
  send(payload: { embeds: { title?: string; description?: string; color?: number }[] }): Promise<unknown>;
}

export interface FeedSubscriberOptions {
  /** Game server WS URL. The subscriber overwrites the path with `/feed`. */
  serverUrl: string;
  /** Already-resolved Discord channel where world-scope events are posted. */
  channel: FeedChannel;
  /** Override the WebSocket constructor (test seam). */
  webSocketCtor?: typeof WebSocket;
  /** Override the timer factory (test seam). */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Override the timer canceller (test seam). */
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /** Override the random source for jitter (test seam). 0 ≤ value < 1. */
  random?: () => number;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

/**
 * Build the `/feed` URL from a gameplay server URL by overwriting the path.
 * Exported for tests.
 */
export function deriveFeedUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.pathname = "/feed";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Compute the next reconnect delay using full-jitter exponential backoff:
 * `delay = random() * min(cap, base * 2^attempt)`. `attempt` is the
 * 0-indexed retry count (0 = first retry). Exported for tests.
 */
export function nextReconnectDelay(
  attempt: number,
  random: () => number = Math.random,
  base = RECONNECT_BASE_MS,
  cap = RECONNECT_CAP_MS,
): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.floor(random() * exp);
}

export class FeedSubscriber {
  private readonly feedUrl: string;
  private readonly channel: FeedChannel;
  private readonly WS: typeof WebSocket;
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly random: () => number;
  private ws: WebSocket | undefined;
  private reconnectAttempts = 0;
  private reconnectHandle: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

  constructor(opts: FeedSubscriberOptions) {
    this.feedUrl = deriveFeedUrl(opts.serverUrl);
    this.channel = opts.channel;
    this.WS = opts.webSocketCtor ?? WebSocket;
    this.setTimer = opts.setTimer ?? setTimeout;
    this.clearTimer = opts.clearTimer ?? clearTimeout;
    this.random = opts.random ?? Math.random;
  }

  /** Open the connection. Idempotent: a no-op if already running. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  /**
   * Close the connection and cancel any pending reconnect timer. After
   * `stop()`, the subscriber will not reconnect on its own.
   */
  stop(): void {
    this.stopped = true;
    if (this.reconnectHandle !== undefined) {
      this.clearTimer(this.reconnectHandle);
      this.reconnectHandle = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try { ws.close(1000, "shutdown"); } catch { /* ignore */ }
    }
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new this.WS(this.feedUrl);
    } catch (err) {
      // Synchronous construction failure (e.g. malformed URL the URL parser
      // accepted but `ws` rejects). Schedule a retry rather than crashing.
      // eslint-disable-next-line no-console
      console.warn("[muddown-discord-bridge] feed WS construction failed:", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
    });

    ws.on("message", (data: WebSocket.RawData) => {
      this.handleMessage(data).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[muddown-discord-bridge] feed publish failed:", err);
      });
    });

    ws.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.warn("[muddown-discord-bridge] feed WS error:", err);
    });

    ws.on("close", () => {
      this.ws = undefined;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectHandle !== undefined) return;
    const delay = nextReconnectDelay(this.reconnectAttempts, this.random);
    this.reconnectAttempts += 1;
    this.reconnectHandle = this.setTimer(() => {
      this.reconnectHandle = undefined;
      if (this.stopped) return;
      this.connect();
    }, delay);
  }

  private async handleMessage(data: WebSocket.RawData): Promise<void> {
    let envelope: ServerMessage;
    try {
      // `ws` delivers RawData in three shapes: string, Buffer, Buffer[]
      // (fragmented), or ArrayBuffer. Normalize like the server's
      // compliance probe does so a fragmented frame doesn't get
      // stringified to "[object Object]" and silently fail JSON.parse.
      let text: string;
      if (typeof data === "string") {
        text = data;
      } else if (Array.isArray(data)) {
        text = Buffer.concat(data).toString("utf-8");
      } else if (data instanceof ArrayBuffer) {
        text = Buffer.from(data).toString("utf-8");
      } else {
        text = data.toString("utf-8");
      }
      envelope = JSON.parse(text) as ServerMessage;
    } catch (err) {
      // Malformed frame from the server. The server is the sole writer to
      // feed subscribers, so this should never happen in practice — but
      // log a warning so a server-side bug surfaces in operator logs
      // rather than the feed silently going dark.
      // eslint-disable-next-line no-console
      console.warn("[muddown-discord-bridge] feed received malformed JSON frame, dropping:", err);
      return;
    }

    // Defense in depth: even though the server only ever fans world-scope
    // envelopes to /feed today, validate before publishing to a public
    // channel so a future server bug can't leak per-player content.
    if (!isWorldScopeEnvelope(envelope)) return;

    const stripped: ServerMessage = {
      ...envelope,
      muddown: stripInteractiveLinks(envelope.muddown),
    };
    const rendered = renderEnvelope(stripped);
    if (rendered.embeds.length === 0) return;

    // Discard `components`: a public channel has no per-user session, so
    // interactive buttons would be meaningless. The link-stripping pass
    // above also keeps any residual `[text](go:...)` from re-appearing as
    // a button via extractGameLinks.
    await this.channel.send({ embeds: rendered.embeds });
  }
}
