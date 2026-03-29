import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteDatabase } from "../src/db/sqlite.js";
import type { GameDatabase } from "../src/db/types.js";
import type { PlayerRecord, DefeatedNpcRecord, EquipSlot } from "@muddown/shared";

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

// ─── Player CRUD ─────────────────────────────────────────────────────────────

describe("player operations", () => {
  const player: PlayerRecord = {
    id: "p-1",
    githubId: "gh-123",
    username: "testuser",
    displayName: "Test User",
    currentRoom: "town-square",
    inventory: ["sword", "shield"],
    equipped: { weapon: "sword", armor: null, accessory: null },
    hp: 18,
    maxHp: 20,
    xp: 50,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("upserts and retrieves a player by ID", () => {
    db.upsertPlayer(player);
    const found = db.getPlayerById("p-1");
    expect(found).toBeDefined();
    expect(found!.username).toBe("testuser");
    expect(found!.inventory).toEqual(["sword", "shield"]);
    expect(found!.equipped.weapon).toBe("sword");
  });

  it("retrieves by GitHub ID", () => {
    const found = db.getPlayerByGithubId("gh-123");
    expect(found).toBeDefined();
    expect(found!.id).toBe("p-1");
  });

  it("returns undefined for unknown IDs", () => {
    expect(db.getPlayerById("no-such-id")).toBeUndefined();
    expect(db.getPlayerByGithubId("no-such-gh")).toBeUndefined();
  });

  it("saves partial player state", () => {
    db.savePlayerState("p-1", { currentRoom: "bakery", hp: 15, xp: 100 });
    const found = db.getPlayerById("p-1");
    expect(found!.currentRoom).toBe("bakery");
    expect(found!.hp).toBe(15);
    expect(found!.xp).toBe(100);
    // Unchanged fields stay the same
    expect(found!.inventory).toEqual(["sword", "shield"]);
  });

  it("upsert updates existing player on conflict", () => {
    const updated: PlayerRecord = {
      ...player,
      displayName: "Updated User",
      hp: 20,
      updatedAt: new Date().toISOString(),
    };
    db.upsertPlayer(updated);
    const found = db.getPlayerById("p-1");
    expect(found!.displayName).toBe("Updated User");
  });
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
  it("creates and retrieves a session", () => {
    db.createSession({
      token: "tok-1",
      playerId: "p-1",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const session = db.getSession("tok-1");
    expect(session).toBeDefined();
    expect(session!.playerId).toBe("p-1");
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
      playerId: "p-1",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    // Create a valid session
    db.createSession({
      token: "tok-valid",
      playerId: "p-1",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    db.cleanExpiredSessions();

    expect(db.getSession("tok-expired")).toBeUndefined();
    expect(db.getSession("tok-valid")).toBeDefined();
  });
});
