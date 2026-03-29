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

export type EquippableItem = { equippable: true; slot: EquipSlot };
export type NonEquippableItem = { equippable: false; slot?: never };

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
}
