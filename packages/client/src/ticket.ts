/**
 * Ticket refresh helper for {@link MUDdownConnection.events.onReconnecting}.
 *
 * Every GUI client needs to refetch a single-use WebSocket ticket from
 * `${apiBase}/auth/ws-ticket` whenever the connection drops, otherwise
 * auto-reconnect falls back to a guest session. This util centralises that
 * one-line fetch so each consumer doesn't reinvent it.
 */

/**
 * Narrower than `typeof fetch` so wrappers like the mobile app's `authFetch`
 * (which only accepts `string` URLs) satisfy it without casting.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TicketRefreshOptions {
  /** Base HTTP URL of the game server, e.g. `https://muddown.com`. */
  readonly apiBase: string;
  /**
   * Bearer token for non-cookie clients (terminal/desktop/mobile). Mutually
   * exclusive with {@link withCredentials} in practice, but both are accepted
   * for consumers that need to support either flow.
   *
   * Pass a getter `() => string | undefined` when the token can rotate between
   * reconnect cycles so each call always reads the current value. A plain
   * string is captured at factory-creation time and is appropriate when the
   * token is stable for the lifetime of the connection.
   */
  readonly sessionToken?: string | (() => string | undefined);
  /**
   * Set `true` for cookie-auth clients (browser play page). Adds
   * `credentials: "include"` so the `muddown_session` cookie is sent.
   */
  readonly withCredentials?: boolean;
  /** Custom fetch implementation (e.g. `authFetch` in the mobile app). Defaults to global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Abort timeout in ms (default 5000). */
  readonly timeoutMs?: number;
}

/**
 * Build an `onReconnecting` callback that refetches a fresh single-use
 * WebSocket ticket. Returns `undefined` (the documented "guest fallback"
 * value) on any auth failure or network error so {@link MUDdownConnection}
 * still reconnects rather than leaving the user staring at "Disconnected".
 */
export function makeTicketRefresh(
  opts: TicketRefreshOptions,
): () => Promise<string | undefined> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const url = `${opts.apiBase.replace(/\/$/, "")}/auth/ws-ticket`;

  return async (): Promise<string | undefined> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = { signal: controller.signal };
      if (opts.withCredentials) init.credentials = "include";
      const token =
        typeof opts.sessionToken === "function"
          ? opts.sessionToken()
          : opts.sessionToken;
      if (token) {
        init.headers = { Authorization: `Bearer ${token}` };
      }
      const res = await fetchImpl(url, init);
      if (!res.ok) {
        // 401 is expected when a session has expired or the user is a guest;
        // stay quiet. 5xx (and unexpected 4xx like 403) is a real signal —
        // the player is about to silently drop to a guest session, log it.
        if (res.status !== 401) {
          console.warn(
            `[muddown] makeTicketRefresh: ${url} returned ${res.status}; reconnecting as guest`,
          );
        }
        return undefined;
      }
      const data = (await res.json()) as { ticket?: string };
      return typeof data.ticket === "string" ? data.ticket : undefined;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        console.warn(
          `[muddown] makeTicketRefresh: ${url} timed out after ${timeoutMs}ms; reconnecting as guest`,
        );
      } else {
        console.error("[muddown] makeTicketRefresh: ticket fetch failed:", err);
      }
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}
