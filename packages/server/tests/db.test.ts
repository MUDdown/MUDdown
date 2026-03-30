import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteDatabase } from "../src/db/sqlite.js";
import type { GameDatabase } from "../src/db/types.js";
import type { DefeatedNpcRecord, AccountRecord, CharacterRecord } from "@muddown/shared";

let db: GameDatabase;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "muddown-db-test-"));
  db = new SqliteDatabase(join(tmpDir, "test.sqlite"));
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Room Items ──────────────────────────────────────────────────────────────

describe("room items", () => {
  it("stores and retrieves room items", () => {
    db.setRoomItems("town-square", ["sword", "potion"]);
    expect(db.getRoomItems("town-square")).toEqual(["sword", "potion"]);
  });

  it("returns empty array for unknown rooms", () => {
    expect(db.getRoomItems("nonexistent")).toEqual([]);
  });

  it("save/load all room items in bulk", () => {
    const items = new Map<string, string[]>();
    items.set("room-a", ["item-1"]);
    items.set("room-b", ["item-2", "item-3"]);

    db.saveAllRoomItems(items);
    const loaded = db.getAllRoomItems();
    expect(loaded.get("room-a")).toEqual(["item-1"]);
    expect(loaded.get("room-b")).toEqual(["item-2", "item-3"]);
  });

  it("bulk save replaces previous data", () => {
    db.setRoomItems("old-room", ["old-item"]);
    db.saveAllRoomItems(new Map([["new-room", ["new-item"]]]));
    const loaded = db.getAllRoomItems();
    expect(loaded.has("old-room")).toBe(false);
    expect(loaded.get("new-room")).toEqual(["new-item"]);
  });
});

// ─── Defeated NPCs ──────────────────────────────────────────────────────────

describe("defeated NPCs", () => {
  it("adds and retrieves defeated NPCs", () => {
    const record: DefeatedNpcRecord = {
      npcId: "goblin-1",
      roomId: "cave",
      defeatedAt: new Date().toISOString(),
      respawnAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    };
    db.addDefeatedNpc(record);

    const defeated = db.getDefeatedNpcs();
    const found = defeated.find((d) => d.npcId === "goblin-1");
    expect(found).toBeDefined();
    expect(found!.roomId).toBe("cave");
  });

  it("removes a defeated NPC", () => {
    db.removeDefeatedNpc("goblin-1");
    const defeated = db.getDefeatedNpcs();
    expect(defeated.find((d) => d.npcId === "goblin-1")).toBeUndefined();
  });

  it("upserts on conflict", () => {
    db.addDefeatedNpc({
      npcId: "goblin-2",
      roomId: "cave",
      defeatedAt: new Date().toISOString(),
      respawnAt: new Date(Date.now() + 10000).toISOString(),
    });
    // Update with new room
    db.addDefeatedNpc({
      npcId: "goblin-2",
      roomId: "forest",
      defeatedAt: new Date().toISOString(),
      respawnAt: new Date(Date.now() + 20000).toISOString(),
    });
    const defeated = db.getDefeatedNpcs();
    const found = defeated.find((d) => d.npcId === "goblin-2");
    expect(found!.roomId).toBe("forest");
  });
});

// ─── NPC HP ──────────────────────────────────────────────────────────────────

describe("NPC HP", () => {
  it("stores and retrieves NPC HP", () => {
    db.setNpcHp("cave", "goblin-1", 8);
    expect(db.getNpcHp("cave", "goblin-1")).toBe(8);
  });

  it("returns undefined for unknown NPC", () => {
    expect(db.getNpcHp("cave", "nobody")).toBeUndefined();
  });

  it("removes NPC HP", () => {
    db.setNpcHp("cave", "goblin-3", 5);
    db.removeNpcHp("cave", "goblin-3");
    expect(db.getNpcHp("cave", "goblin-3")).toBeUndefined();
  });

  it("save/load all NPC HP in bulk", () => {
    const hpMap = new Map<string, number>();
    hpMap.set("cave:goblin-1", 10);
    hpMap.set("forest:wolf-1", 5);

    db.saveAllNpcHp(hpMap);
    const loaded = db.getAllNpcHp();
    expect(loaded.get("cave:goblin-1")).toBe(10);
    expect(loaded.get("forest:wolf-1")).toBe(5);
  });
});

// ─── Auth Sessions ───────────────────────────────────────────────────────────

