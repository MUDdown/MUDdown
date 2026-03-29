import Database from "better-sqlite3";
import type { PlayerRecord, DefeatedNpcRecord, EquipSlot } from "@muddown/shared";
import type { GameDatabase, PlayerStateUpdate, AuthSession } from "./types.js";

export class SqliteDatabase implements GameDatabase {
  private db: Database.Database;

  constructor(filepath: string) {
    this.db = new Database(filepath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id          TEXT PRIMARY KEY,
        github_id   TEXT UNIQUE NOT NULL,
        username    TEXT NOT NULL,
        display_name TEXT NOT NULL,
        current_room TEXT NOT NULL DEFAULT 'town-square',
        inventory   TEXT NOT NULL DEFAULT '[]',
        equipped    TEXT NOT NULL DEFAULT '{"weapon":null,"armor":null,"accessory":null}',
        hp          INTEGER NOT NULL DEFAULT 20,
        max_hp      INTEGER NOT NULL DEFAULT 20,
        xp          INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS room_items (
        room_id  TEXT PRIMARY KEY,
        item_ids TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS defeated_npcs (
        npc_id      TEXT PRIMARY KEY,
        room_id     TEXT NOT NULL,
        defeated_at TEXT NOT NULL,
        respawn_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS npc_hp (
        room_id TEXT NOT NULL,
        npc_id  TEXT NOT NULL,
        hp      INTEGER NOT NULL,
        PRIMARY KEY (room_id, npc_id)
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token      TEXT PRIMARY KEY,
        player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ── Players ──────────────────────────────────────────────────────────────

  getPlayerByGithubId(githubId: string): PlayerRecord | undefined {
    const row = this.db.prepare("SELECT * FROM players WHERE github_id = ?").get(githubId) as PlayerRow | undefined;
    return row ? rowToPlayer(row) : undefined;
  }

  getPlayerById(id: string): PlayerRecord | undefined {
    const row = this.db.prepare("SELECT * FROM players WHERE id = ?").get(id) as PlayerRow | undefined;
    return row ? rowToPlayer(row) : undefined;
  }

  upsertPlayer(player: PlayerRecord): void {
    this.db.prepare(`
      INSERT INTO players (id, github_id, username, display_name, current_room, inventory, equipped, hp, max_hp, xp, created_at, updated_at)
      VALUES (@id, @githubId, @username, @displayName, @currentRoom, @inventory, @equipped, @hp, @maxHp, @xp, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        username = @username,
        display_name = @displayName,
        current_room = @currentRoom,
        inventory = @inventory,
        equipped = @equipped,
        hp = @hp,
        max_hp = @maxHp,
        xp = @xp,
        updated_at = @updatedAt
    `).run({
      id: player.id,
      githubId: player.githubId,
      username: player.username,
      displayName: player.displayName,
      currentRoom: player.currentRoom,
      inventory: JSON.stringify(player.inventory),
      equipped: JSON.stringify(player.equipped),
      hp: player.hp,
      maxHp: player.maxHp,
      xp: player.xp,
      createdAt: player.createdAt,
      updatedAt: player.updatedAt,
    });
  }

  savePlayerState(id: string, state: PlayerStateUpdate): void {
    const sets: string[] = ["updated_at = datetime('now')"];
    const params: Record<string, unknown> = { id };

    if (state.currentRoom !== undefined) {
      sets.push("current_room = @currentRoom");
      params.currentRoom = state.currentRoom;
    }
    if (state.inventory !== undefined) {
      sets.push("inventory = @inventory");
      params.inventory = JSON.stringify(state.inventory);
    }
    if (state.equipped !== undefined) {
      sets.push("equipped = @equipped");
      params.equipped = JSON.stringify(state.equipped);
    }
    if (state.hp !== undefined) {
      sets.push("hp = @hp");
      params.hp = state.hp;
    }
    if (state.maxHp !== undefined) {
      sets.push("max_hp = @maxHp");
      params.maxHp = state.maxHp;
    }
    if (state.xp !== undefined) {
      sets.push("xp = @xp");
      params.xp = state.xp;
    }

    this.db.prepare(`UPDATE players SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  // ── Room Items ───────────────────────────────────────────────────────────

  getRoomItems(roomId: string): string[] {
    const row = this.db.prepare("SELECT item_ids FROM room_items WHERE room_id = ?").get(roomId) as { item_ids: string } | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.item_ids) as string[];
    } catch {
      console.error(`Corrupt item_ids JSON for room "${roomId}": ${row.item_ids}`);
      return [];
    }
  }

  setRoomItems(roomId: string, itemIds: string[]): void {
    this.db.prepare(`
      INSERT INTO room_items (room_id, item_ids) VALUES (?, ?)
      ON CONFLICT(room_id) DO UPDATE SET item_ids = excluded.item_ids
    `).run(roomId, JSON.stringify(itemIds));
  }

  getAllRoomItems(): Map<string, string[]> {
    const rows = this.db.prepare("SELECT room_id, item_ids FROM room_items").all() as Array<{ room_id: string; item_ids: string }>;
    const map = new Map<string, string[]>();
    for (const row of rows) {
      try {
        map.set(row.room_id, JSON.parse(row.item_ids) as string[]);
      } catch {
        console.error(`Corrupt item_ids JSON for room "${row.room_id}": ${row.item_ids}`);
      }
    }
    return map;
  }

  saveAllRoomItems(roomItems: Map<string, string[]>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM room_items").run();
      const stmt = this.db.prepare("INSERT INTO room_items (room_id, item_ids) VALUES (?, ?)");
      for (const [roomId, itemIds] of roomItems) {
        stmt.run(roomId, JSON.stringify(itemIds));
      }
    });
    tx();
  }

  // ── Defeated NPCs ───────────────────────────────────────────────────────

  getDefeatedNpcs(): DefeatedNpcRecord[] {
    const rows = this.db.prepare("SELECT * FROM defeated_npcs").all() as DefeatedNpcRow[];
    return rows.map((row) => ({
      npcId: row.npc_id,
      roomId: row.room_id,
      defeatedAt: row.defeated_at,
      respawnAt: row.respawn_at,
    }));
  }

  addDefeatedNpc(record: DefeatedNpcRecord): void {
    this.db.prepare(`
      INSERT INTO defeated_npcs (npc_id, room_id, defeated_at, respawn_at)
      VALUES (@npcId, @roomId, @defeatedAt, @respawnAt)
      ON CONFLICT(npc_id) DO UPDATE SET
        room_id = @roomId, defeated_at = @defeatedAt, respawn_at = @respawnAt
    `).run({
      npcId: record.npcId,
      roomId: record.roomId,
      defeatedAt: record.defeatedAt,
      respawnAt: record.respawnAt,
    });
  }

  removeDefeatedNpc(npcId: string): void {
    this.db.prepare("DELETE FROM defeated_npcs WHERE npc_id = ?").run(npcId);
  }

  // ── NPC HP ──────────────────────────────────────────────────────────────

  getNpcHp(roomId: string, npcId: string): number | undefined {
    const row = this.db.prepare("SELECT hp FROM npc_hp WHERE room_id = ? AND npc_id = ?").get(roomId, npcId) as { hp: number } | undefined;
    return row?.hp;
  }

  setNpcHp(roomId: string, npcId: string, hp: number): void {
    this.db.prepare(
      "INSERT INTO npc_hp (room_id, npc_id, hp) VALUES (?, ?, ?) ON CONFLICT(room_id, npc_id) DO UPDATE SET hp = excluded.hp",
    ).run(roomId, npcId, hp);
  }

  removeNpcHp(roomId: string, npcId: string): void {
    this.db.prepare("DELETE FROM npc_hp WHERE room_id = ? AND npc_id = ?").run(roomId, npcId);
  }

  getAllNpcHp(): Map<string, number> {
    const rows = this.db.prepare("SELECT room_id, npc_id, hp FROM npc_hp").all() as Array<{ room_id: string; npc_id: string; hp: number }>;
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(`${row.room_id}:${row.npc_id}`, row.hp);
    }
    return map;
  }

  saveAllNpcHp(hpMap: Map<string, number>): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM npc_hp").run();
      const stmt = this.db.prepare("INSERT INTO npc_hp (room_id, npc_id, hp) VALUES (?, ?, ?)");
      for (const [key, hp] of hpMap) {
        const sep = key.indexOf(":");
        const roomId = key.substring(0, sep);
        const npcId = key.substring(sep + 1);
        stmt.run(roomId, npcId, hp);
      }
    });
    tx();
  }

  // ── Auth Sessions ────────────────────────────────────────────────────────

  getSession(token: string): AuthSession | undefined {
    const row = this.db.prepare("SELECT token, player_id, expires_at FROM auth_sessions WHERE token = ? AND expires_at > ?").get(token, new Date().toISOString()) as { token: string; player_id: string; expires_at: string } | undefined;
    if (!row) return undefined;
    return { token: row.token, playerId: row.player_id, expiresAt: row.expires_at };
  }

  createSession(session: AuthSession): void {
    this.db.prepare("INSERT INTO auth_sessions (token, player_id, expires_at) VALUES (?, ?, ?)").run(session.token, session.playerId, session.expiresAt);
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
  }

  cleanExpiredSessions(): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(new Date().toISOString());
  }
}

// ── Internal row types ────────────────────────────────────────────────────────

interface PlayerRow {
  id: string;
  github_id: string;
  username: string;
  display_name: string;
  current_room: string;
  inventory: string;
  equipped: string;
  hp: number;
  max_hp: number;
  xp: number;
  created_at: string;
  updated_at: string;
}

interface DefeatedNpcRow {
  npc_id: string;
  room_id: string;
  defeated_at: string;
  respawn_at: string;
}

function rowToPlayer(row: PlayerRow): PlayerRecord {
  return {
    id: row.id,
    githubId: row.github_id,
    username: row.username,
    displayName: row.display_name,
    currentRoom: row.current_room,
    inventory: JSON.parse(row.inventory) as string[],
    equipped: JSON.parse(row.equipped) as Record<EquipSlot, string | null>,
    hp: row.hp,
    maxHp: row.max_hp,
    xp: row.xp,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
