import Database from "better-sqlite3";
import type { DefeatedNpcRecord, EquipSlot, AccountRecord, CharacterRecord, CharacterClass, IdentityLinkRecord, OAuthProvider } from "@muddown/shared";
import { isCharacterClass, isOAuthProvider } from "@muddown/shared";
import type { GameDatabase, CharacterStateUpdate, AuthSession } from "./types.js";

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

      CREATE TABLE IF NOT EXISTS accounts (
        id           TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE TABLE IF NOT EXISTS identity_links (
        account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider          TEXT NOT NULL,
        provider_id       TEXT NOT NULL,
        provider_username TEXT NOT NULL,
        linked_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (provider, provider_id)
      );

      CREATE INDEX IF NOT EXISTS idx_identity_links_account ON identity_links(account_id);

      CREATE TABLE IF NOT EXISTS characters (
        id              TEXT PRIMARY KEY,
        account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name            TEXT NOT NULL UNIQUE,
        character_class TEXT NOT NULL DEFAULT 'warrior',
        current_room    TEXT NOT NULL DEFAULT 'town-square',
        inventory       TEXT NOT NULL DEFAULT '[]',
        equipped        TEXT NOT NULL DEFAULT '{"weapon":null,"armor":null,"accessory":null}',
        hp              INTEGER NOT NULL DEFAULT 20,
        max_hp          INTEGER NOT NULL DEFAULT 20,
        xp              INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_characters_account ON characters(account_id);
      CREATE INDEX IF NOT EXISTS idx_characters_name ON characters(name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token               TEXT PRIMARY KEY,
        account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        active_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
        expires_at          TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ── Accounts ─────────────────────────────────────────────────────────────

  getAccountById(id: string): AccountRecord | undefined {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? { id: row.id, displayName: row.display_name, createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  createAccount(account: AccountRecord): void {
    this.db.prepare("INSERT INTO accounts (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      account.id, account.displayName, account.createdAt, account.updatedAt,
    );
  }

  updateAccountDisplayName(id: string, displayName: string): void {
    this.db.prepare("UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?").run(
      displayName, new Date().toISOString(), id,
    );
  }

  // ── Identity Links ───────────────────────────────────────────────────────

  getIdentityLink(provider: OAuthProvider, providerId: string): IdentityLinkRecord | undefined {
    const row = this.db.prepare("SELECT * FROM identity_links WHERE provider = ? AND provider_id = ?").get(provider, providerId) as IdentityLinkRow | undefined;
    return row ? { accountId: row.account_id, provider: isOAuthProvider(row.provider) ? row.provider : (() => {
      console.error(`Unknown OAuth provider "${row.provider}" for account ${row.account_id}`);
      return "github" as OAuthProvider;
    })(), providerId: row.provider_id, providerUsername: row.provider_username, linkedAt: row.linked_at } : undefined;
  }

  getIdentityLinksByAccount(accountId: string): IdentityLinkRecord[] {
    const rows = this.db.prepare("SELECT * FROM identity_links WHERE account_id = ?").all(accountId) as IdentityLinkRow[];
    return rows.map(row => ({ accountId: row.account_id, provider: isOAuthProvider(row.provider) ? row.provider : (() => {
      console.error(`Unknown OAuth provider "${row.provider}" for account ${row.account_id}`);
      return "github" as OAuthProvider;
    })(), providerId: row.provider_id, providerUsername: row.provider_username, linkedAt: row.linked_at }));
  }

  createIdentityLink(link: IdentityLinkRecord): void {
    this.db.prepare("INSERT INTO identity_links (account_id, provider, provider_id, provider_username, linked_at) VALUES (?, ?, ?, ?, ?)").run(
      link.accountId, link.provider, link.providerId, link.providerUsername, link.linkedAt,
    );
  }

  deleteIdentityLink(provider: OAuthProvider, providerId: string): void {
    this.db.prepare("DELETE FROM identity_links WHERE provider = ? AND provider_id = ?").run(provider, providerId);
  }

  // ── Characters ───────────────────────────────────────────────────────────

  getCharacterById(id: string): CharacterRecord | undefined {
    const row = this.db.prepare("SELECT * FROM characters WHERE id = ?").get(id) as CharacterRow | undefined;
    return row ? rowToCharacter(row) : undefined;
  }

  getCharactersByAccount(accountId: string): CharacterRecord[] {
    const rows = this.db.prepare("SELECT * FROM characters WHERE account_id = ? ORDER BY created_at ASC").all(accountId) as CharacterRow[];
    return rows.map(rowToCharacter);
  }

  getCharacterByName(name: string): CharacterRecord | undefined {
    const row = this.db.prepare("SELECT * FROM characters WHERE name = ? COLLATE NOCASE").get(name) as CharacterRow | undefined;
    return row ? rowToCharacter(row) : undefined;
  }

  createCharacter(character: CharacterRecord): void {
    this.db.prepare(`
      INSERT INTO characters (id, account_id, name, character_class, current_room, inventory, equipped, hp, max_hp, xp, created_at, updated_at)
      VALUES (@id, @accountId, @name, @characterClass, @currentRoom, @inventory, @equipped, @hp, @maxHp, @xp, @createdAt, @updatedAt)
    `).run({
      id: character.id,
      accountId: character.accountId,
      name: character.name,
      characterClass: character.characterClass,
      currentRoom: character.currentRoom,
      inventory: JSON.stringify(character.inventory),
      equipped: JSON.stringify(character.equipped),
      hp: character.hp,
      maxHp: character.maxHp,
      xp: character.xp,
      createdAt: character.createdAt,
      updatedAt: character.updatedAt,
    });
  }

  saveCharacterState(id: string, state: CharacterStateUpdate): void {
    const sets: string[] = ["updated_at = @updatedAt"];
    const params: Record<string, unknown> = { id, updatedAt: new Date().toISOString() };

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

    this.db.prepare(`UPDATE characters SET ${sets.join(", ")} WHERE id = @id`).run(params);
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
    const row = this.db.prepare("SELECT token, account_id, active_character_id, expires_at FROM auth_sessions WHERE token = ?").get(token) as { token: string; account_id: string; active_character_id: string | null; expires_at: string } | undefined;
    if (!row) return undefined;
    return { token: row.token, accountId: row.account_id, activeCharacterId: row.active_character_id, expiresAt: row.expires_at };
  }

  createSession(session: AuthSession): void {
    this.db.prepare("INSERT INTO auth_sessions (token, account_id, active_character_id, expires_at) VALUES (?, ?, ?, ?)").run(session.token, session.accountId, session.activeCharacterId, session.expiresAt);
  }

  updateSessionCharacter(token: string, characterId: string): void {
    this.db.prepare("UPDATE auth_sessions SET active_character_id = ? WHERE token = ?").run(characterId, token);
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(token);
  }

  cleanExpiredSessions(): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(new Date().toISOString());
  }
}

// ── Internal row types ────────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

interface IdentityLinkRow {
  account_id: string;
  provider: string;
  provider_id: string;
  provider_username: string;
  linked_at: string;
}

interface CharacterRow {
  id: string;
  account_id: string;
  name: string;
  character_class: string;
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

function rowToCharacter(row: CharacterRow): CharacterRecord {
  let inventory: string[];
  try {
    inventory = JSON.parse(row.inventory) as string[];
  } catch {
    console.error(`Corrupt inventory JSON for character ${row.id}, resetting to []`);
    inventory = [];
  }

  let equipped: Record<EquipSlot, string | null>;
  try {
    equipped = JSON.parse(row.equipped) as Record<EquipSlot, string | null>;
  } catch {
    console.error(`Corrupt equipped JSON for character ${row.id}, resetting to defaults`);
    equipped = { weapon: null, armor: null, accessory: null };
  }

  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    characterClass: (() => {
      if (!isCharacterClass(row.character_class)) {
        console.error(
          `Character ${row.id} ("${row.name}") has unrecognized class ` +
          `"${row.character_class}" — defaulting to warrior. ` +
          `This indicates a data integrity issue.`
        );
        return "warrior" as CharacterClass;
      }
      return row.character_class;
    })(),
    currentRoom: row.current_room,
    inventory,
    equipped,
    hp: row.hp,
    maxHp: row.max_hp,
    xp: row.xp,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