describe("auth sessions", () => {
  const testAccountId = "acc-sess-test";

  beforeAll(() => {
    const now = new Date().toISOString();
    db.createAccount({ id: testAccountId, displayName: "SessionTester", createdAt: now, updatedAt: now });
  });

  it("creates and retrieves a session", () => {
    db.createSession({
      token: "tok-1",
      accountId: testAccountId,
      activeCharacterId: null,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const session = db.getSession("tok-1");
    expect(session).toBeDefined();
    expect(session!.accountId).toBe(testAccountId);
  });

  it("returns undefined for unknown token", () => {
    expect(db.getSession("no-such-token")).toBeUndefined();
  });

  it("deletes a session", () => {
    db.deleteSession("tok-1");
    expect(db.getSession("tok-1")).toBeUndefined();
  });

  it("cleans expired sessions", () => {
    // Create an expired session
    db.createSession({
      token: "tok-expired",
      accountId: testAccountId,
      activeCharacterId: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    // Create a valid session
    db.createSession({
      token: "tok-valid",
      accountId: testAccountId,
      activeCharacterId: null,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    db.cleanExpiredSessions();

    expect(db.getSession("tok-expired")).toBeUndefined();
    expect(db.getSession("tok-valid")).toBeDefined();
  });

  it("updates active character on a session", () => {
    const now = new Date().toISOString();
    db.createCharacter({
      id: "char-xyz",
      accountId: testAccountId,
      name: "TestChar",
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
    db.createSession({
      token: "tok-update-char",
      accountId: testAccountId,
      activeCharacterId: null,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    db.updateSessionCharacter("tok-update-char", "char-xyz");
    const session = db.getSession("tok-update-char");
    expect(session).toBeDefined();
    expect(session!.activeCharacterId).toBe("char-xyz");
  });
});

// ─── Account Operations ──────────────────────────────────────────────────────

describe("account operations", () => {
  const now = new Date().toISOString();
  const account: AccountRecord = {
    id: "acc-op-1",
    displayName: "Adventurer",
    createdAt: now,
    updatedAt: now,
  };

  it("creates and retrieves an account", () => {
    db.createAccount(account);
    const found = db.getAccountById("acc-op-1");
    expect(found).toBeDefined();
    expect(found!.displayName).toBe("Adventurer");
  });

  it("returns undefined for unknown account", () => {
    expect(db.getAccountById("no-such-account")).toBeUndefined();
  });

  it("updates display name", () => {
    db.updateAccountDisplayName("acc-op-1", "Brave Adventurer");
    const found = db.getAccountById("acc-op-1");
    expect(found!.displayName).toBe("Brave Adventurer");
  });
});

// ─── Identity Link Operations ────────────────────────────────────────────────

describe("identity link operations", () => {
  const accountId = "acc-link-ops";

  beforeAll(() => {
    const now = new Date().toISOString();
    db.createAccount({ id: accountId, displayName: "LinkTester", createdAt: now, updatedAt: now });
  });

  it("creates and retrieves an identity link", () => {
    db.createIdentityLink({
      accountId,
      provider: "github",
      providerId: "gh-42",
      providerUsername: "hero42",
      linkedAt: new Date().toISOString(),
    });

    const link = db.getIdentityLink("github", "gh-42");
    expect(link).toBeDefined();
    expect(link!.accountId).toBe(accountId);
    expect(link!.providerUsername).toBe("hero42");
  });

  it("returns undefined for unknown provider/id pair", () => {
    expect(db.getIdentityLink("github", "unknown")).toBeUndefined();
  });

  it("lists all links for an account", () => {
    const before = db.getIdentityLinksByAccount(accountId);
    const initialCount = before.length;

    db.createIdentityLink({
      accountId,
      provider: "github",
      providerId: "gh-99",
      providerUsername: "hero_alt",
      linkedAt: new Date().toISOString(),
    });

    const after = db.getIdentityLinksByAccount(accountId);
    expect(after).toHaveLength(initialCount + 1);
    expect(after.map(l => l.providerId)).toContain("gh-99");
  });

  it("deletes an identity link", () => {
    db.createIdentityLink({
      accountId,
      provider: "github",
      providerId: "gh-delete-test",
      providerUsername: "hero_del",
      linkedAt: new Date().toISOString(),
    });
    expect(db.getIdentityLink("github", "gh-delete-test")).toBeDefined();

    db.deleteIdentityLink("github", "gh-delete-test");
    expect(db.getIdentityLink("github", "gh-delete-test")).toBeUndefined();
  });

  it("deleteIdentityLink is a no-op for missing link", () => {
    // Should not throw
    db.deleteIdentityLink("github", "nonexistent");
  });
});

// ─── Character Operations ────────────────────────────────────────────────────

describe("character operations", () => {
  const accountId = "acc-char-ops";
  const now = new Date().toISOString();

  beforeAll(() => {
    db.createAccount({ id: accountId, displayName: "CharTester", createdAt: now, updatedAt: now });
  });

  const character: CharacterRecord = {
    id: "char-1",
    accountId,
    name: "Thorin",
    characterClass: "warrior",
    currentRoom: "town-square",
    inventory: ["shortsword"],
    equipped: { weapon: "shortsword", armor: null, accessory: null },
    hp: 25,
    maxHp: 25,
    xp: 0,
    createdAt: now,
    updatedAt: now,
  };

  it("creates and retrieves a character by ID", () => {
    db.createCharacter(character);
    const found = db.getCharacterById("char-1");
    expect(found).toBeDefined();
    expect(found!.name).toBe("Thorin");
    expect(found!.characterClass).toBe("warrior");
    expect(found!.inventory).toEqual(["shortsword"]);
    expect(found!.equipped.weapon).toBe("shortsword");
  });

  it("retrieves a character by name (case-insensitive)", () => {
    const found = db.getCharacterByName("thorin");
    expect(found).toBeDefined();
    expect(found!.id).toBe("char-1");
  });

  it("returns undefined for unknown character", () => {
    expect(db.getCharacterById("no-such-char")).toBeUndefined();
    expect(db.getCharacterByName("Nobody")).toBeUndefined();
  });

  it("lists characters for an account", () => {
    const listAccountId = "acc-list-chars";
    const listNow = new Date().toISOString();
    db.createAccount({ id: listAccountId, displayName: "Lister", createdAt: listNow, updatedAt: listNow });

    const first: CharacterRecord = {
      id: "char-list-1",
      accountId: listAccountId,
      name: "Thorin List",
      characterClass: "warrior",
      currentRoom: "town-square",
      inventory: [],
      equipped: { weapon: null, armor: null, accessory: null },
      hp: 25,
      maxHp: 25,
      xp: 0,
      createdAt: listNow,
      updatedAt: listNow,
    };
    const second: CharacterRecord = {
      id: "char-list-2",
      accountId: listAccountId,
      name: "Elara List",
      characterClass: "mage",
      currentRoom: "town-square",
      inventory: [],
      equipped: { weapon: null, armor: null, accessory: null },
      hp: 15,
      maxHp: 15,
      xp: 0,
      createdAt: listNow,
      updatedAt: listNow,
    };
    db.createCharacter(first);
    db.createCharacter(second);

    const chars = db.getCharactersByAccount(listAccountId);
    expect(chars).toHaveLength(2);
    const names = chars.map(c => c.name).sort();
    expect(names).toEqual(["Elara List", "Thorin List"]);
  });

  it("saves character state updates", () => {
    db.saveCharacterState("char-1", {
      currentRoom: "bakery",
      inventory: ["shortsword", "bread"],
      equipped: { weapon: "shortsword", armor: null, accessory: null },
      hp: 20,
      xp: 100,
    });

    const found = db.getCharacterById("char-1");
    expect(found!.currentRoom).toBe("bakery");
    expect(found!.inventory).toEqual(["shortsword", "bread"]);
    expect(found!.hp).toBe(20);
    expect(found!.xp).toBe(100);
  });
});

// ─── Migration / Schema Validation ───────────────────────────────────────────

describe("schema migration", () => {
  it("creates a fresh database with all expected tables", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "muddown-db-migrate-"));
    const freshDb = new SqliteDatabase(join(freshDir, "fresh.sqlite"));
    try {
      // Verify core tables exist by performing basic operations without error
      freshDb.getRoomItems("x");
      freshDb.getDefeatedNpcs();
      freshDb.getNpcHp("x", "x");
      freshDb.getSession("x");
      freshDb.getAccountById("x");
      freshDb.getIdentityLink("github", "x");
      freshDb.getCharacterById("x");
    } finally {
      freshDb.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it("reopening an existing database does not error", () => {
    const reuseDir = mkdtempSync(join(tmpdir(), "muddown-db-reopen-"));
    const dbPath = join(reuseDir, "reuse.sqlite");
    try {
      const first = new SqliteDatabase(dbPath);
      first.close();

      // Re-open — migrations should be idempotent
      const second = new SqliteDatabase(dbPath);
      second.getAccountById("x");
      second.close();
    } finally {
      rmSync(reuseDir, { recursive: true, force: true });
    }
  });
});
