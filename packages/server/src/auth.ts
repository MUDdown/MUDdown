import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountRecord, CharacterRecord, OAuthProvider } from "@muddown/shared";
import { CHARACTER_CLASSES, CLASS_STATS, isCharacterClass, isOAuthProvider } from "@muddown/shared";
import type { GameDatabase, AuthSession } from "./db/types.js";

// ─── Exhaustiveness Guard ────────────────────────────────────────────────────

function assertNever(x: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${String(x)}`);
}

// ─── SQLite Error Detection ──────────────────────────────────────────────────

interface SqliteConstraintError extends Error {
  code: string;
}

function isSqliteConstraintError(err: unknown): err is SqliteConstraintError {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    ((err as { code: string }).code).startsWith("SQLITE_CONSTRAINT")
  );
}

// ─── OAuth2 Configuration ────────────────────────────────────────────────────

export interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;   // e.g. http://localhost:3300/auth/callback
}

/** Map of configured OAuth/OIDC providers. Only present keys are enabled. */
export type OAuthConfig = Partial<Record<OAuthProvider, ProviderConfig>>;

// ─── Constants ───────────────────────────────────────────────────────────────

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PROVIDER_FETCH_TIMEOUT_MS = 10_000; // 10 seconds
const MAX_CHARACTERS_PER_ACCOUNT = 10;
const CHARACTER_NAME_MIN = 2;
const CHARACTER_NAME_MAX = 24;
export const CHARACTER_NAME_RE = /^[a-zA-Z][a-zA-Z0-9 '\-]{0,22}[a-zA-Z0-9]$/;

/** Returns "; Secure" when any configured provider uses an HTTPS callback URL. */
function secureCookieSuffix(config: OAuthConfig): string {
  const anyHttps = Object.values(config).some(c => c?.callbackUrl.startsWith("https://"));
  return anyHttps ? "; Secure" : "";
}

// ─── OAuth State (CSRF protection) ──────────────────────────────────────────

const pendingOAuth = new Map<string, { provider: OAuthProvider; createdAt: number }>();

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, val] of pendingOAuth) {
    if (val.createdAt < cutoff) pendingOAuth.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ─── WebSocket Ticket Map ────────────────────────────────────────────────────

const wsTickets = new Map<string, { characterId: string; expiresAt: number }>();

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
  return entry.characterId;
}

/** @internal — exposed for unit tests only */
export function _insertTicket(ticket: string, characterId: string, expiresAt: number): void {
  wsTickets.set(ticket, { characterId, expiresAt });
}

// ─── CORS ────────────────────────────────────────────────────────────────────

const WEBSITE_ORIGIN = process.env.WEBSITE_ORIGIN ?? "http://localhost:4321";

export function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin === WEBSITE_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  } else if (origin) {
    console.warn(`CORS: rejected origin "${origin}" (expected "${WEBSITE_ORIGIN}")`);
  }
}

export function handleCorsPreflightIfNeeded(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "OPTIONS") {
    setCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// ─── Route Handler ───────────────────────────────────────────────────────────

export async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  config: OAuthConfig,
  db: GameDatabase,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // CORS preflight for auth routes
  if (url.pathname.startsWith("/auth/") && handleCorsPreflightIfNeeded(req, res)) {
    return true;
  }

  // Set CORS headers on all auth responses
  if (url.pathname.startsWith("/auth/")) {
    setCorsHeaders(req, res);
  }

  if (url.pathname === "/auth/providers" && req.method === "GET") {
    handleProviders(res, config);
    return true;
  }

  if (url.pathname === "/auth/login" && req.method === "GET") {
    handleLogin(url, res, config);
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

  if (url.pathname === "/auth/characters" && req.method === "GET") {
    handleListCharacters(req, res, db);
    return true;
  }

  if (url.pathname === "/auth/select-character" && req.method === "POST") {
    await handleSelectCharacter(req, res, db);
    return true;
  }

  if (url.pathname === "/auth/create-character" && req.method === "POST") {
    await handleCreateCharacter(req, res, db);
    return true;
  }

  if (url.pathname === "/auth/ws-ticket" && req.method === "GET") {
    handleWsTicket(req, res, db);
    return true;
  }

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    handleLogout(req, res, db, config);
    return true;
  }

  return false;
}

// ─── /auth/providers → list configured providers ────────────────────────────

function handleProviders(res: ServerResponse, config: OAuthConfig): void {
  const providers = Object.keys(config).filter(
    (p): p is OAuthProvider => isOAuthProvider(p) && Boolean(config[p as OAuthProvider])
  );
  sendJson(res, 200, { providers });
}

// ─── /auth/login → redirect to OAuth provider ───────────────────────────────

function handleLogin(url: URL, res: ServerResponse, config: OAuthConfig): void {
  const providerParam = url.searchParams.get("provider") ?? "github";

  if (!isOAuthProvider(providerParam)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Unsupported provider: ${providerParam}.`);
    return;
  }
  const provider = providerParam;
  const providerCfg = config[provider];

  if (!providerCfg) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`Provider "${provider}" is not configured on this server.`);
    return;
  }

  const state = randomUUID();
  pendingOAuth.set(state, { provider, createdAt: Date.now() });

  const authorizeUrl = buildAuthorizeUrl(provider, providerCfg, state);
  res.writeHead(302, { Location: authorizeUrl });
  res.end();
}

