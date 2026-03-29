import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PlayerRecord } from "@muddown/shared";
import { PLAYER_DEFAULTS } from "@muddown/shared";
import type { GameDatabase } from "./db/types.js";

// ─── GitHub OAuth2 Configuration ─────────────────────────────────────────────

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;   // e.g. http://localhost:3300/auth/callback
}

// ─── OAuth State ─────────────────────────────────────────────────────────────

// Pending OAuth flows keyed by `state` parameter (CSRF protection)
const pendingOAuth = new Map<string, { createdAt: number }>();

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const GITHUB_FETCH_TIMEOUT_MS = 10_000; // 10 seconds

// Clean up stale OAuth states every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, val] of pendingOAuth) {
    if (val.createdAt < cutoff) pendingOAuth.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ─── WebSocket Ticket Map ────────────────────────────────────────────────────
// Short-lived single-use tickets that replace passing long-lived tokens
// in the WebSocket query string.

const wsTickets = new Map<string, { playerId: string; expiresAt: number }>();

// Clean up expired tickets every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of wsTickets) {
    if (val.expiresAt <= now) wsTickets.delete(key);
  }
}, 30_000).unref();

export function resolveTicket(ticket: string): string | undefined {
  const entry = wsTickets.get(ticket);
  if (!entry) return undefined;
  wsTickets.delete(ticket); // single-use
  if (entry.expiresAt <= Date.now()) return undefined;
  return entry.playerId;
}

// ─── Route Handler ───────────────────────────────────────────────────────────

export async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  config: OAuthConfig,
  db: GameDatabase,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/auth/login" && req.method === "GET") {
    handleLogin(res, config);
    return true;
  }

  if (url.pathname === "/auth/callback" && req.method === "GET") {
    await handleCallback(url, res, config, db);
    return true;
  }

  if (url.pathname === "/auth/me" && req.method === "GET") {
    handleMe(req, res, db);
    return true;
  }

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    handleLogout(req, res, db, config);
    return true;
  }

  if (url.pathname === "/auth/ws-ticket" && req.method === "GET") {
    handleWsTicket(req, res, db);
    return true;
  }

  return false;
}

// ─── /auth/login → redirect to GitHub ────────────────────────────────────────

function handleLogin(res: ServerResponse, config: OAuthConfig): void {
  const state = randomUUID();
  pendingOAuth.set(state, { createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: "read:user",
    state,
  });

  res.writeHead(302, { Location: `https://github.com/login/oauth/authorize?${params}` });
  res.end();
}

// ─── /auth/callback → exchange code for token, create session ────────────────

