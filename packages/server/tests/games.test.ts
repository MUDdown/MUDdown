import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SqliteDatabase } from "../src/db/sqlite.js";
import type { GameDatabase, GameServerUpdate } from "../src/db/types.js";
import type { GameServerRecord, AccountRecord } from "@muddown/shared";

let db: GameDatabase;
let tmpDir: string;
let testAccount: AccountRecord;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "muddown-games-test-"));
  db = new SqliteDatabase(join(tmpDir, "test.sqlite"));

  // Create a test account for ownership
  testAccount = {
    id: randomUUID(),
    displayName: "Test User",
    displayNameOverridden: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.createAccount(testAccount);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeServer(overrides: Partial<GameServerRecord> = {}): GameServerRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    ownerId: testAccount.id,
    name: "Test MUD",
    description: "A test server",
    hostname: "mud.example.com",
    port: 3300,
    protocol: "websocket",
    websiteUrl: "https://mud.example.com",
    certification: "listed",
    lastCheckAt: null,
    lastCheckResult: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("game servers CRUD", () => {
  it("creates and retrieves a server", () => {
    const server = makeServer();
    db.createGameServer(server);

    const retrieved = db.getGameServer(server.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.name).toBe("Test MUD");
    expect(retrieved!.hostname).toBe("mud.example.com");
    expect(retrieved!.port).toBe(3300);
    expect(retrieved!.protocol).toBe("websocket");
    expect(retrieved!.certification).toBe("listed");
    expect(retrieved!.ownerId).toBe(testAccount.id);
  });

  it("returns undefined for nonexistent server", () => {
    expect(db.getGameServer(randomUUID())).toBeUndefined();
  });

  it("lists servers by owner", () => {
    const s1 = makeServer({ name: "Owner Server 1" });
    const s2 = makeServer({ name: "Owner Server 2" });
    db.createGameServer(s1);
    db.createGameServer(s2);

    const owned = db.getGameServersByOwner(testAccount.id);
    const ids = owned.map(s => s.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
  });

  it("lists all servers", () => {
    const s1 = makeServer({ name: "All Server 1" });
    const s2 = makeServer({ name: "All Server 2" });
    db.createGameServer(s1);
    db.createGameServer(s2);

    const all = db.getAllGameServers();
    expect(all.length).toBe(2);
  });

  it("updates a server", () => {
    const server = makeServer({ name: "Before Update" });
    db.createGameServer(server);

    const update: GameServerUpdate = {
      name: "After Update",
      description: "Updated description",
      port: 4400,
      certification: "self-certified",
    };
    db.updateGameServer(server.id, update);

    const updated = db.getGameServer(server.id);
    expect(updated).toBeDefined();
    expect(updated!.name).toBe("After Update");
    expect(updated!.description).toBe("Updated description");
    expect(updated!.port).toBe(4400);
    expect(updated!.certification).toBe("self-certified");
    // Unchanged fields
    expect(updated!.hostname).toBe("mud.example.com");
    expect(updated!.protocol).toBe("websocket");
  });

  it("deletes a server", () => {
    const server = makeServer({ name: "To Delete" });
    db.createGameServer(server);
    expect(db.getGameServer(server.id)).toBeDefined();

    db.deleteGameServer(server.id);
    expect(db.getGameServer(server.id)).toBeUndefined();
  });

  it("updates compliance check results", () => {
    const server = makeServer({ name: "Check Target", certification: "listed" });
    db.createGameServer(server);

    const result = JSON.stringify({ reachable: true, wireProtocol: true, containerBlocks: true, errors: [] });
    db.updateGameServerCheck(server.id, result, "verified");

    const updated = db.getGameServer(server.id);
    expect(updated).toBeDefined();
    expect(updated!.certification).toBe("verified");
    expect(updated!.lastCheckAt).toBeTruthy();
    expect(updated!.lastCheckResult).toBe(result);
  });

  it("cascades delete when account is removed", () => {
    const tempAccount: AccountRecord = {
      id: randomUUID(),
      displayName: "Temp",
      displayNameOverridden: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.createAccount(tempAccount);

    const server = makeServer({ ownerId: tempAccount.id, name: "Cascade Test" });
    db.createGameServer(server);
    expect(db.getGameServer(server.id)).toBeDefined();

    db.deleteAccount(tempAccount.id);
    expect(db.getGameServer(server.id)).toBeUndefined();
  });

  it("stores null port and null websiteUrl", () => {
    const server = makeServer({ port: null, websiteUrl: null, name: "Null Fields" });
    db.createGameServer(server);

    const retrieved = db.getGameServer(server.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.port).toBeNull();
    expect(retrieved!.websiteUrl).toBeNull();
  });

  it("preserves all protocol types", () => {
    for (const protocol of ["websocket", "telnet", "mcp", "other"] as const) {
      const server = makeServer({ name: `Proto ${protocol}`, protocol });
      db.createGameServer(server);
      const retrieved = db.getGameServer(server.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.protocol).toBe(protocol);
    }
  });

  it("clears port when updated to null", () => {
    const server = makeServer({ port: 3300, name: "Port Clear Test" });
    db.createGameServer(server);

    db.updateGameServer(server.id, { port: null });

    const updated = db.getGameServer(server.id);
    expect(updated).toBeDefined();
    expect(updated!.port).toBeNull();
    // Other fields unchanged
    expect(updated!.name).toBe("Port Clear Test");
  });
});
