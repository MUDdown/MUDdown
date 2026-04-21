import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { SqliteDatabase } from "../src/db/sqlite.js";
import type { GameDatabase, AuthSession } from "../src/db/types.js";
import {
  extractSessionToken, extractBearerToken, resolveSession, resolveTicket, CHARACTER_NAME_RE, _insertTicket,
  handleAuthRoute, exchangeCodeForToken, fetchProviderUser, findOrCreateAccount,
  _insertCompletedLogin, setCorsHeaders, handleCorsPreflightIfNeeded,
} from "../src/auth.js";
import type { OAuthConfig } from "../src/auth.js";
import type { IncomingMessage, ServerResponse } from "node:http";

let db: GameDatabase;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "muddown-auth-test-"));
  db = new SqliteDatabase(join(tmpDir, "auth-test.sqlite"));
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Shared mock helpers ─────────────────────────────────────────────────────

type MockResponse = ServerResponse & { statusCode: number; body: string; _headers: Record<string, string> };

function mockRes(): MockResponse {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    _headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res._headers[name.toLowerCase()] = value;
      return res;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          res._headers[k.toLowerCase()] = v;
        }
      }
      return res;
    },
    end(data?: string) {
      if (data) res.body = data;
      return res;
    },
  };
  return res as unknown as MockResponse;
}

// ─── extractSessionToken ─────────────────────────────────────────────────────

describe("extractSessionToken", () => {
  function fakeReq(cookie?: string): IncomingMessage {
    return { headers: { cookie } } as unknown as IncomingMessage;
  }

  it("extracts token from a valid cookie header", () => {
    expect(extractSessionToken(fakeReq("muddown_session=abc123"))).toBe("abc123");
  });

  it("extracts token when other cookies are present", () => {
    expect(extractSessionToken(fakeReq("foo=bar; muddown_session=tok99; baz=qux"))).toBe("tok99");
  });

  it("returns undefined when no cookie header", () => {
    expect(extractSessionToken(fakeReq())).toBeUndefined();
  });

  it("returns undefined when cookie header lacks muddown_session", () => {
    expect(extractSessionToken(fakeReq("other=value"))).toBeUndefined();
  });
});

// ─── resolveSession ──────────────────────────────────────────────────────────

