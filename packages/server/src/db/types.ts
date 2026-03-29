import type { PlayerRecord, DefeatedNpcRecord, EquipSlot } from "@muddown/shared";

// ─── Database Abstraction ────────────────────────────────────────────────────
// All persistence goes through this interface so the storage backend
// (SQLite today, Postgres/etc. tomorrow) can be swapped without touching
// game logic.

export interface GameDatabase {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  close(): void;

  // ── Players ──────────────────────────────────────────────────────────────
  getPlayerByGithubId(githubId: string): PlayerRecord | undefined;
  getPlayerById(id: string): PlayerRecord | undefined;
  upsertPlayer(player: PlayerRecord): void;
  savePlayerState(id: string, state: PlayerStateUpdate): void;

  // ── World State: Room Items ──────────────────────────────────────────────
  getRoomItems(roomId: string): string[];
  setRoomItems(roomId: string, itemIds: string[]): void;
  getAllRoomItems(): Map<string, string[]>;
  saveAllRoomItems(roomItems: Map<string, string[]>): void;

  // ── World State: Defeated NPCs ───────────────────────────────────────────
  getDefeatedNpcs(): DefeatedNpcRecord[];
  addDefeatedNpc(record: DefeatedNpcRecord): void;
  removeDefeatedNpc(npcId: string): void;

  // ── World State: NPC HP (damaged but alive) ──────────────────────────────
  getNpcHp(roomId: string, npcId: string): number | undefined;
  setNpcHp(roomId: string, npcId: string, hp: number): void;
  removeNpcHp(roomId: string, npcId: string): void;
  getAllNpcHp(): Map<string, number>;  // key = "roomId:npcId"
  saveAllNpcHp(hpMap: Map<string, number>): void;

  // ── Auth Sessions ────────────────────────────────────────────────────────
  getSession(token: string): AuthSession | undefined;
  createSession(session: AuthSession): void;
  deleteSession(token: string): void;
  cleanExpiredSessions(): void;
}

// ── Supporting Types ──────────────────────────────────────────────────────────

export interface PlayerStateUpdate {
  currentRoom?: string;
  inventory?: string[];
  equipped?: Record<EquipSlot, string | null>;
  hp?: number;
  maxHp?: number;
  xp?: number;
}

export interface AuthSession {
  token: string;
  playerId: string;
  expiresAt: string; // ISO 8601
}
