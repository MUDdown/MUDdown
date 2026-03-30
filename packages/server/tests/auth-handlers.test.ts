import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { SqliteDatabase } from "../src/db/sqlite.js";
import type { GameDatabase, AuthSession } from "../src/db/types.js";
import { extractSessionToken, resolveSession, resolveTicket, CHARACTER_NAME_RE, _insertTicket, handleAuthRoute } from "../src/auth.js";
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
    db.createAccount({ id: accountId, displayName: "Resolver", createdAt: now, updatedAt: now });
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
    clientId: "test",
    clientSecret: "test",
    callbackUrl: "http://localhost:3300/auth/callback",
  };

  beforeAll(() => {
    const now = new Date().toISOString();

    // Create two accounts
    db.createAccount({ id: ownerAccountId, displayName: "Owner", createdAt: now, updatedAt: now });
    db.createAccount({ id: otherAccountId, displayName: "Other", createdAt: now, updatedAt: now });

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

  /** Build a mock ServerResponse that records writeHead/end calls. */
  function mockRes(): ServerResponse & { statusCode: number; body: string } {
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
    return res as unknown as ServerResponse & { statusCode: number; body: string };
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