describe("resolveSession", () => {
  const accountId = "acc-resolve-test";

  beforeAll(() => {
    const now = new Date().toISOString();
    db.createAccount({ id: accountId, displayName: "Resolver", displayNameOverridden: false, createdAt: now, updatedAt: now });
  });

  function fakeReq(token?: string): IncomingMessage {
    const cookie = token ? `muddown_session=${token}` : undefined;
    return { headers: { cookie } } as unknown as IncomingMessage;
  }

  it("returns session for a valid, non-expired token", () => {
    const token = randomUUID();
    db.createSession({
      token,
      accountId,
      activeCharacterId: null,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const session = resolveSession(fakeReq(token), db);
    expect(session).toBeDefined();
    expect(session!.accountId).toBe(accountId);
    expect(session!.token).toBe(token);
  });

  it("returns undefined and deletes expired sessions", () => {
    const token = randomUUID();
    db.createSession({
      token,
      accountId,
      activeCharacterId: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const session = resolveSession(fakeReq(token), db);
    expect(session).toBeUndefined();
    // Session should have been deleted
    expect(db.getSession(token)).toBeUndefined();
  });

  it("returns undefined when no cookie", () => {
    expect(resolveSession(fakeReq(), db)).toBeUndefined();
  });

  it("returns undefined for unknown token", () => {
    expect(resolveSession(fakeReq("nonexistent-token"), db)).toBeUndefined();
  });
});

// ─── resolveTicket ───────────────────────────────────────────────────────────

describe("resolveTicket", () => {
  it("returns undefined for unknown ticket", () => {
    expect(resolveTicket("no-such-ticket")).toBeUndefined();
  });

  it("resolves a valid ticket to its characterId and consumes it", () => {
    const ticket = randomUUID();
    const characterId = "char-ticket-test";
    _insertTicket(ticket, characterId, Date.now() + 60_000);

    const result = resolveTicket(ticket);
    expect(result).toBe(characterId);

    // single-use: second resolve returns undefined
    expect(resolveTicket(ticket)).toBeUndefined();
  });

  it("returns undefined for an expired ticket", () => {
    const ticket = randomUUID();
    _insertTicket(ticket, "char-expired", Date.now() - 1);

    expect(resolveTicket(ticket)).toBeUndefined();
  });
});

// ─── CHARACTER_NAME_RE ───────────────────────────────────────────────────────

describe("character name validation", () => {
  it("accepts 2-character names", () => {
    expect(CHARACTER_NAME_RE.test("Al")).toBe(true);
    expect(CHARACTER_NAME_RE.test("Bo")).toBe(true);
  });

  it("accepts typical names", () => {
    expect(CHARACTER_NAME_RE.test("Thorin")).toBe(true);
    expect(CHARACTER_NAME_RE.test("Elara the Brave")).toBe(true);
    expect(CHARACTER_NAME_RE.test("O'Malley")).toBe(true);
    expect(CHARACTER_NAME_RE.test("Anne-Marie")).toBe(true);
  });

  it("rejects single character (below minimum length)", () => {
    expect(CHARACTER_NAME_RE.test("A")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(CHARACTER_NAME_RE.test("")).toBe(false);
  });

  it("rejects names starting with non-letter", () => {
    expect(CHARACTER_NAME_RE.test("1Bad")).toBe(false);
    expect(CHARACTER_NAME_RE.test(" Bad")).toBe(false);
  });

  it("rejects names ending with special characters", () => {
    expect(CHARACTER_NAME_RE.test("Bad-")).toBe(false);
    expect(CHARACTER_NAME_RE.test("Bad ")).toBe(false);
    expect(CHARACTER_NAME_RE.test("Bad'")).toBe(false);
  });

  it("accepts a 24-character name (max length)", () => {
    // 24 chars: starts and ends with letter, interior padded
    const name = "Abcdefghijklmnopqrstuvwx";
    expect(name.length).toBe(24);
    expect(CHARACTER_NAME_RE.test(name)).toBe(true);
  });

  it("rejects a 25-character name (over max)", () => {
    const name = "Abcdefghijklmnopqrstuvwxy";
    expect(name.length).toBe(25);
    expect(CHARACTER_NAME_RE.test(name)).toBe(false);
  });
});

// ─── handleSelectCharacter (via handleAuthRoute) ─────────────────────────────

describe("handleSelectCharacter", () => {
  const ownerAccountId = "acc-owner-" + randomUUID();
  const otherAccountId = "acc-other-" + randomUUID();
  let ownerToken: string;
  let otherToken: string;
  let ownerCharacterId: string;

  const dummyConfig: OAuthConfig = {
    github: {
      clientId: "test",
      clientSecret: "test",
      callbackUrl: "http://localhost:3300/auth/callback",
    },
  };

  beforeAll(() => {
    const now = new Date().toISOString();

    // Create two accounts
    db.createAccount({ id: ownerAccountId, displayName: "Owner", displayNameOverridden: false, createdAt: now, updatedAt: now });
    db.createAccount({ id: otherAccountId, displayName: "Other", displayNameOverridden: false, createdAt: now, updatedAt: now });

    // Create sessions for each
    ownerToken = "tok-owner-" + randomUUID();
    otherToken = "tok-other-" + randomUUID();
    const expires = new Date(Date.now() + 86400000).toISOString();
    db.createSession({ token: ownerToken, accountId: ownerAccountId, activeCharacterId: null, expiresAt: expires });
    db.createSession({ token: otherToken, accountId: otherAccountId, activeCharacterId: null, expiresAt: expires });

    // Create a character belonging to owner
    ownerCharacterId = "char-owner-" + randomUUID();
    db.createCharacter({
      id: ownerCharacterId,
      accountId: ownerAccountId,
      name: "OwnerHero",
      characterClass: "warrior",
      currentRoom: "town-square",
      inventory: [],
      equipped: { weapon: null, armor: null, accessory: null },
      hp: 25,
      maxHp: 25,
      xp: 0,
      createdAt: now,
      updatedAt: now,
    });
  });

  /** Build a mock IncomingMessage that acts as a readable stream with a JSON body. */
  function mockReq(opts: { cookie?: string; body?: unknown }): IncomingMessage {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : "";
    const stream = new Readable({
      read() {
        this.push(bodyStr);
        this.push(null);
      },
    });
    Object.assign(stream, {
      method: "POST",
      url: "/auth/select-character",
      headers: {
        host: "localhost:3300",
        "content-type": "application/json",
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
    });
    return stream as unknown as IncomingMessage;
  }

  it("returns 404 when character belongs to a different account", async () => {
    const req = mockReq({
      cookie: `muddown_session=${otherToken}`,
      body: { characterId: ownerCharacterId },
    });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Character not found" });
  });

  it("returns 200 and updates session when character belongs to requesting account", async () => {
    const req = mockReq({
      cookie: `muddown_session=${ownerToken}`,
      body: { characterId: ownerCharacterId },
    });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(ownerCharacterId);
    expect(body.name).toBe("OwnerHero");

    // Verify session was updated in DB
    const session = db.getSession(ownerToken);
    expect(session).toBeDefined();
    expect(session!.activeCharacterId).toBe(ownerCharacterId);
  });

  it("returns 401 when no session cookie is present", async () => {
    const req = mockReq({
      body: { characterId: ownerCharacterId },
    });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Not authenticated" });
  });

  it("returns 400 when characterId is missing from body", async () => {
    const req = mockReq({
      cookie: `muddown_session=${ownerToken}`,
      body: {},
    });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "Missing characterId" });
  });
});

// ─── /auth/providers ─────────────────────────────────────────────────────────

describe("handleAuthRoute — /auth/providers", () => {
  function mockReq(): IncomingMessage {
    return {
      method: "GET",
      url: "/auth/providers",
      headers: { host: "localhost:3300" },
    } as unknown as IncomingMessage;
  }

  it("lists only configured providers", async () => {
    const config: OAuthConfig = {
      github: { clientId: "g", clientSecret: "s", callbackUrl: "http://localhost/auth/callback" },
      google: { clientId: "g", clientSecret: "s", callbackUrl: "http://localhost/auth/callback" },
    };
    const req = mockReq();
    const res = mockRes();
    await handleAuthRoute(req, res, config, db);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { providers: string[] };
    expect(body.providers).toContain("github");
    expect(body.providers).toContain("google");
    expect(body.providers).not.toContain("microsoft");
  });

  it("returns empty array when no providers configured", async () => {
    const config: OAuthConfig = {};
    const req = mockReq();
    const res = mockRes();
    await handleAuthRoute(req, res, config, db);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ providers: [] });
  });
});

// ─── /auth/login — multi-provider redirect ──────────────────────────────────

describe("handleAuthRoute — /auth/login", () => {
  const allProviders: OAuthConfig = {
    discord: { clientId: "dc-id", clientSecret: "dc-secret", callbackUrl: "http://localhost:3300/auth/callback" },
    github: { clientId: "gh-id", clientSecret: "gh-secret", callbackUrl: "http://localhost:3300/auth/callback" },
    microsoft: { clientId: "ms-id", clientSecret: "ms-secret", callbackUrl: "http://localhost:3300/auth/callback" },
    google: { clientId: "gg-id", clientSecret: "gg-secret", callbackUrl: "http://localhost:3300/auth/callback" },
  };

  function mockReq(provider?: string): IncomingMessage {
    const qs = provider ? `?provider=${provider}` : "";
    return {
      method: "GET",
      url: `/auth/login${qs}`,
      headers: { host: "localhost:3300" },
    } as unknown as IncomingMessage;
  }

  it("redirects to Discord authorize URL when provider=discord", async () => {
    const req = mockReq("discord");
    const res = mockRes();
    await handleAuthRoute(req, res, allProviders, db);
    expect(res.statusCode).toBe(302);
    expect(res._headers["location"]).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize\?/);
    expect(res._headers["location"]).toContain("client_id=dc-id");
    expect(res._headers["location"]).toContain("scope=identify");
  });

  it("redirects to GitHub authorize URL when provider=github", async () => {
    const req = mockReq("github");
    const res = mockRes();
    await handleAuthRoute(req, res, allProviders, db);
    expect(res.statusCode).toBe(302);
    expect(res._headers["location"]).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    expect(res._headers["location"]).toContain("client_id=gh-id");
  });

  it("redirects to Microsoft authorize URL when provider=microsoft", async () => {
    const req = mockReq("microsoft");
    const res = mockRes();
    await handleAuthRoute(req, res, allProviders, db);
    expect(res.statusCode).toBe(302);
    expect(res._headers["location"]).toMatch(/^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?/);
    expect(res._headers["location"]).toContain("client_id=ms-id");
    expect(res._headers["location"]).toContain("scope=openid+profile+email+User.Read");
  });

  it("redirects to Google authorize URL when provider=google", async () => {
    const req = mockReq("google");
    const res = mockRes();
    await handleAuthRoute(req, res, allProviders, db);
    expect(res.statusCode).toBe(302);
    expect(res._headers["location"]).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(res._headers["location"]).toContain("client_id=gg-id");
    expect(res._headers["location"]).toContain("scope=openid+profile+email");
  });

  it("defaults to github when no provider param is given", async () => {
    const req = mockReq();
    const res = mockRes();
    await handleAuthRoute(req, res, allProviders, db);
    expect(res.statusCode).toBe(302);
    expect(res._headers["location"]).toMatch(/github\.com/);
  });

  it("returns 400 for an unsupported provider name", async () => {
    const req = mockReq("facebook");
    const res = mockRes();
    await handleAuthRoute(req, res, allProviders, db);
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when valid provider is not configured", async () => {
    const githubOnly: OAuthConfig = {
      github: { clientId: "gh", clientSecret: "s", callbackUrl: "http://localhost/cb" },
    };
    const req = mockReq("microsoft");
    const res = mockRes();
    await handleAuthRoute(req, res, githubOnly, db);
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("not configured");
  });
});

// ─── exchangeCodeForToken ────────────────────────────────────────────────────

describe("exchangeCodeForToken", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("github: sends JSON body with client_id, client_secret, code, redirect_uri", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "ghtoken123" }),
    }));
    const cfg = { clientId: "cid", clientSecret: "csec", callbackUrl: "http://localhost/cb" };
    const result = await exchangeCodeForToken("github", cfg, "code123");
    expect(result).toBe("ghtoken123");
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ client_id: "cid", code: "code123", redirect_uri: "http://localhost/cb" });
  });

  it("discord: sends form-encoded body to discord.com/api/oauth2/token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "disc-token" }),
    }));
    const cfg = { clientId: "cid", clientSecret: "csec", callbackUrl: "http://localhost/cb" };
    const token = await exchangeCodeForToken("discord", cfg, "disc-code");
    expect(token).toBe("disc-token");
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.com/api/oauth2/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("disc-code");
  });

  it("microsoft: sends form-encoded body with grant_type=authorization_code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "mstoken" }),
    }));
    const cfg = { clientId: "cid", clientSecret: "csec", callbackUrl: "http://localhost/cb" };
    const result = await exchangeCodeForToken("microsoft", cfg, "code123");
    expect(result).toBe("mstoken");
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("microsoftonline.com");
    const body = new URLSearchParams(opts.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("redirect_uri")).toBe("http://localhost/cb");
  });

  it("returns null when response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "Unauthorized" }));
    const cfg = { clientId: "c", clientSecret: "s", callbackUrl: "http://x" };
    expect(await exchangeCodeForToken("github", cfg, "bad")).toBeNull();
  });

  it("returns null when response has no access_token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: "bad_code" }),
    }));
    const cfg = { clientId: "c", clientSecret: "s", callbackUrl: "http://x" };
    expect(await exchangeCodeForToken("github", cfg, "code")).toBeNull();
  });

  it("returns null when response body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError("not json"); },
    }));
    const cfg = { clientId: "c", clientSecret: "s", callbackUrl: "http://x" };
    expect(await exchangeCodeForToken("github", cfg, "code")).toBeNull();
  });
});

// ─── fetchProviderUser ───────────────────────────────────────────────────────

describe("fetchProviderUser", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("discord: returns normalized ProviderUser with global_name as displayName", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "123456", username: "alice", global_name: "Alice Smith" }),
    }));
    const user = await fetchProviderUser("discord", "disc-token");
    expect(user).toEqual({
      provider: "discord",
      providerId: "123456",
      username: "alice",
      displayName: "Alice Smith",
    });
  });

  it("discord: falls back to username as displayName when global_name is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "123456", username: "alice", global_name: null }),
    }));
    const user = await fetchProviderUser("discord", "disc-token");
    expect(user).not.toBeNull();
    expect(user!.displayName).toBe("alice");
  });

  it("github: returns normalized ProviderUser from GitHub profile", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 42, login: "alice", name: "Alice Smith" }),
    }));
    const user = await fetchProviderUser("github", "token");
    expect(user).toEqual({ provider: "github", providerId: "42", username: "alice", displayName: "Alice Smith" });
  });

  it("github: falls back to login as displayName when name is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 1, login: "bob", name: null }),
    }));
    const user = await fetchProviderUser("github", "token");
    expect(user?.displayName).toBe("bob");
  });

  it("github: returns null when id or login is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ login: "noId" }),
    }));
    expect(await fetchProviderUser("github", "token")).toBeNull();
  });

  it("microsoft: prefers mail over userPrincipalName for username", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "ms-id",
        displayName: "Carol",
        userPrincipalName: "carol_ext#EXT#@tenant.onmicrosoft.com",
        mail: "carol@example.com",
      }),
    }));
    const user = await fetchProviderUser("microsoft", "token");
    expect(user?.username).toBe("carol@example.com");
  });

  it("google: falls back to email for displayName when name is absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sub: "g-sub", email: "dave@gmail.com" }),
    }));
    const user = await fetchProviderUser("google", "token");
    expect(user?.displayName).toBe("dave@gmail.com");
  });

  it("returns null when provider user API returns non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "Forbidden" }));
    expect(await fetchProviderUser("github", "token")).toBeNull();
  });

  it("returns null when response body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("not json"); },
    }));
    expect(await fetchProviderUser("github", "token")).toBeNull();
  });
});

