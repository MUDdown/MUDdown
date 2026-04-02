import type { DefeatedNpcRecord, EquipSlot, AccountRecord, CharacterRecord, IdentityLinkRecord, OAuthProvider } from "@muddown/shared";

// ─── Database Abstraction ────────────────────────────────────────────────────
// All persistence goes through this interface so the storage backend
// (SQLite today, Postgres/etc. tomorrow) can be swapped without touching
// game logic.

export interface GameDatabase {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  close(): void;

  // ── Accounts ─────────────────────────────────────────────────────────────
  getAccountById(id: string): AccountRecord | undefined;
  createAccount(account: AccountRecord): void;
  updateAccountDisplayName(id: string, displayName: string): void;
  deleteAccount(id: string): void;

  // ── Identity Links ───────────────────────────────────────────────────────
  getIdentityLink(provider: OAuthProvider, providerId: string): IdentityLinkRecord | undefined;
  getIdentityLinksByAccount(accountId: string): IdentityLinkRecord[];
  createIdentityLink(link: IdentityLinkRecord): void;
  deleteIdentityLink(provider: OAuthProvider, providerId: string): void;

  // ── Characters ───────────────────────────────────────────────────────────
  getCharacterById(id: string): CharacterRecord | undefined;
  getCharactersByAccount(accountId: string): CharacterRecord[];
  getCharacterByName(name: string): CharacterRecord | undefined;
  createCharacter(character: CharacterRecord): void;
  saveCharacterState(id: string, state: CharacterStateUpdate): void;

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
  updateSessionCharacter(token: string, characterId: string | null): void;
  deleteSession(token: string): void;
  cleanExpiredSessions(): void;
}

// ── Supporting Types ──────────────────────────────────────────────────────────


export interface CharacterStateUpdate {
  currentRoom?: string;
  inventory?: string[];
  equipped?: Record<EquipSlot, string | null>;
  hp?: number;
  maxHp?: number;
  xp?: number;
}

export interface AuthSession {
  token: string;
  accountId: string;
  activeCharacterId: string | null;
  expiresAt: string; // ISO 8601
}