function buildAuthorizeUrl(provider: OAuthProvider, cfg: ProviderConfig, state: string): string {
  switch (provider) {
    case "github": {
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.callbackUrl,
        scope: "read:user",
        state,
      });
      return `https://github.com/login/oauth/authorize?${params}`;
    }
    case "microsoft": {
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.callbackUrl,
        response_type: "code",
        scope: "openid profile email User.Read",
        state,
      });
      return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
    }
    case "google": {
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.callbackUrl,
        response_type: "code",
        scope: "openid profile email",
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }
    default:
      return assertNever(provider, "OAuthProvider in buildAuthorizeUrl");
  }
}

// ─── /auth/callback → exchange code, find/create account ─────────────────────

/** Normalized user identity returned by each provider's profile fetch. */
interface ProviderUser {
  provider: OAuthProvider;
  providerId: string;
  username: string;      // provider login / email / identifier
  displayName: string;   // human-readable name
}

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

  const pending = pendingOAuth.get(state);
  if (!pending) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid or expired OAuth state.");
    return;
  }
  const provider = pending.provider;
  pendingOAuth.delete(state);

  try {

    const providerCfg = config[provider];
    if (!providerCfg) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end(`Provider "${provider}" is no longer configured.`);
      return;
    }
    // Exchange code for access token (provider-specific)
    const accessToken = await exchangeCodeForToken(provider, providerCfg, code);
    if (!accessToken) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Authentication failed. Please try logging in again.");
      return;
    }

    // Fetch user profile (provider-specific)
    const user = await fetchProviderUser(provider, accessToken);
    if (!user) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Authentication failed: could not fetch user profile from ${provider}. Please try again.`);
      return;
    }

    // Find or create account via identity link (provider-agnostic)
    const account = findOrCreateAccount(db, user);

    // Create auth session (no active character yet — user selects on /play)
    const sessionToken = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
    db.createSession({ token: sessionToken, accountId: account.id, activeCharacterId: null, expiresAt });

    const secureSuffix = secureCookieSuffix(config);
    const websiteOrigin = process.env.WEBSITE_ORIGIN ?? "http://localhost:4321";
    const redirectUrl = `${websiteOrigin.replace(/\/+$/, "")}/play`;

    res.writeHead(302, {
      Location: redirectUrl,
      "Set-Cookie": `muddown_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}${secureSuffix}`,
    });
    res.end();
  } catch (err) {
    console.error(`OAuth callback error (provider=${provider}):`, err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error during authentication.");
    }
  }
}

// ─── Token Exchange (provider-specific) ──────────────────────────────────────

export async function exchangeCodeForToken(
  provider: OAuthProvider,
  cfg: ProviderConfig,
  code: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);

  try {
    let tokenRes: Response;

    switch (provider) {
      case "github":
        tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            code,
            redirect_uri: cfg.callbackUrl,
          }),
          signal: controller.signal,
        });
        break;

      case "microsoft":
        tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            code,
            redirect_uri: cfg.callbackUrl,
            grant_type: "authorization_code",
          }),
          signal: controller.signal,
        });
        break;

      case "google":
        tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            code,
            redirect_uri: cfg.callbackUrl,
            grant_type: "authorization_code",
          }),
          signal: controller.signal,
        });
        break;

      default:
        return assertNever(provider, "OAuthProvider in exchangeCodeForToken");
    }

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text().catch(() => "(unreadable)");
      console.error(`${provider} token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`, errBody);
      return null;
    }

    let tokenData: { access_token?: string; error?: string };
    try {
      tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    } catch {
      console.error(`${provider} token response is not valid JSON`);
      return null;
    }

    if (!tokenData.access_token) {
      console.error(`${provider} OAuth token error: ${tokenData.error ?? "no access_token in response"}`);
      return null;
    }

    return tokenData.access_token;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── User Profile Fetch (provider-specific) ──────────────────────────────────

export async function fetchProviderUser(
  provider: OAuthProvider,
  accessToken: string,
): Promise<ProviderUser | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);

  try {
    switch (provider) {
      case "github": {
        const userRes = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "MUDdown-Server/0.1.0",
          },
          signal: controller.signal,
        });
        if (!userRes.ok) {
          const errBody = await userRes.text().catch(() => "(unreadable)");
          console.error(`GitHub user API failed: ${userRes.status}`, errBody);
          return null;
        }
        let gh: { id?: number; login?: string; name?: string };
        try {
          gh = await userRes.json() as typeof gh;
        } catch {
          console.error(`GitHub user profile returned non-JSON body (status ${userRes.status})`);
          return null;
        }
        if (!gh.id || !gh.login) {
          console.error("GitHub user profile missing id or login");
          return null;
        }
        return {
          provider: "github",
          providerId: String(gh.id),
          username: gh.login,
          displayName: gh.name ?? gh.login,
        };
      }

      case "microsoft": {
        const userRes = await fetch("https://graph.microsoft.com/v1.0/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        if (!userRes.ok) {
          const errBody = await userRes.text().catch(() => "(unreadable)");
          console.error(`Microsoft Graph /me failed: ${userRes.status}`, errBody);
          return null;
        }
        let ms: { id?: string; displayName?: string; userPrincipalName?: string; mail?: string };
        try {
          ms = await userRes.json() as typeof ms;
        } catch {
          console.error(`Microsoft Graph /me returned non-JSON body (status ${userRes.status})`);
          return null;
        }
        if (!ms.id) {
          console.error("Microsoft user profile missing id");
          return null;
        }
        const username = ms.mail ?? ms.userPrincipalName ?? ms.id;
        return {
          provider: "microsoft",
          providerId: ms.id,
          username,
          displayName: ms.displayName ?? username,
        };
      }

      case "google": {
        const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        if (!userRes.ok) {
          const errBody = await userRes.text().catch(() => "(unreadable)");
          console.error(`Google userinfo failed: ${userRes.status}`, errBody);
          return null;
        }
        let gg: { sub?: string; name?: string; email?: string };
        try {
          gg = await userRes.json() as typeof gg;
        } catch {
          console.error(`Google userinfo returned non-JSON body (status ${userRes.status})`);
          return null;
        }
        if (!gg.sub) {
          console.error("Google user profile missing sub");
          return null;
        }
        const username = gg.email ?? gg.sub;
        return {
          provider: "google",
          providerId: gg.sub,
          username,
          displayName: gg.name ?? username,
        };
      }

      default:
        return assertNever(provider, "OAuthProvider in fetchProviderUser");
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Account Resolution (provider-agnostic) ──────────────────────────────────

export function findOrCreateAccount(db: GameDatabase, user: ProviderUser): AccountRecord {
  const now = new Date().toISOString();
  let link = db.getIdentityLink(user.provider, user.providerId);
  let account: AccountRecord | undefined;

  if (link) {
    account = db.getAccountById(link.accountId);
    if (account) {
      if (!account.displayNameOverridden) {
        try {
          db.updateAccountDisplayName(account.id, user.displayName);
          account.displayName = user.displayName;
          account.updatedAt = now;
        } catch (err) {
          console.warn("Failed to update display name — continuing with stale name", err);
        }
      }
    } else {
      console.warn(
        `Identity link references missing account — will re-link`,
        { provider: user.provider, providerId: user.providerId, staleAccountId: link.accountId },
      );
      db.deleteIdentityLink(user.provider, user.providerId);
    }
  }

  if (!account) {
    const newAccount: AccountRecord = {
      id: randomUUID(),
      displayName: user.displayName,
      displayNameOverridden: false,
      createdAt: now,
      updatedAt: now,
    };
    // First, attempt to create the account.
    try {
      db.createAccount(newAccount);
    } catch (err: unknown) {
      if (!isSqliteConstraintError(err)) throw err;

      // Account creation hit a constraint error. Another concurrent request
      // likely created an account for this identity first. Resolve the
      // winner's account without deleting anything.
      link = db.getIdentityLink(user.provider, user.providerId);
      if (link) {
        account = db.getAccountById(link.accountId);
      }
      if (!account) {
        throw new Error(
          `Constraint violation while creating account for ${user.provider}:${user.providerId}`,
        );
      }
    }

    // If we successfully created the account above and haven't resolved an
    // existing account, create the identity link.
    if (!account) {
      try {
        db.createIdentityLink({
          accountId: newAccount.id,
          provider: user.provider,
          providerId: user.providerId,
          providerUsername: user.username,
          linkedAt: now,
        });
        account = newAccount;
      } catch (err: unknown) {
        if (!isSqliteConstraintError(err)) throw err;

        // createAccount succeeded but createIdentityLink hit a constraint
        // error (race condition). Clean up the orphan account we just
        // created.
        try {
          db.deleteAccount(newAccount.id);
        } catch (cleanupErr) {
          console.warn("Failed to delete orphan account after constraint error:", cleanupErr);
        }

        // Resolve the winner's account.
        link = db.getIdentityLink(user.provider, user.providerId);
        if (link) {
          account = db.getAccountById(link.accountId);
        }
        if (!account) {
          throw new Error(
            `Constraint violation but identity link not found for ${user.provider}:${user.providerId}`,
          );
        }
      }
    }
  }

  return account;
}

// ─── /auth/me → return account info + active character ───────────────────────

function handleMe(req: IncomingMessage, res: ServerResponse, db: GameDatabase): void {
  const session = resolveSession(req, db);
  if (!session) {
    sendJson(res, 401, { error: "Not authenticated" });
    return;
  }

  const account = db.getAccountById(session.accountId);
  if (!account) {
    console.error(
      `handleMe: session references missing account — possible data corruption`,
      { accountId: session.accountId }
    );
    sendJson(res, 401, { error: "Account not found" });
    return;
  }

  let activeCharacter: { id: string; name: string; characterClass: string } | null = null;
  if (session.activeCharacterId) {
    const char = db.getCharacterById(session.activeCharacterId);
    if (char && char.accountId === account.id) {
      activeCharacter = { id: char.id, name: char.name, characterClass: char.characterClass };
    } else {
      console.warn(
        `handleMe: activeCharacterId "${session.activeCharacterId}" is stale ` +
        `(${char ? "wrong account" : "not found"}) — clearing from session`,
        { accountId: account.id }
      );
      db.updateSessionCharacter(session.token, null);
    }
  }

  sendJson(res, 200, {
    id: account.id,
    displayName: account.displayName,
    activeCharacter,
  });
}

// ─── /auth/characters → list characters for account ──────────────────────────

function handleListCharacters(req: IncomingMessage, res: ServerResponse, db: GameDatabase): void {
  const session = resolveSession(req, db);
  if (!session) {
    sendJson(res, 401, { error: "Not authenticated" });
    return;
  }

  const characters = db.getCharactersByAccount(session.accountId);
  sendJson(res, 200, {
    characters: characters.map(c => ({
      id: c.id,
      name: c.name,
      characterClass: c.characterClass,
      hp: c.hp,
      maxHp: c.maxHp,
      xp: c.xp,
      currentRoom: c.currentRoom,
    })),
  });
}

// ─── /auth/select-character → set active character on session ────────────────

async function handleSelectCharacter(req: IncomingMessage, res: ServerResponse, db: GameDatabase): Promise<void> {
  const session = resolveSession(req, db);
  if (!session) {
    sendJson(res, 401, { error: "Not authenticated" });
    return;
  }

  const result = await readJsonBody<{ characterId?: string }>(req, "/auth/select-character");
  if (!result.ok) {
    if (result.reason === "oversized") {
      sendJson(res, 413, { error: "Request body too large" });
    } else if (result.reason === "error") {
      sendJson(res, 500, { error: "Request read failed. Please try again." });
    } else {
      sendJson(res, 400, { error: "Request body must be valid JSON" });
    }
    return;
  }
  if (!result.data.characterId) {
    sendJson(res, 400, { error: "Missing characterId" });
    return;
  }

  const character = db.getCharacterById(result.data.characterId);
  if (!character || character.accountId !== session.accountId) {
    sendJson(res, 404, { error: "Character not found" });
    return;
  }

  db.updateSessionCharacter(session.token, character.id);
  sendJson(res, 200, {
    id: character.id,
    name: character.name,
    characterClass: character.characterClass,
  });
}

// ─── /auth/create-character → create new character ───────────────────────────

async function handleCreateCharacter(req: IncomingMessage, res: ServerResponse, db: GameDatabase): Promise<void> {
  const session = resolveSession(req, db);
  if (!session) {
    sendJson(res, 401, { error: "Not authenticated" });
    return;
  }

  const result = await readJsonBody<{ name?: string; characterClass?: string }>(req, "/auth/create-character");
  if (!result.ok) {
    if (result.reason === "oversized") {
      sendJson(res, 413, { error: "Request body too large" });
    } else if (result.reason === "error") {
      sendJson(res, 500, { error: "Request read failed. Please try again." });
    } else {
      sendJson(res, 400, { error: "Request body must be valid JSON" });
    }
    return;
  }
  const body = result.data;
  if (!body.name || !body.characterClass) {
    sendJson(res, 400, { error: "Missing name or characterClass" });
    return;
  }

  // Validate character name
  const name = body.name.trim();
  if (name.length < CHARACTER_NAME_MIN || name.length > CHARACTER_NAME_MAX) {
    sendJson(res, 400, { error: `Name must be ${CHARACTER_NAME_MIN}–${CHARACTER_NAME_MAX} characters.` });
    return;
  }
  if (!CHARACTER_NAME_RE.test(name)) {
    sendJson(res, 400, { error: "Name must start with a letter and contain only letters, numbers, spaces, hyphens, and apostrophes." });
    return;
  }

  // Validate class
  if (!isCharacterClass(body.characterClass)) {
    sendJson(res, 400, { error: `Invalid class. Must be one of: ${CHARACTER_CLASSES.join(", ")}` });
    return;
  }
  const charClass = body.characterClass;

  // Check name uniqueness
  if (db.getCharacterByName(name)) {
    sendJson(res, 409, { error: "A character with that name already exists." });
    return;
  }

  // Check character limit
  const existing = db.getCharactersByAccount(session.accountId);
  if (existing.length >= MAX_CHARACTERS_PER_ACCOUNT) {
    sendJson(res, 400, { error: `Maximum of ${MAX_CHARACTERS_PER_ACCOUNT} characters per account.` });
    return;
  }

  const stats = CLASS_STATS[charClass];
  const now = new Date().toISOString();
  const character: CharacterRecord = {
    id: randomUUID(),
    accountId: session.accountId,
    name,
    characterClass: charClass,
    currentRoom: "town-square",
    inventory: [],
    equipped: { weapon: null, armor: null, accessory: null },
    hp: stats.hp,
    maxHp: stats.maxHp,
    xp: 0,
    createdAt: now,
    updatedAt: now,
  };

  try {
    db.createCharacter(character);
  } catch (err: unknown) {
    if (isSqliteConstraintError(err) && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      sendJson(res, 409, { error: "A character with that name already exists." });
      return;
    }
    throw err;
  }

  // Auto-select the new character
  db.updateSessionCharacter(session.token, character.id);

  sendJson(res, 201, {
    id: character.id,
    name: character.name,
    characterClass: character.characterClass,
    hp: character.hp,
    maxHp: character.maxHp,
  });
}

// ─── /auth/ws-ticket → short-lived single-use WebSocket ticket ───────────────

const ticketTimestamps = new Map<string, number[]>();
const TICKET_RATE_LIMIT = 5;        // max tickets
const TICKET_RATE_WINDOW_MS = 60_000; // per 60 seconds

function handleWsTicket(req: IncomingMessage, res: ServerResponse, db: GameDatabase): void {
  const session = resolveSession(req, db);
  if (!session) {
    sendJson(res, 401, { error: "Not authenticated" });
    return;
  }

  if (!session.activeCharacterId) {
    sendJson(res, 400, { error: "No active character selected. Select or create a character first." });
    return;
  }

  // Verify the character still exists and belongs to this account
  const character = db.getCharacterById(session.activeCharacterId);
  if (!character || character.accountId !== session.accountId) {
    sendJson(res, 400, { error: "Active character not found." });
    return;
  }

  const now = Date.now();
  const timestamps = ticketTimestamps.get(session.accountId) ?? [];
  const recent = timestamps.filter((t) => t > now - TICKET_RATE_WINDOW_MS);

  if (recent.length >= TICKET_RATE_LIMIT) {
    sendJson(res, 429, { error: "Too many ticket requests. Try again shortly." });
    return;
  }

  recent.push(now);
  ticketTimestamps.set(session.accountId, recent);

  const ticket = randomUUID();
  wsTickets.set(ticket, { characterId: character.id, expiresAt: now + 60_000 });
  sendJson(res, 200, { ticket });
}

// ─── /auth/logout → destroy session ─────────────────────────────────────────

function handleLogout(req: IncomingMessage, res: ServerResponse, db: GameDatabase, config: OAuthConfig): void {
  const token = extractSessionToken(req);
  if (token) {
    db.deleteSession(token);
  }
  const secureSuffix = secureCookieSuffix(config);
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

export function resolveSession(req: IncomingMessage, db: GameDatabase): AuthSession | undefined {
  const token = extractSessionToken(req);
  if (!token) return undefined;
  const session = db.getSession(token);
  if (!session) return undefined;
  if (new Date(session.expiresAt) < new Date()) {
    db.deleteSession(token);
    return undefined;
  }
  return session;
}

export function resolveAccount(req: IncomingMessage, db: GameDatabase): AccountRecord | undefined {
  const session = resolveSession(req, db);
  if (!session) return undefined;
  return db.getAccountById(session.accountId);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

type JsonBodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "oversized" | "invalid-json" | "error" };

function readJsonBody<T>(req: IncomingMessage, route: string): Promise<JsonBodyResult<T>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let resolved = false;
    const MAX_BODY = 4096;

    function settle(result: JsonBodyResult<T>): void {
      if (resolved) return;
      resolved = true;
      resolve(result);
    }

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // Drain remaining data instead of destroying mid-read
        settle({ ok: false, reason: "oversized" });
        return;
      }
      if (!resolved) chunks.push(chunk);
    });

    req.on("end", () => {
      if (resolved) return; // already settled (oversized)
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        settle({ ok: true, data: JSON.parse(text) as T });
      } catch (err) {
        console.warn(`readJsonBody(${route}): JSON parse failed:`, err);
        settle({ ok: false, reason: "invalid-json" });
      }
    });

    req.on("error", (err) => {
      console.error(`readJsonBody(${route}): request error:`, err);
      settle({ ok: false, reason: "error" });
    });
  });
}