// ─── findOrCreateAccount ─────────────────────────────────────────────────────

describe("findOrCreateAccount", () => {
  let focaDb: SqliteDatabase;
  let focaTmpDir: string;

  beforeEach(() => {
    focaTmpDir = mkdtempSync(join(tmpdir(), "muddown-test-"));
    focaDb = new SqliteDatabase(join(focaTmpDir, "test.db"));
  });
  afterEach(() => {
    focaDb.close();
    rmSync(focaTmpDir, { recursive: true, force: true });
  });

  const user = {
    provider: "github" as const,
    providerId: "42",
    username: "alice",
    displayName: "Alice",
  };

  it("creates a new account and identity link on first login", () => {
    const account = findOrCreateAccount(focaDb, user);
    expect(account.displayName).toBe("Alice");
    const link = focaDb.getIdentityLink("github", "42");
    expect(link?.accountId).toBe(account.id);
  });

  it("returns the same account on second login and updates displayName when not overridden", () => {
    const first = findOrCreateAccount(focaDb, user);
    const second = findOrCreateAccount(focaDb, { ...user, displayName: "Alice Updated" });
    expect(second.id).toBe(first.id);
    expect(focaDb.getAccountById(second.id)?.displayName).toBe("Alice Updated");
  });

  it("preserves user-customised displayName when displayNameOverridden is true", () => {
    const first = findOrCreateAccount(focaDb, user);
    // Simulate user customising their name
    const raw = focaDb as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } };
    raw.db.prepare("UPDATE accounts SET display_name = ?, display_name_overridden = 1 WHERE id = ?").run("Custom Name", first.id);

    const second = findOrCreateAccount(focaDb, { ...user, displayName: "Provider Name" });
    expect(second.id).toBe(first.id);
    expect(focaDb.getAccountById(second.id)?.displayName).toBe("Custom Name");
  });

  it("recovers from a stale identity link (orphaned account)", () => {
    // Create a real account then remove it with FKs off to leave an orphaned link
    const now = new Date().toISOString();
    focaDb.createAccount({ id: "ghost-account-id", displayName: "Ghost", displayNameOverridden: false, createdAt: now, updatedAt: now });
    focaDb.createIdentityLink({
      accountId: "ghost-account-id",
      provider: "github",
      providerId: "42",
      providerUsername: "alice",
      linkedAt: now,
    });
    // Delete the account with FKs disabled so the link is orphaned
    (focaDb as unknown as { db: { pragma: (s: string) => void; prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db.pragma("foreign_keys = OFF");
    (focaDb as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => void } } }).db.prepare("DELETE FROM accounts WHERE id = ?").run("ghost-account-id");
    (focaDb as unknown as { db: { pragma: (s: string) => void } }).db.pragma("foreign_keys = ON");

    // findOrCreateAccount should delete the stale link and create a fresh account
    const account = findOrCreateAccount(focaDb, user);
    expect(account.id).not.toBe("ghost-account-id");
    const newLink = focaDb.getIdentityLink("github", "42");
    expect(newLink?.accountId).toBe(account.id);
  });

  it("does not collide when the same providerId exists under a different provider", () => {
    findOrCreateAccount(focaDb, user);
    const msUser = { ...user, provider: "microsoft" as const };
    const msAccount = findOrCreateAccount(focaDb, msUser);
    // Should be two separate accounts
    const ghLink = focaDb.getIdentityLink("github", "42");
    const msLink = focaDb.getIdentityLink("microsoft", "42");
    expect(ghLink?.accountId).not.toBe(msLink?.accountId);
    expect(msAccount.id).toBe(msLink?.accountId);
  });

  it("recovers when a concurrent request wins the identity-link insert", () => {
    // Simulate a race: another request already created the account+link
    const now = new Date().toISOString();
    const winnerAccount = { id: "winner-id", displayName: "Alice", displayNameOverridden: false, createdAt: now, updatedAt: now };
    focaDb.createAccount(winnerAccount);
    focaDb.createIdentityLink({
      accountId: winnerAccount.id,
      provider: "github",
      providerId: "42",
      providerUsername: "alice",
      linkedAt: now,
    });

    // Wrap the real db: getIdentityLink returns undefined on the first call
    // (simulating the initial check before the race), then real results after.
    let firstCall = true;
    const origGetIdentityLink = focaDb.getIdentityLink.bind(focaDb);
    focaDb.getIdentityLink = (provider, providerId) => {
      if (firstCall) {
        firstCall = false;
        return undefined;
      }
      return origGetIdentityLink(provider, providerId);
    };

    const account = findOrCreateAccount(focaDb, user);
    // Should return the winner's account, not a new one
    expect(account.id).toBe("winner-id");
  });

  it("throws non-constraint errors from createIdentityLink", () => {
    const origCreateLink = focaDb.createIdentityLink.bind(focaDb);
    focaDb.createIdentityLink = () => {
      throw new Error("disk I/O error");
    };
    // getIdentityLink returns undefined so the create path is taken
    expect(() => findOrCreateAccount(focaDb, user)).toThrow("disk I/O error");
    focaDb.createIdentityLink = origCreateLink;
  });

  it("resolves the winner when createAccount hits a constraint error without deleting", () => {
    // Pre-create the winner account and link
    const now = new Date().toISOString();
    const winnerAccount = { id: "winner-id", displayName: "Alice", displayNameOverridden: false, createdAt: now, updatedAt: now };
    focaDb.createAccount(winnerAccount);
    focaDb.createIdentityLink({
      accountId: winnerAccount.id,
      provider: "github",
      providerId: "42",
      providerUsername: "alice",
      linkedAt: now,
    });

    // Mock getIdentityLink to return undefined on first call, then real results
    let firstCall = true;
    const origGetIdentityLink = focaDb.getIdentityLink.bind(focaDb);
    focaDb.getIdentityLink = (provider, providerId) => {
      if (firstCall) {
        firstCall = false;
        return undefined;
      }
      return origGetIdentityLink(provider, providerId);
    };

    // Mock createAccount to throw a constraint error (simulating the account ID collision)
    const origCreateAccount = focaDb.createAccount.bind(focaDb);
    focaDb.createAccount = () => {
      const err = new Error("UNIQUE constraint failed: accounts.id") as Error & { code: string };
      err.code = "SQLITE_CONSTRAINT_PRIMARYKEY";
      throw err;
    };

    // Spy on deleteAccount — it should NOT be called
    const origDeleteAccount = focaDb.deleteAccount.bind(focaDb);
    let deleteCalled = false;
    focaDb.deleteAccount = (...args) => {
      deleteCalled = true;
      return origDeleteAccount(...args);
    };

    const account = findOrCreateAccount(focaDb, user);
    expect(account.id).toBe("winner-id");
    expect(deleteCalled).toBe(false);

    focaDb.createAccount = origCreateAccount;
    focaDb.deleteAccount = origDeleteAccount;
  });

  it("throws non-constraint errors from createAccount", () => {
    const origCreateAccount = focaDb.createAccount.bind(focaDb);
    focaDb.createAccount = () => {
      throw new Error("disk I/O error");
    };
    expect(() => findOrCreateAccount(focaDb, user)).toThrow("disk I/O error");
    focaDb.createAccount = origCreateAccount;
  });
});

// ─── /auth/callback ──────────────────────────────────────────────────────────