async function handleCallback(
  url: URL,
  res: ServerResponse,
  config: OAuthConfig,
  db: GameDatabase,
): Promise<void> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state || !pendingOAuth.has(state)) {
    if (state && !pendingOAuth.has(state)) {
      console.warn("OAuth callback received unknown or expired state (possible CSRF attempt or server restart)");
    }
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid or expired OAuth state.");
    return;
  }
  pendingOAuth.delete(state);

  try {
    // Exchange code for access token
    const tokenController = new AbortController();
    const tokenTimeout = setTimeout(() => tokenController.abort(), GITHUB_FETCH_TIMEOUT_MS);
    let tokenRes: Response;
    try {
      tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
        }),
        signal: tokenController.signal,
      });
    } finally {
      clearTimeout(tokenTimeout);
    }

    if (!tokenRes.ok) {
      console.error(`GitHub token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Authentication failed: could not reach GitHub. Please try again.");
      return;
    }

    let tokenData: { access_token?: string; error?: string };
    try {
      tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    } catch {
      const body = await tokenRes.text().catch(() => "(unreadable)");
      console.error(`GitHub token response is not JSON (${tokenRes.status}): ${body}`);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Authentication failed: unexpected response from GitHub. Please try again.");
      return;
    }

    if (!tokenData.access_token) {
      console.error(`GitHub OAuth token error: ${tokenData.error ?? "unknown error"}`);
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Authentication failed. Please try logging in again.");
      return;
    }

    // Fetch GitHub user profile
    const userController = new AbortController();
    const userTimeout = setTimeout(() => userController.abort(), GITHUB_FETCH_TIMEOUT_MS);
    let userRes: Response;
    try {
      userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "MUDdown-Server/0.1.0",
        },
        signal: userController.signal,
      });
    } finally {
      clearTimeout(userTimeout);
    }

    if (!userRes.ok) {
      console.error(`GitHub user API failed: ${userRes.status} ${userRes.statusText}`);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Authentication failed: could not reach GitHub. Please try again.");
      return;
    }

    let ghUser: { id?: number; login?: string; name?: string };
    try {
      ghUser = await userRes.json() as { id?: number; login?: string; name?: string };
    } catch {
      const body = await userRes.text().catch(() => "(unreadable)");
      console.error(`GitHub user response is not JSON (${userRes.status}): ${body}`);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Authentication failed: unexpected response from GitHub. Please try again.");
      return;
    }

    if (!ghUser.id || !ghUser.login) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Failed to fetch GitHub user profile.");
      return;
    }

    // Find or create player
    const githubId = String(ghUser.id);
    let player = db.getPlayerByGithubId(githubId);
    const now = new Date().toISOString();

    if (!player) {
      player = {
        id: randomUUID(),
        githubId,
        username: ghUser.login,
        displayName: ghUser.name ?? ghUser.login,
        currentRoom: "town-square",
        inventory: [],
        equipped: { weapon: null, armor: null, accessory: null },
        hp: PLAYER_DEFAULTS.hp,
        maxHp: PLAYER_DEFAULTS.maxHp,
        xp: 0,
        createdAt: now,
        updatedAt: now,
      };
      db.upsertPlayer(player);
    } else {
      // Update GitHub profile info on each login
      player.username = ghUser.login;
      player.displayName = ghUser.name ?? ghUser.login;
      player.updatedAt = now;
      db.upsertPlayer(player);
    }

    // Create auth session
    const sessionToken = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
    db.createSession({ token: sessionToken, playerId: player.id, expiresAt });

    // Build cookie with conditional Secure flag
    const secureSuffix = config.callbackUrl.startsWith("https://") ? "; Secure" : "";

    // Redirect to play page — client calls /auth/ws-ticket to get a WS ticket
    res.writeHead(302, {
      Location: "/play",
      "Set-Cookie": `muddown_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}${secureSuffix}`,
    });
    res.end();
  } catch (err) {
    console.error("OAuth callback error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error during authentication.");
    }
  }
}

// ─── /auth/ws-ticket → short-lived single-use WebSocket ticket ───────────────

const ticketTimestamps = new Map<string, number[]>();
const TICKET_RATE_LIMIT = 5;        // max tickets
const TICKET_RATE_WINDOW_MS = 60_000; // per 60 seconds

function handleWsTicket(req: IncomingMessage, res: ServerResponse, db: GameDatabase): void {
  const player = resolvePlayer(req, db);
  if (!player) {
    sendJson(res, 401, { error: "Not authenticated" });
    return;
  }

  const now = Date.now();
  const timestamps = ticketTimestamps.get(player.id) ?? [];
  const recent = timestamps.filter((t) => t > now - TICKET_RATE_WINDOW_MS);

  if (recent.length >= TICKET_RATE_LIMIT) {
    sendJson(res, 429, { error: "Too many ticket requests. Try again shortly." });
    return;
  }

  recent.push(now);
  ticketTimestamps.set(player.id, recent);

  const ticket = randomUUID();
  wsTickets.set(ticket, { playerId: player.id, expiresAt: now + 60_000 }); // 60-second TTL
  sendJson(res, 200, { ticket });
}

// ─── /auth/me → return current player info ───────────────────────────────────

function handleMe(req: IncomingMessage, res: ServerResponse, db: GameDatabase): void {
  const player = resolvePlayer(req, db);
  if (!player) {
    sendJson(res, 401, { error: "Not authenticated" });
    return;
  }
  sendJson(res, 200, {
    id: player.id,
    username: player.username,
    displayName: player.displayName,
  });
}

// ─── /auth/logout → destroy session ─────────────────────────────────────────

function handleLogout(req: IncomingMessage, res: ServerResponse, db: GameDatabase, config: OAuthConfig): void {
  const token = extractSessionToken(req);
  if (token) {
    db.deleteSession(token);
  }
  const secureSuffix = config.callbackUrl.startsWith("https://") ? "; Secure" : "";
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Set-Cookie": `muddown_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureSuffix}`,
  });
  res.end(JSON.stringify({ ok: true }));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function extractSessionToken(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie ?? "";
  const match = cookie.match(/muddown_session=([^;]+)/);
  return match?.[1];
}

export function resolvePlayer(req: IncomingMessage, db: GameDatabase): PlayerRecord | undefined {
  const token = extractSessionToken(req);
  if (!token) return undefined;
  const session = db.getSession(token);
  if (!session) return undefined;
  if (new Date(session.expiresAt) < new Date()) {
    db.deleteSession(token);
    return undefined;
  }
  return db.getPlayerById(session.playerId);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
