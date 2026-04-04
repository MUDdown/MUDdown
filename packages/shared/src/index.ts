// ─── Container Block Types ───────────────────────────────────────────────────

export type BlockType =
  | "room"
  | "npc"
  | "item"
  | "combat"
  | "dialogue"
  | "system"
  | "map"
  | "player";

// ─── Interactive Link Schemes ────────────────────────────────────────────────

export type LinkScheme = "cmd" | "go" | "item" | "npc" | "player" | "help" | "url";

export interface GameLink {
  scheme: LinkScheme;
  target: string;
  displayText: string;
}

// ─── Container Block Attributes ──────────────────────────────────────────────

export interface BlockAttributes {
  id?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface RoomAttributes extends BlockAttributes {
  id: string;
  region?: string;
  lighting?: string;
  visited?: boolean;
  terrain?: string;
}

export interface NpcAttributes extends BlockAttributes {
  id: string;
  name: string;
  disposition?: string;
  hp?: number;
  "max-hp"?: number;
}

export interface ItemAttributes extends BlockAttributes {
  id: string;
  name: string;
  weight?: number;
  rarity?: string;
}

export interface CombatAttributes extends BlockAttributes {
  round?: number;
  initiative?: string;
}

export interface DialogueAttributes extends BlockAttributes {
  npc: string;
  mood?: string;
}

// ─── Parsed Block ────────────────────────────────────────────────────────────

export interface MUDdownBlock {
  type: BlockType | string; // string allows x- extensions
  attributes: BlockAttributes;
  content: string; // raw Markdown inside the block
  sections: Record<string, string>; // H2 sections parsed out
  links: GameLink[];
}

// ─── Wire Protocol ───────────────────────────────────────────────────────────

export interface ServerMessage {
  v: 1;
  id: string;
  type: "room" | "combat" | "dialogue" | "system" | "narrative";
  timestamp: string;
  muddown: string;
  meta?: Record<string, unknown>;
}

export interface ClientMessage {
  v: 1;
  id: string;
  type: "command" | "input" | "ping";
  timestamp: string;
  command?: string;
  args?: string[];
}

export type WireMessage = ServerMessage | ClientMessage;

// ─── MCP Resources ──────────────────────────────────────────────────────────

export type MCPResource =
  | "muddown://room/current"
  | "muddown://player/inventory"
  | "muddown://player/stats"
  | "muddown://world/map"
  | `muddown://help/${string}`;

// ─── Conformance Levels ──────────────────────────────────────────────────────

export type ConformanceLevel = "text" | "interactive" | "full";

// ─── Item System ─────────────────────────────────────────────────────────────

export type EquipSlot = "weapon" | "armor" | "accessory";

export interface ItemBase {
  id: string;
  name: string;
  description: string;
  weight: number;
  rarity: "common" | "uncommon" | "rare" | "legendary";
  fixed: boolean;
}

export type EquippableItem = { equippable: true; slot: EquipSlot; attackBonus?: number; damage?: string; acBonus?: number };
export type NonEquippableItem = { equippable: false; slot?: never; attackBonus?: never; damage?: never; acBonus?: never };

export type UsableItem = { usable: true; useEffect: string };
export type NonUsableItem = { usable: false; useEffect?: never };

export type ItemDefinition = ItemBase &
  (EquippableItem | NonEquippableItem) &
  (UsableItem | NonUsableItem);

export interface CombineRecipe {
  item1: string;
  item2: string;
  result: string;
  description: string;
}

// ─── NPC & Dialogue System ───────────────────────────────────────────────────

export interface NpcCombatStats {
  hp: number;
  maxHp: number;
  ac: number;
  attackBonus: number;
  damage: string;       // dice expression, e.g. "1d6+1"
  xp: number;
}

export const PLAYER_DEFAULTS = {
  hp: 20,
  maxHp: 20,
  ac: 10,
  attackBonus: 2,
  damage: "1d4",        // unarmed
} as const satisfies Omit<NpcCombatStats, "xp">;

/** Alias for anonymous guest defaults */
export const GUEST_DEFAULTS = PLAYER_DEFAULTS;

export interface DialogueResponse {
  text: string;
  next: string | null; // null = end conversation
}

export interface DialogueNode {
  text: string;           // NPC speech (rendered as blockquote)
  mood?: string;          // mood attribute for :::dialogue block
  narrative?: string;     // descriptive text after the speech
  responses: DialogueResponse[];
}

export interface NpcDefinition {
  id: string;
  name: string;
  description: string;
  location: string;       // room ID where this NPC resides
  dialogue: Record<string, DialogueNode>; // node-id → node ("start" is entry point)
  combat?: NpcCombatStats;
}

// ─── Character Classes ───────────────────────────────────────────────────────

export type CharacterClass = "warrior" | "mage" | "rogue" | "cleric";

export const CHARACTER_CLASSES: readonly CharacterClass[] = ["warrior", "mage", "rogue", "cleric"] as const;

export function isCharacterClass(value: unknown): value is CharacterClass {
  return typeof value === "string" && (CHARACTER_CLASSES as readonly string[]).includes(value);
}

export const CLASS_STATS: Record<CharacterClass, {
  hp: number;
  maxHp: number;
  ac: number;
  attackBonus: number;
  damage: string;
}> = {
  warrior: { hp: 25, maxHp: 25, ac: 12, attackBonus: 3, damage: "1d6+1" },
  mage:    { hp: 15, maxHp: 15, ac: 8,  attackBonus: 1, damage: "1d4" },
  rogue:   { hp: 18, maxHp: 18, ac: 11, attackBonus: 2, damage: "1d6" },
  cleric:  { hp: 20, maxHp: 20, ac: 10, attackBonus: 2, damage: "1d4+1" },
};

// ─── Account & Identity ──────────────────────────────────────────────────────

export const OAUTH_PROVIDERS = ["github", "microsoft", "google"] as const;
export type OAuthProvider = typeof OAUTH_PROVIDERS[number];

const OAUTH_PROVIDERS_SET: ReadonlySet<string> = new Set<string>(OAUTH_PROVIDERS);

export function isOAuthProvider(v: unknown): v is OAuthProvider {
  return typeof v === "string" && OAUTH_PROVIDERS_SET.has(v);
}

export interface AccountRecord {
  id: string;             // UUID (primary key)
  displayName: string;    // from provider or user-chosen
  displayNameOverridden: boolean; // true when user has customised their name
  createdAt: string;      // ISO 8601
  updatedAt: string;      // ISO 8601
}

export interface IdentityLinkRecord {
  accountId: string;      // FK → accounts
  provider: OAuthProvider;
  providerId: string;     // external user ID (unique per provider)
  providerUsername: string; // e.g., GitHub login
  linkedAt: string;       // ISO 8601
}

// ─── Character Persistence ───────────────────────────────────────────────────

export interface CharacterRecord {
  id: string;             // UUID (primary key)
  accountId: string;      // FK → accounts
  name: string;           // character name (unique per server)
  characterClass: CharacterClass;
  currentRoom: string;
  inventory: string[];    // item IDs
  equipped: Record<EquipSlot, string | null>;
  hp: number;
  maxHp: number;
  xp: number;
  createdAt: string;      // ISO 8601
  updatedAt: string;      // ISO 8601
}

export interface DefeatedNpcRecord {
  npcId: string;
  roomId: string;
  defeatedAt: string;     // ISO 8601
  respawnAt: string;      // ISO 8601
}

// ─── Entity Lifecycle Hooks ──────────────────────────────────────────────────

export type HookEvent =
  | "onCreate"            // entity first added to the world
  | "onReset"             // entity respawned / restored
  | "onContact";          // entity comes in contact with another (e.g., player enters room)

interface HookContextBase {
  entityId: string;       // the entity that owns this hook
  entityType: "npc" | "item" | "room";
  roomId: string;
}

export interface OnContactHookContext extends HookContextBase {
  event: "onContact";
  contactId: string;
  contactType: "player" | "npc" | "item";
}

export interface OnCreateHookContext extends HookContextBase {
  event: "onCreate";
}

export interface OnResetHookContext extends HookContextBase {
  event: "onReset";
}

export type HookContext = OnContactHookContext | OnCreateHookContext | OnResetHookContext;

// ─── Games Directory ─────────────────────────────────────────────────────────

export type CertificationTier = "verified" | "self-certified" | "listed";

/** The subset of CertificationTier that users may set directly. "verified" is system-only. */
export type UserSettableCertification = Exclude<CertificationTier, "verified">;

export type ServerProtocol = "websocket" | "telnet" | "mcp" | "other";

export interface GameServerRecord {
  id: string;                   // UUID (primary key)
  ownerId: string;              // FK → accounts
  name: string;                 // display name of the game/server
  description: string;          // short description
  hostname: string;             // connection hostname
  port: number | null;          // connection port (null for default)
  protocol: ServerProtocol;     // primary protocol
  websiteUrl: string | null;    // optional website link
  certification: CertificationTier;
  lastCheckAt: string | null;   // ISO 8601 — last automated check
  lastCheckResult: string | null; // JSON — compliance check details
  createdAt: string;            // ISO 8601
  updatedAt: string;            // ISO 8601
}