describe("handleAuthRoute — /auth/callback", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const config: OAuthConfig = {
    github: { clientId: "gh-id", clientSecret: "gh-secret", callbackUrl: "http://localhost:3300/auth/callback" },
  };

  function mockReq(query: string): IncomingMessage {
    return {
      method: "GET",
      url: `/auth/callback${query}`,
      headers: { host: "localhost:3300" },
    } as unknown as IncomingMessage;
  }

  it("returns 400 when state param is missing", async () => {
    const req = mockReq("?code=abc");
    const res = mockRes();
    await handleAuthRoute(req, res, config, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Invalid or expired OAuth state");
  });

  it("returns 400 when code param is missing", async () => {
    const req = mockReq("?state=abc");
    const res = mockRes();
    await handleAuthRoute(req, res, config, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Invalid or expired OAuth state");
  });

  it("returns 400 when state is unknown (no pending entry)", async () => {
    const req = mockReq("?code=abc&state=unknown-state-id");
    const res = mockRes();
    await handleAuthRoute(req, res, config, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Invalid or expired OAuth state");
  });

  it("returns 400 when token exchange fails", async () => {
    // First do a login to create a pending state
    const loginReq = {
      method: "GET",
      url: "/auth/login?provider=github",
      headers: { host: "localhost:3300" },
    } as unknown as IncomingMessage;
    const loginRes = mockRes();
    await handleAuthRoute(loginReq, loginRes, config, db);
    expect(loginRes.statusCode).toBe(302);
    const location = loginRes._headers["location"];
    const stateMatch = location.match(/state=([^&]+)/);
    expect(stateMatch).toBeTruthy();
    const state = stateMatch![1];

    // Stub fetch to fail token exchange
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "bad" }));

    const req = mockReq(`?code=testcode&state=${state}`);
    const res = mockRes();
    await handleAuthRoute(req, res, config, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Authentication failed");
  });

  it("returns 502 when user profile fetch fails", async () => {
    // Login to create pending state
    const loginReq = {
      method: "GET",
      url: "/auth/login?provider=github",
      headers: { host: "localhost:3300" },
    } as unknown as IncomingMessage;
    const loginRes = mockRes();
    await handleAuthRoute(loginReq, loginRes, config, db);
    const location = loginRes._headers["location"];
    const state = location.match(/state=([^&]+)/)![1];

    // Stub fetch: token exchange succeeds, user fetch fails
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Token exchange success
        return { ok: true, json: async () => ({ access_token: "tok" }) };
      }
      // User fetch failure
      return { ok: false, status: 403, text: async () => "forbidden" };
    }));

    const req = mockReq(`?code=testcode&state=${state}`);
    const res = mockRes();
    await handleAuthRoute(req, res, config, db);
    expect(res.statusCode).toBe(502);
  });

  it("redirects to /play with session cookie on success", async () => {
    // Login to create pending state
    const loginReq = {
      method: "GET",
      url: "/auth/login?provider=github",
      headers: { host: "localhost:3300" },
    } as unknown as IncomingMessage;
    const loginRes = mockRes();
    await handleAuthRoute(loginReq, loginRes, config, db);
    const location = loginRes._headers["location"];
    const state = location.match(/state=([^&]+)/)![1];

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ access_token: "tok" }) };
      }
      return {
        ok: true,
        json: async () => ({ id: 999, login: "testuser", name: "Test User" }),
      };
    }));

    const req = mockReq(`?code=testcode&state=${state}`);
    const res = mockRes();
    await handleAuthRoute(req, res, config, db);
    expect(res.statusCode).toBe(302);
    expect(res._headers["location"]).toContain("/play");
    expect(res._headers["set-cookie"]).toMatch(/muddown_session=/);
  });

  it("returns 503 when provider config was removed between login and callback", async () => {
    // Login using github config
    const loginReq = {
      method: "GET",
      url: "/auth/login?provider=github",
      headers: { host: "localhost:3300" },
    } as unknown as IncomingMessage;
    const loginRes = mockRes();
    await handleAuthRoute(loginReq, loginRes, config, db);
    const location = loginRes._headers["location"];
    const state = location.match(/state=([^&]+)/)![1];

    // Now use empty config (provider removed)
    const req = mockReq(`?code=testcode&state=${state}`);
    const res = mockRes();
    await handleAuthRoute(req, res, {} as OAuthConfig, db);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("no longer configured");
  });

  it("redirects to mobile deep link with token when redirect_uri is set", async () => {
    // Login with redirect_uri to create pending state with mobileRedirect
    const loginReq = {
      method: "GET",
      url: "/auth/login?provider=github&redirect_uri=muddown%3A%2F%2Fauth",
      headers: { host: "localhost:3300" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    const loginRes = mockRes();
    await handleAuthRoute(loginReq, loginRes, config, db);
    expect(loginRes.statusCode).toBe(302);
    const location = loginRes._headers["location"];
    const state = location.match(/state=([^&]+)/)![1];

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ access_token: "tok" }) };
      }
      return {
        ok: true,
        json: async () => ({ id: 888, login: "mobileuser", name: "Mobile User" }),
      };
    }));

    const req = mockReq(`?code=testcode&state=${state}`);
    const res = mockRes();
    await handleAuthRoute(req, res, config, db);

    // Mobile redirect now returns an HTML relay page (200) instead of a raw 302,
    // because browsers don't reliably follow 302s to custom URL schemes.
    expect(res.statusCode).toBe(200);
    expect(res._headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toContain("Authentication Successful");
    expect(res.body).toContain("muddown://auth?token=");
    // No cookie should be set for mobile redirects
    expect(res._headers["set-cookie"]).toBeUndefined();
    // Extract the token from the relay page deep link
    const tokenMatch = res.body.match(/muddown:\/\/auth\?token=([^"&]+)/);
    expect(tokenMatch).toBeTruthy();
    const session = db.getSession(tokenMatch![1]);
    expect(session).toBeDefined();
    expect(session!.accountId).toBeDefined();
  });

  it("renders close-tab HTML page for token-poll clients (login_nonce)", async () => {
    const nonce = randomUUID();
    // Login with login_nonce to create pending state for token-poll flow
    const loginReq = {
      method: "GET",
      url: `/auth/login?provider=github&login_nonce=${encodeURIComponent(nonce)}`,
      headers: { host: "localhost:3300" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    const loginRes = mockRes();
    await handleAuthRoute(loginReq, loginRes, config, db);
    expect(loginRes.statusCode).toBe(302);
    const location = loginRes._headers["location"];
    const state = location.match(/state=([^&]+)/)![1];

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, json: async () => ({ access_token: "tok" }) };
      }
      return {
        ok: true,
        json: async () => ({ id: 777, login: "termuser", name: "Terminal User" }),
      };
    }));

    const req = mockReq(`?code=testcode&state=${state}`);
    const res = mockRes();
    await handleAuthRoute(req, res, config, db);

    // Token-poll clients get a 200 HTML page, not a 302 redirect
    expect(res.statusCode).toBe(200);
    expect(res._headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res._headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain("Authentication Successful");
    expect(res.body).toContain("close this tab");
    // No cookie should be set — the token is retrieved via /auth/token-poll
    expect(res._headers["set-cookie"]).toBeUndefined();
    // No redirect header
    expect(res._headers["location"]).toBeUndefined();

    // Verify the completed login was stored and is retrievable via token-poll
    const pollReq = {
      method: "GET",
      url: `/auth/token-poll?nonce=${encodeURIComponent(nonce)}`,
      headers: { host: "localhost:3300" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    const pollRes = mockRes();
    await handleAuthRoute(pollReq, pollRes, config, db);
    expect(pollRes.statusCode).toBe(200);
    const pollBody = JSON.parse(pollRes.body) as { token: string };
    expect(pollBody.token).toBeDefined();
    // The token should resolve to a valid session in the database
    const session = db.getSession(pollBody.token);
    expect(session).toBeDefined();
    expect(session!.accountId).toBeDefined();
  });
});

// ─── exchangeCodeForToken — google branch ────────────────────────────────────

describe("exchangeCodeForToken — google", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("sends form-encoded body with grant_type=authorization_code to Google endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "ggtoken" }),
    }));
    const cfg = { clientId: "cid", clientSecret: "csec", callbackUrl: "http://localhost/cb" };
    const result = await exchangeCodeForToken("google", cfg, "code123");
    expect(result).toBe("ggtoken");
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(opts.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("redirect_uri")).toBe("http://localhost/cb");
  });
});

// ─── fetchProviderUser — error body logging ──────────────────────────────────

describe("fetchProviderUser — error body logging", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    vi.unstubAllGlobals();
    errorSpy?.mockRestore();
  });

  it("discord: returns null and logs on non-ok response", async () => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => "Unauthorized",
    }));
    const user = await fetchProviderUser("discord", "bad-token");
    expect(user).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Discord user API failed: 401"),
      expect.any(String)
    );
  });

  it("discord: returns null when response body is not JSON", async () => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("not json"); },
    }));
    const user = await fetchProviderUser("discord", "disc-token");
    expect(user).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Discord user profile returned non-JSON body"),
      expect.anything()
    );
  });

  it("discord: returns null when id or username is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ global_name: "Alice" }),
    }));
    const user = await fetchProviderUser("discord", "disc-token");
    expect(user).toBeNull();
  });

  it("microsoft: returns null when Graph API returns non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "Unauthorized" }));
    expect(await fetchProviderUser("microsoft", "token")).toBeNull();
  });

  it("microsoft: returns null when response is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("not json"); },
    }));
    expect(await fetchProviderUser("microsoft", "token")).toBeNull();
  });

  it("google: returns null when userinfo returns non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "Internal Server Error" }));
    expect(await fetchProviderUser("google", "token")).toBeNull();
  });

  it("google: returns null when response is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("not json"); },
    }));
    expect(await fetchProviderUser("google", "token")).toBeNull();
  });

  it("google: returns null when sub is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ email: "x@x.com" }),
    }));
    expect(await fetchProviderUser("google", "token")).toBeNull();
  });

  it("microsoft: returns null when id is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ displayName: "Carol" }),
    }));
    expect(await fetchProviderUser("microsoft", "token")).toBeNull();
  });
});

// ─── /auth/create-character ──────────────────────────────────────────────────

describe("handleAuthRoute — /auth/create-character", () => {
  const ccAccountId = "acc-cc-" + randomUUID();
  let ccToken: string;

  const dummyConfig: OAuthConfig = {
    github: {
      clientId: "test",
      clientSecret: "test",
      callbackUrl: "http://localhost:3300/auth/callback",
    },
  };

  beforeAll(() => {
    const now = new Date().toISOString();
    db.createAccount({ id: ccAccountId, displayName: "Creator", displayNameOverridden: false, createdAt: now, updatedAt: now });
    ccToken = "tok-cc-" + randomUUID();
    const expires = new Date(Date.now() + 86400000).toISOString();
    db.createSession({ token: ccToken, accountId: ccAccountId, activeCharacterId: null, expiresAt: expires });
  });

  function mockReq(opts: { cookie?: string; body?: unknown }): IncomingMessage {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : "";
    const stream = new Readable({
      read() {
        this.push(bodyStr);
        this.push(null);
      },
    });
    Object.assign(stream, {
      method: "POST",
      url: "/auth/create-character",
      headers: {
        host: "localhost:3300",
        "content-type": "application/json",
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
    });
    return stream as unknown as IncomingMessage;
  }

  it("returns 401 when no session cookie is present", async () => {
    const req = mockReq({ body: { name: "Hero", characterClass: "warrior" } });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Not authenticated" });
  });

  it("returns 400 when name is missing", async () => {
    const req = mockReq({ cookie: `muddown_session=${ccToken}`, body: { characterClass: "warrior" } });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Missing name");
  });

  it("returns 400 when characterClass is missing", async () => {
    const req = mockReq({ cookie: `muddown_session=${ccToken}`, body: { name: "Hero" } });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("characterClass");
  });

  it("returns 400 when character class is invalid", async () => {
    const req = mockReq({ cookie: `muddown_session=${ccToken}`, body: { name: "Newbie", characterClass: "bard" } });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Invalid class");
  });

  it("returns 400 when character name fails regex", async () => {
    const req = mockReq({ cookie: `muddown_session=${ccToken}`, body: { name: "123Bad", characterClass: "warrior" } });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("must start with a letter");
  });

  it("returns 201 and creates character on success", async () => {
    const uniqueName = "Hero" + randomUUID().slice(0, 8);
    const req = mockReq({ cookie: `muddown_session=${ccToken}`, body: { name: uniqueName, characterClass: "warrior" } });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe(uniqueName);
    expect(body.characterClass).toBe("warrior");
    expect(body.hp).toBe(25);
    expect(body.maxHp).toBe(25);
  });

  it("returns 409 when character name already exists", async () => {
    const dupName = "DupHero" + randomUUID().slice(0, 6);
    // Create first
    const req1 = mockReq({ cookie: `muddown_session=${ccToken}`, body: { name: dupName, characterClass: "mage" } });
    const res1 = mockRes();
    await handleAuthRoute(req1, res1, dummyConfig, db);
    expect(res1.statusCode).toBe(201);

    // Create duplicate
    const req2 = mockReq({ cookie: `muddown_session=${ccToken}`, body: { name: dupName, characterClass: "rogue" } });
    const res2 = mockRes();
    await handleAuthRoute(req2, res2, dummyConfig, db);
    expect(res2.statusCode).toBe(409);
    expect(JSON.parse(res2.body).error).toContain("already exists");
  });

  it("returns 413 when request body is too large", async () => {
    const bodyStr = JSON.stringify({ name: "X".repeat(5000), characterClass: "warrior" });
    const stream = new Readable({
      read() {
        this.push(bodyStr);
        this.push(null);
      },
    });
    Object.assign(stream, {
      method: "POST",
      url: "/auth/create-character",
      headers: {
        host: "localhost:3300",
        "content-type": "application/json",
        cookie: `muddown_session=${ccToken}`,
      },
    });
    const req = stream as unknown as IncomingMessage;
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(413);
  });
});

// ─── /auth/ws-ticket ─────────────────────────────────────────────────────────

describe("handleAuthRoute — /auth/ws-ticket", () => {
  const wsAccountId = "acc-ws-" + randomUUID();
  let wsToken: string;
  let wsCharacterId: string;

  const dummyConfig: OAuthConfig = {
    github: {
      clientId: "test",
      clientSecret: "test",
      callbackUrl: "http://localhost:3300/auth/callback",
    },
  };

  beforeAll(() => {
    const now = new Date().toISOString();
    db.createAccount({ id: wsAccountId, displayName: "WsTester", displayNameOverridden: false, createdAt: now, updatedAt: now });
    wsToken = "tok-ws-" + randomUUID();
    wsCharacterId = "char-ws-" + randomUUID();
    const expires = new Date(Date.now() + 86400000).toISOString();
    db.createCharacter({
      id: wsCharacterId,
      accountId: wsAccountId,
      name: "WsHero-" + randomUUID().slice(0, 6),
      characterClass: "warrior",
      currentRoom: "town-square",
      inventory: [],
      equipped: { weapon: null, armor: null, accessory: null },
      hp: 25,
      maxHp: 25,
      xp: 0,
      createdAt: now,
      updatedAt: now,
    });
    db.createSession({ token: wsToken, accountId: wsAccountId, activeCharacterId: wsCharacterId, expiresAt: expires });
  });

  function mockReq(cookie?: string): IncomingMessage {
    return {
      method: "GET",
      url: "/auth/ws-ticket",
      headers: {
        host: "localhost:3300",
        ...(cookie ? { cookie } : {}),
      },
    } as unknown as IncomingMessage;
  }

  it("returns 401 when no session cookie is present", async () => {
    const req = mockReq();
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when no active character is selected", async () => {
    const noCharToken = "tok-nochar-" + randomUUID();
    const expires = new Date(Date.now() + 86400000).toISOString();
    db.createSession({ token: noCharToken, accountId: wsAccountId, activeCharacterId: null, expiresAt: expires });

    const req = mockReq(`muddown_session=${noCharToken}`);
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("No active character");
  });

  it("returns 200 with a ticket when session has an active character", async () => {
    const req = mockReq(`muddown_session=${wsToken}`);
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ticket).toBeDefined();
    expect(typeof body.ticket).toBe("string");
  });

  it("ticket is single-use: resolveTicket returns value then undefined", async () => {
    const req = mockReq(`muddown_session=${wsToken}`);
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    const { ticket } = JSON.parse(res.body);

    const first = resolveTicket(ticket);
    expect(first).toBe(wsCharacterId);
    expect(resolveTicket(ticket)).toBeUndefined();
  });

  it("returns 400 when active character no longer exists", async () => {
    // Create a real character, then a session pointing to it, then delete the character
    const ghostCharId = "char-ghost-" + randomUUID();
    const now = new Date().toISOString();
    db.createCharacter({
      id: ghostCharId,
      accountId: wsAccountId,
      name: "GhostChar-" + randomUUID().slice(0, 6),
      characterClass: "warrior",
      currentRoom: "town-square",
      inventory: [],
      equipped: { weapon: null, armor: null, accessory: null },
      hp: 25,
      maxHp: 25,
      xp: 0,
      createdAt: now,
      updatedAt: now,
    });
    const ghostToken = "tok-ghost-" + randomUUID();
    const expires = new Date(Date.now() + 86400000).toISOString();
    db.createSession({ token: ghostToken, accountId: wsAccountId, activeCharacterId: ghostCharId, expiresAt: expires });
    // Delete the character via raw SQL with FKs disabled so the session keeps its stale reference
    const raw = db as unknown as { db: { pragma: (s: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    raw.db.pragma("foreign_keys = OFF");
    raw.db.prepare("DELETE FROM characters WHERE id = ?").run(ghostCharId);
    raw.db.pragma("foreign_keys = ON");

    const req = mockReq(`muddown_session=${ghostToken}`);
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Active character not found");
  });
});

// ─── /auth/me ────────────────────────────────────────────────────────────────

describe("handleAuthRoute — /auth/me", () => {
  const dummyConfig: OAuthConfig = {
    github: {
      clientId: "test",
      clientSecret: "test",
      callbackUrl: "http://localhost:3300/auth/callback",
    },
  };

  function mockReq(cookie?: string): IncomingMessage {
    return {
      method: "GET",
      url: "/auth/me",
      headers: {
        host: "localhost:3300",
        ...(cookie ? { cookie } : {}),
      },
    } as unknown as IncomingMessage;
  }

  it("returns 401 when not authenticated", async () => {
    const res = mockRes();
    await handleAuthRoute(mockReq(), res, dummyConfig, db);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Not authenticated" });
  });

  it("returns account info with no active character", async () => {
    const now = new Date().toISOString();
    const accountId = "acc-me-" + randomUUID();
    db.createAccount({ id: accountId, displayName: "MeUser", displayNameOverridden: false, createdAt: now, updatedAt: now });
    const token = "tok-me-" + randomUUID();
    db.createSession({ token, accountId, activeCharacterId: null, expiresAt: new Date(Date.now() + 86400000).toISOString() });

    const res = mockRes();
    await handleAuthRoute(mockReq(`muddown_session=${token}`), res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(accountId);
    expect(body.displayName).toBe("MeUser");
    expect(body.activeCharacter).toBeNull();
  });

  it("returns active character when valid", async () => {
    const now = new Date().toISOString();
    const accountId = "acc-me-valid-" + randomUUID();
    const charId = "char-me-valid-" + randomUUID();
    db.createAccount({ id: accountId, displayName: "ValidChar", displayNameOverridden: false, createdAt: now, updatedAt: now });
    db.createCharacter({
      id: charId, accountId, name: "HeroMe", characterClass: "mage",
      currentRoom: "town-square", inventory: [],
      equipped: { weapon: null, armor: null, accessory: null },
      hp: 20, maxHp: 20, xp: 0, createdAt: now, updatedAt: now,
    });
    const token = "tok-me-valid-" + randomUUID();
    db.createSession({ token, accountId, activeCharacterId: charId, expiresAt: new Date(Date.now() + 86400000).toISOString() });

    const res = mockRes();
    await handleAuthRoute(mockReq(`muddown_session=${token}`), res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.activeCharacter).toEqual({ id: charId, name: "HeroMe", characterClass: "mage" });
  });

  it("clears stale activeCharacterId when character is missing", async () => {
    const now = new Date().toISOString();
    const accountId = "acc-me-stale-" + randomUUID();
    const staleCharId = "char-gone-" + randomUUID();
    db.createAccount({ id: accountId, displayName: "StaleUser", displayNameOverridden: false, createdAt: now, updatedAt: now });
    const token = "tok-me-stale-" + randomUUID();
    // Create session with null, then poke in a stale character ID via raw SQL to bypass FK
    db.createSession({ token, accountId, activeCharacterId: null, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    const raw = db as unknown as { db: { pragma: (s: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    raw.db.pragma("foreign_keys = OFF");
    raw.db.prepare("UPDATE auth_sessions SET active_character_id = ? WHERE token = ?").run(staleCharId, token);
    raw.db.pragma("foreign_keys = ON");

    const res = mockRes();
    await handleAuthRoute(mockReq(`muddown_session=${token}`), res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.activeCharacter).toBeNull();

    // Verify the session was cleaned up in the DB
    const session = db.getSession(token);
    expect(session).toBeDefined();
    expect(session!.activeCharacterId).toBeNull();
  });

  it("clears stale activeCharacterId when character belongs to different account", async () => {
    const now = new Date().toISOString();
    const accountA = "acc-me-a-" + randomUUID();
    const accountB = "acc-me-b-" + randomUUID();
    const charId = "char-other-owner-" + randomUUID();
    db.createAccount({ id: accountA, displayName: "UserA", displayNameOverridden: false, createdAt: now, updatedAt: now });
    db.createAccount({ id: accountB, displayName: "UserB", displayNameOverridden: false, createdAt: now, updatedAt: now });
    db.createCharacter({
      id: charId, accountId: accountB, name: "NotMine", characterClass: "rogue",
      currentRoom: "town-square", inventory: [],
      equipped: { weapon: null, armor: null, accessory: null },
      hp: 20, maxHp: 20, xp: 0, createdAt: now, updatedAt: now,
    });
    const token = "tok-me-wrong-" + randomUUID();
    // Session for accountA points to accountB's character
    db.createSession({ token, accountId: accountA, activeCharacterId: charId, expiresAt: new Date(Date.now() + 86400000).toISOString() });

    const res = mockRes();
    await handleAuthRoute(mockReq(`muddown_session=${token}`), res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.activeCharacter).toBeNull();

    // Verify the session was cleaned up in the DB
    const session = db.getSession(token);
    expect(session).toBeDefined();
    expect(session!.activeCharacterId).toBeNull();
  });

  it("returns 401 when session references a deleted account", async () => {
    const now = new Date().toISOString();
    const accountId = "acc-me-deleted-" + randomUUID();
    db.createAccount({ id: accountId, displayName: "Deleted", displayNameOverridden: false, createdAt: now, updatedAt: now });
    const token = "tok-me-deleted-" + randomUUID();
    db.createSession({ token, accountId, activeCharacterId: null, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    // Delete account with FKs disabled so the session survives (ON DELETE CASCADE would remove it)
    const raw = db as unknown as { db: { pragma: (s: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    raw.db.pragma("foreign_keys = OFF");
    raw.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
    raw.db.pragma("foreign_keys = ON");

    const res = mockRes();
    await handleAuthRoute(mockReq(`muddown_session=${token}`), res, dummyConfig, db);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Account not found" });
  });
});

// ─── extractBearerToken ──────────────────────────────────────────────────────

describe("extractBearerToken", () => {
  function fakeReq(authorization?: string): IncomingMessage {
    return { headers: { authorization } } as unknown as IncomingMessage;
  }

  it("extracts token from a valid Authorization header", () => {
    expect(extractBearerToken(fakeReq("Bearer abc123"))).toBe("abc123");
  });

  it("is case-insensitive for the Bearer prefix", () => {
    expect(extractBearerToken(fakeReq("bearer myToken"))).toBe("myToken");
    expect(extractBearerToken(fakeReq("BEARER myToken"))).toBe("myToken");
  });

  it("returns undefined when no Authorization header", () => {
    expect(extractBearerToken(fakeReq())).toBeUndefined();
  });

  it("returns undefined for non-Bearer auth schemes", () => {
    expect(extractBearerToken(fakeReq("Basic dXNlcjpwYXNz"))).toBeUndefined();
  });

  it("returns undefined for malformed Bearer header", () => {
    expect(extractBearerToken(fakeReq("Bearer"))).toBeUndefined();
    expect(extractBearerToken(fakeReq("Bearer "))).toBeUndefined();
  });
});

// ─── resolveSession with Bearer token ────────────────────────────────────────

describe("resolveSession — Bearer token", () => {
  const accountId = "acc-bearer-test-" + randomUUID();

  beforeAll(() => {
    const now = new Date().toISOString();
    db.createAccount({ id: accountId, displayName: "BearerUser", displayNameOverridden: false, createdAt: now, updatedAt: now });
  });

  function fakeReqBearer(token: string): IncomingMessage {
    return { headers: { authorization: `Bearer ${token}` } } as unknown as IncomingMessage;
  }

  it("resolves a session from a Bearer token", () => {
    const token = randomUUID();
    db.createSession({
      token,
      accountId,
      activeCharacterId: null,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const session = resolveSession(fakeReqBearer(token), db);
    expect(session).toBeDefined();
    expect(session!.accountId).toBe(accountId);
    expect(session!.token).toBe(token);
  });

  it("prefers cookie over Bearer when both are present", () => {
    const cookieToken = randomUUID();
    const bearerToken = randomUUID();
    const expires = new Date(Date.now() + 86400000).toISOString();
    db.createSession({ token: cookieToken, accountId, activeCharacterId: null, expiresAt: expires });
    db.createSession({ token: bearerToken, accountId, activeCharacterId: null, expiresAt: expires });

    const req = {
      headers: {
        cookie: `muddown_session=${cookieToken}`,
        authorization: `Bearer ${bearerToken}`,
      },
    } as unknown as IncomingMessage;

    const session = resolveSession(req, db);
    expect(session).toBeDefined();
    expect(session!.token).toBe(cookieToken);
  });

  it("returns undefined for an invalid Bearer token", () => {
    const req = fakeReqBearer("nonexistent-bearer-token");
    expect(resolveSession(req, db)).toBeUndefined();
  });
});

// ─── /auth/me with Bearer — no longer echoes token ──────────────────────────

describe("handleAuthRoute — /auth/me with Bearer", () => {
  const accountId = "acc-me-bearer-" + randomUUID();
  let sessionToken: string;

  const dummyConfig: OAuthConfig = {
    github: { clientId: "test", clientSecret: "test", callbackUrl: "http://localhost:3300/auth/callback" },
  };

  beforeAll(() => {
    const now = new Date().toISOString();
    db.createAccount({ id: accountId, displayName: "BearerMe", displayNameOverridden: false, createdAt: now, updatedAt: now });
    sessionToken = "tok-me-bearer-" + randomUUID();
    db.createSession({ token: sessionToken, accountId, activeCharacterId: null, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  });

  function mockReq(headers: Record<string, string>): IncomingMessage {
    return {
      method: "GET",
      url: "/auth/me",
      headers: { host: "localhost:3300", ...headers },
    } as unknown as IncomingMessage;
  }

  it("does not echo token back when using Bearer auth", async () => {
    const req = mockReq({ authorization: `Bearer ${sessionToken}` });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.token).toBeUndefined();
    expect(body.id).toBe(accountId);
    expect(body.displayName).toBe("BearerMe");
  });

  it("does not include token when using cookie auth", async () => {
    const req = mockReq({ cookie: `muddown_session=${sessionToken}` });
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.token).toBeUndefined();
  });
});

// ─── /auth/login — mobile redirect_uri ───────────────────────────────────────

describe("handleAuthRoute — /auth/login with redirect_uri", () => {
  const githubConfig: OAuthConfig = {
    github: { clientId: "gh-id", clientSecret: "gh-secret", callbackUrl: "http://localhost:3300/auth/callback" },
  };

  function mockReq(qs: string): IncomingMessage {
    return {
      method: "GET",
      url: `/auth/login${qs}`,
      headers: { host: "localhost:3300" },
    } as unknown as IncomingMessage;
  }

  it("accepts redirect_uri with a custom scheme", async () => {
    const req = mockReq("?provider=github&redirect_uri=muddown://auth");
    const res = mockRes();
    await handleAuthRoute(req, res, githubConfig, db);
    expect(res.statusCode).toBe(302);
    expect(res._headers["location"]).toMatch(/github\.com/);
  });

  it("rejects redirect_uri without a scheme", async () => {
    const req = mockReq("?provider=github&redirect_uri=not-a-uri");
    const res = mockRes();
    await handleAuthRoute(req, res, githubConfig, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Invalid redirect_uri");
  });

  it("rejects redirect_uri with https scheme", async () => {
    const req = mockReq("?provider=github&redirect_uri=https://attacker.com/steal");
    const res = mockRes();
    await handleAuthRoute(req, res, githubConfig, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("only custom app schemes");
  });

  it("rejects redirect_uri with http scheme", async () => {
    const req = mockReq("?provider=github&redirect_uri=http://evil.com");
    const res = mockRes();
    await handleAuthRoute(req, res, githubConfig, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("only custom app schemes");
  });

  it("rejects redirect_uri with javascript scheme", async () => {
    const req = mockReq("?provider=github&redirect_uri=javascript://alert(1)");
    const res = mockRes();
    await handleAuthRoute(req, res, githubConfig, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("only custom app schemes");
  });

  it("rejects redirect_uri with data scheme", async () => {
    const req = mockReq("?provider=github&redirect_uri=data://text/html,<script>alert(1)</script>");
    const res = mockRes();
    await handleAuthRoute(req, res, githubConfig, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("only custom app schemes");
  });

  it("rejects redirect_uri with file scheme", async () => {
    const req = mockReq("?provider=github&redirect_uri=file:///etc/passwd");
    const res = mockRes();
    await handleAuthRoute(req, res, githubConfig, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("only custom app schemes");
  });

  it("rejects redirect_uri with blob scheme", async () => {
    const req = mockReq("?provider=github&redirect_uri=blob://something");
    const res = mockRes();
    await handleAuthRoute(req, res, githubConfig, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("only custom app schemes");
  });

  it("rejects redirect_uri with ftp scheme", async () => {
    const req = mockReq("?provider=github&redirect_uri=ftp://evil.com/path");
    const res = mockRes();
    await handleAuthRoute(req, res, githubConfig, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("only custom app schemes");
  });

  it("accepts redirect_uri with exp scheme (Expo Go)", async () => {
    const req = mockReq("?provider=github&redirect_uri=exp://192.168.1.5:8081/auth");
    const res = mockRes();
    await handleAuthRoute(req, res, githubConfig, db);
    expect(res.statusCode).toBe(302);
    expect(res._headers["location"]).toMatch(/github\.com/);
  });

  it("treats empty redirect_uri as absent (proceeds normally)", async () => {
    const req = mockReq("?provider=github&redirect_uri=");
    const res = mockRes();
    await handleAuthRoute(req, res, githubConfig, db);
    expect(res.statusCode).toBe(302);
    expect(res._headers["location"]).toMatch(/github\.com/);
  });
});

// ─── resolveSession — expired cookie falls back to Bearer ────────────────────

describe("resolveSession — expired cookie with valid Bearer", () => {
  const accountId = "acc-fallback-" + randomUUID();

  beforeAll(() => {
    const now = new Date().toISOString();
    db.createAccount({ id: accountId, displayName: "FallbackUser", displayNameOverridden: false, createdAt: now, updatedAt: now });
  });

  it("resolves via Bearer when cookie session is expired", () => {
    const expiredToken = "expired-" + randomUUID();
    const bearerToken = "bearer-" + randomUUID();
    const expired = new Date(Date.now() - 86400000).toISOString();
    const valid = new Date(Date.now() + 86400000).toISOString();
    db.createSession({ token: expiredToken, accountId, activeCharacterId: null, expiresAt: expired });
    db.createSession({ token: bearerToken, accountId, activeCharacterId: null, expiresAt: valid });

    // Cookie takes precedence — but it's expired, so resolveSession should
    // delete it and return undefined (it doesn't fall through to Bearer after
    // finding a cookie). This test documents the current cookie-first behavior.
    const req = {
      headers: {
        cookie: `muddown_session=${expiredToken}`,
        authorization: `Bearer ${bearerToken}`,
      },
    } as unknown as IncomingMessage;

    const session = resolveSession(req, db);
    // Cookie was found first, expired, and deleted — no fallback to Bearer
    expect(session).toBeUndefined();
  });
});

// ─── /auth/me — invalid Bearer returns 401 ──────────────────────────────────

describe("handleAuthRoute — /auth/me with invalid Bearer", () => {
  const dummyConfig: OAuthConfig = {
    github: { clientId: "test", clientSecret: "test", callbackUrl: "http://localhost:3300/auth/callback" },
  };

  it("returns 401 for an invalid Bearer token", async () => {
    const req = {
      method: "GET",
      url: "/auth/me",
      headers: { host: "localhost:3300", authorization: "Bearer nonexistent-token-xyz" },
    } as unknown as IncomingMessage;
    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Not authenticated" });
  });
});

// ─── extractBearerToken — internal whitespace ────────────────────────────────

describe("extractBearerToken — edge cases", () => {
  function fakeReq(authorization?: string): IncomingMessage {
    return { headers: { authorization } } as unknown as IncomingMessage;
  }

  it("returns undefined when token contains internal whitespace", () => {
    expect(extractBearerToken(fakeReq("Bearer abc def"))).toBeUndefined();
  });

  it("returns undefined for empty string authorization", () => {
    expect(extractBearerToken(fakeReq(""))).toBeUndefined();
  });
});

// ─── /auth/token-poll ────────────────────────────────────────────────────────

describe("handleAuthRoute — /auth/token-poll", () => {
  const dummyConfig: OAuthConfig = {
    github: { clientId: "test", clientSecret: "test", callbackUrl: "http://localhost:3300/auth/callback" },
  };

  function pollReq(nonce?: string, ip = "127.0.0.1"): IncomingMessage {
    const qs = nonce ? `?nonce=${encodeURIComponent(nonce)}` : "";
    return {
      method: "GET",
      url: `/auth/token-poll${qs}`,
      headers: { host: "localhost:3300" },
      socket: { remoteAddress: ip },
    } as unknown as IncomingMessage;
  }

  it("returns 400 when nonce is missing", async () => {
    const res = mockRes();
    await handleAuthRoute(pollReq(), res, dummyConfig, db);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "Missing nonce parameter." });
  });

  it("returns 202 when nonce is unknown (pending)", async () => {
    const res = mockRes();
    await handleAuthRoute(pollReq("nonexistent-nonce"), res, dummyConfig, db);
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ status: "pending" });
  });

  it("returns 200 with token for a completed login", async () => {
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "session-token-abc");

    const res = mockRes();
    await handleAuthRoute(pollReq(nonce), res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ token: "session-token-abc" });
  });

  it("deletes token after first successful poll (one-time retrieval)", async () => {
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "one-time-token");

    const res1 = mockRes();
    await handleAuthRoute(pollReq(nonce), res1, dummyConfig, db);
    expect(res1.statusCode).toBe(200);

    // Second poll should return 202 (deleted)
    const res2 = mockRes();
    await handleAuthRoute(pollReq(nonce), res2, dummyConfig, db);
    expect(res2.statusCode).toBe(202);
  });

  it("returns 403 when poller IP does not match origin IP", async () => {
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "ip-bound-token", "10.0.0.1");

    const res = mockRes();
    await handleAuthRoute(pollReq(nonce, "192.168.1.99"), res, dummyConfig, db);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden." });
  });

  it("returns 200 when poller IP matches origin IP", async () => {
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "ip-match-token", "10.0.0.1");

    const res = mockRes();
    await handleAuthRoute(pollReq(nonce, "10.0.0.1"), res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ token: "ip-match-token" });
  });

  it("does not consume the nonce when IP mismatches (available for correct IP later)", async () => {
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "preserved-token", "10.0.0.1");

    // Wrong IP → 403 but nonce still exists
    const bad = mockRes();
    await handleAuthRoute(pollReq(nonce, "192.168.1.99"), bad, dummyConfig, db);
    expect(bad.statusCode).toBe(403);

    // Correct IP → should still succeed
    const good = mockRes();
    await handleAuthRoute(pollReq(nonce, "10.0.0.1"), good, dummyConfig, db);
    expect(good.statusCode).toBe(200);
    expect(JSON.parse(good.body)).toEqual({ token: "preserved-token" });
  });

  it("uses X-Forwarded-For header for IP matching (proxy support)", async () => {
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "proxy-token", "203.0.113.50");

    function pollReqWithProxy(nonce: string, xff: string): IncomingMessage {
      return {
        method: "GET",
        url: `/auth/token-poll?nonce=${encodeURIComponent(nonce)}`,
        headers: { host: "localhost:3300", "x-forwarded-for": xff },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage;
    }

    // Socket says 127.0.0.1 (proxy) but XFF says the real client IP
    const res = mockRes();
    await handleAuthRoute(pollReqWithProxy(nonce, "203.0.113.50"), res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ token: "proxy-token" });
  });

  it("trusts loopback pollers with no proxy headers (telnet bridge scenario)", async () => {
    // Browser originates the login from a public IP; the bridge polls from
    // 127.0.0.1 directly (no nginx in front). The IP check would otherwise
    // reject every bridge login.
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "bridge-token", "203.0.113.50");

    const res = mockRes();
    await handleAuthRoute(pollReq(nonce, "127.0.0.1"), res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ token: "bridge-token" });
  });

  it("trusts IPv6 loopback pollers (::1) with no proxy headers", async () => {
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "ipv6-bridge-token", "2001:db8::1");

    const res = mockRes();
    await handleAuthRoute(pollReq(nonce, "::1"), res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ token: "ipv6-bridge-token" });
  });

  it("trusts IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) with no proxy headers", async () => {
    // Node dual-stack listeners report IPv4 loopback connections as
    // `::ffff:127.0.0.1`; the bridge on Linux hits exactly this path.
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "dual-stack-token", "203.0.113.50");

    const res = mockRes();
    await handleAuthRoute(pollReq(nonce, "::ffff:127.0.0.1"), res, dummyConfig, db);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ token: "dual-stack-token" });
  });

  it("does NOT trust loopback when proxy headers are present (still enforces XFF)", async () => {
    // A request to loopback WITH X-Forwarded-For came through nginx — apply
    // the normal IP check using the forwarded value, not the loopback exemption.
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "xff-token", "203.0.113.50");

    const req = {
      method: "GET",
      url: `/auth/token-poll?nonce=${encodeURIComponent(nonce)}`,
      headers: { host: "localhost:3300", "x-forwarded-for": "198.51.100.7" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;

    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden." });
  });

  it("does NOT trust loopback when X-Real-IP is present (still enforces origin IP)", async () => {
    // Some nginx deployments set only X-Real-IP. The loopback exemption must
    // not silently bypass the check in that setup.
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "xri-token", "203.0.113.50");

    const req = {
      method: "GET",
      url: `/auth/token-poll?nonce=${encodeURIComponent(nonce)}`,
      headers: { host: "localhost:3300", "x-real-ip": "198.51.100.7" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;

    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden." });
  });

  it("does NOT trust loopback when X-Forwarded-For is present but empty", async () => {
    // Header *presence* (not truthiness) must suppress the exemption, so a
    // client sending `X-Forwarded-For: ` (empty value) can't opportunistically
    // slip through the loopback exemption.
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "empty-xff-token", "203.0.113.50");

    const req = {
      method: "GET",
      url: `/auth/token-poll?nonce=${encodeURIComponent(nonce)}`,
      headers: { host: "localhost:3300", "x-forwarded-for": "" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;

    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden." });
  });

  it("does NOT trust loopback when X-Real-IP is present but empty", async () => {
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "empty-xri-token", "203.0.113.50");

    const req = {
      method: "GET",
      url: `/auth/token-poll?nonce=${encodeURIComponent(nonce)}`,
      headers: { host: "localhost:3300", "x-real-ip": "" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;

    const res = mockRes();
    await handleAuthRoute(req, res, dummyConfig, db);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Forbidden." });
  });

  it("preserves the nonce when loopback+XFF mismatch triggers 403", async () => {
    // A 403 from the XFF mismatch path must not consume the nonce, so the
    // legitimate caller can still retrieve the token afterwards.
    const nonce = randomUUID();
    _insertCompletedLogin(nonce, "preserved-xff-token", "203.0.113.50");

    const badReq = {
      method: "GET",
      url: `/auth/token-poll?nonce=${encodeURIComponent(nonce)}`,
      headers: { host: "localhost:3300", "x-forwarded-for": "198.51.100.7" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    const bad = mockRes();
    await handleAuthRoute(badReq, bad, dummyConfig, db);
    expect(bad.statusCode).toBe(403);

    // Correct origin IP via XFF still succeeds
    const goodReq = {
      method: "GET",
      url: `/auth/token-poll?nonce=${encodeURIComponent(nonce)}`,
      headers: { host: "localhost:3300", "x-forwarded-for": "203.0.113.50" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
    const good = mockRes();
    await handleAuthRoute(goodReq, good, dummyConfig, db);
    expect(good.statusCode).toBe(200);
    expect(JSON.parse(good.body)).toEqual({ token: "preserved-xff-token" });
  });
});

// ─── /auth/login — login_nonce validation ────────────────────────────────────

describe("handleAuthRoute — /auth/login login_nonce validation", () => {
  const config: OAuthConfig = {
    github: { clientId: "gh-id", clientSecret: "gh-secret", callbackUrl: "http://localhost:3300/auth/callback" },
  };

  function loginReqWithNonce(nonce: string): IncomingMessage {
    return {
      method: "GET",
      url: `/auth/login?provider=github&login_nonce=${encodeURIComponent(nonce)}`,
      headers: { host: "localhost:3300" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;
  }

  it("returns 400 for a non-UUID login_nonce", async () => {
    const res = mockRes();
    await handleAuthRoute(loginReqWithNonce("not-a-uuid"), res, config, db);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Invalid login_nonce");
  });

  it("accepts a valid UUID login_nonce", async () => {
    const res = mockRes();
    await handleAuthRoute(loginReqWithNonce(randomUUID()), res, config, db);
    expect(res.statusCode).toBe(302);
  });
});

// ─── CORS origin tests ──────────────────────────────────────────────────────

describe("setCorsHeaders / handleCorsPreflightIfNeeded", () => {
  it("sets CORS headers for an allowed origin", () => {
    const req = { headers: { origin: "tauri://localhost" } } as unknown as IncomingMessage;
    const res = mockRes();
    setCorsHeaders(req, res);
    expect(res._headers["access-control-allow-origin"]).toBe("tauri://localhost");
    expect(res._headers["vary"]).toBe("Origin");
  });

  it("does not set CORS headers for a disallowed origin", () => {
    const req = { headers: { origin: "https://evil.example.com" } } as unknown as IncomingMessage;
    const res = mockRes();
    setCorsHeaders(req, res);
    expect(res._headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("handleCorsPreflightIfNeeded returns true and ends 204 for OPTIONS", () => {
    const req = { method: "OPTIONS", headers: { origin: "tauri://localhost" } } as unknown as IncomingMessage;
    const res = mockRes();
    const handled = handleCorsPreflightIfNeeded(req, res);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res._headers["access-control-allow-origin"]).toBe("tauri://localhost");
  });

  it("handleCorsPreflightIfNeeded returns false for non-OPTIONS", () => {
    const req = { method: "GET", headers: { origin: "tauri://localhost" } } as unknown as IncomingMessage;
    const res = mockRes();
    const handled = handleCorsPreflightIfNeeded(req, res);
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(0);
  });
});
