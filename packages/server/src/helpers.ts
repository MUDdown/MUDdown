import type { ItemDefinition, NpcDefinition } from "@muddown/shared";
import type { HintContext } from "./llm.js";

// ─── Direction Aliases ───────────────────────────────────────────────────────

export const dirAliases: Record<string, string> = {
  n: "north", s: "south", e: "east", w: "west", u: "up", d: "down",
  ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
};

// ─── Item Lookup ─────────────────────────────────────────────────────────────

export function findItemByName(
  query: string,
  itemIds: string[],
  itemDefs: Map<string, ItemDefinition>,
): ItemDefinition | undefined {
  const q = query.toLowerCase();
  for (const id of itemIds) {
    const def = itemDefs.get(id);
    if (!def) continue;
    if (def.id.toLowerCase() === q || def.name.toLowerCase() === q) return def;
  }
  // Partial match fallback
  for (const id of itemIds) {
    const def = itemDefs.get(id);
    if (!def) continue;
    if (def.id.toLowerCase().includes(q) || def.name.toLowerCase().includes(q)) return def;
  }
  return undefined;
}

// ─── NPC Lookup ──────────────────────────────────────────────────────────────

export function findNpcInRoom(
  query: string,
  roomId: string,
  roomNpcs: Map<string, string[]>,
  npcDefs: Map<string, NpcDefinition>,
): NpcDefinition | undefined {
  const npcIds = roomNpcs.get(roomId) ?? [];
  const q = query.toLowerCase();
  // Exact match
  for (const id of npcIds) {
    const npc = npcDefs.get(id);
    if (!npc) continue;
    if (npc.id.toLowerCase() === q || npc.name.toLowerCase() === q) return npc;
  }
  // Partial match fallback
  for (const id of npcIds) {
    const npc = npcDefs.get(id);
    if (!npc) continue;
    if (npc.id.toLowerCase().includes(q) || npc.name.toLowerCase().includes(q)) return npc;
  }
  return undefined;
}

// ─── Combine Deduplication ───────────────────────────────────────────────────

export function findUnclaimedIndex(arr: string[], target: string, claimed: Set<number>): number {
  let searchFrom = 0;
  while (searchFrom < arr.length) {
    const idx = arr.indexOf(target, searchFrom);
    if (idx === -1) break;
    if (!claimed.has(idx)) return idx;
    searchFrom = idx + 1;
  }
  return -1;
}

// ─── HTML Comment Stripping ──────────────────────────────────────────────────

export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->\r?\n?/g, "");
}

// ─── Dialogue Text Escaping ──────────────────────────────────────────────────

export function escapeDialogueText(text: string): string {
  return text.replace(/"/g, "'");
}

// ─── Markdown Link Escaping ──────────────────────────────────────────────────

export function escapeMarkdownLinkLabel(text: string): string {
  return text.replace(/\\/g, "\\\\")
    .replace(/\]/g, "\\]")
    .replace(/\[/g, "\\[")
    .replace(/[\r\n]+/g, " ");
}

export function escapeMarkdownLinkDest(dest: string): string {
  return dest.replace(/\\/g, "\\\\")
    .replace(/\)/g, "\\)")
    .replace(/[\r\n]+/g, "");
}

// ─── Dice Rolling ────────────────────────────────────────────────────────────

export function rollD20(): number {
  return Math.floor(Math.random() * 20) + 1;
}

/**
 * Parse a dice expression like "1d6", "2d8+3", "1d4-1" and roll it.
 * Returns { rolls, modifier, total }.
 */
export function rollDice(expr: string): { rolls: number[]; modifier: number; total: number } {
  const match = expr.match(/^([1-9]\d*)d([1-9]\d*)([+-]\d+)?$/);
  if (!match) {
    console.error(`rollDice: invalid dice expression "${expr}" — defaulting to 0`);
    return { rolls: [0], modifier: 0, total: 0 };
  }
  const count = parseInt(match[1], 10);
  const sides = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    rolls.push(Math.floor(Math.random() * sides) + 1);
  }
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { rolls, modifier, total: Math.max(0, total) };
}

// ─── Combat Helpers ──────────────────────────────────────────────────────────

export interface AttackResult {
  roll: number;
  attackBonus: number;
  total: number;
  targetAc: number;
  hit: boolean;
  damage: number;
  damageRolls: number[];
  damageModifier: number;
}

export function resolveAttack(attackBonus: number, damageExpr: string, targetAc: number): AttackResult {
  const roll = rollD20();
  const total = roll + attackBonus;
  const hit = roll === 20 || (roll !== 1 && total >= targetAc);
  let damage = 0;
  let damageRolls: number[] = [];
  let damageModifier = 0;
  if (hit) {
    const d = rollDice(damageExpr);
    damage = Math.max(1, d.total); // minimum 1 damage on hit
    damageRolls = d.rolls;
    damageModifier = d.modifier;
  }
  return { roll, attackBonus, total, targetAc, hit, damage, damageRolls, damageModifier };
}

export function formatAttackLine(
  attackerName: string,
  targetName: string,
  weaponName: string | undefined,
  result: AttackResult,
  targetHp: number,
  targetMaxHp: number,
): string {
  const weapon = weaponName ? ` with a ${weaponName}` : "";
  const lines: string[] = [];
  lines.push(`**${attackerName}** attacks **${targetName}**${weapon}...`);
  if (result.hit) {
    lines.push(`*Roll: ${result.roll} + ${result.attackBonus} = ${result.total} vs AC ${result.targetAc}* — **Hit!**`);
    lines.push(`Damage: ${result.damage} → ${targetName} HP: ${targetHp}/${targetMaxHp}`);
  } else {
    lines.push(`*Roll: ${result.roll} + ${result.attackBonus} = ${result.total} vs AC ${result.targetAc}* — **Miss!**`);
  }
  return lines.join("\n");
}

export function getPlayerAttackBonus(
  baseBonus: number,
  equippedWeaponId: string | null,
  itemDefs: Map<string, ItemDefinition>,
): number {
  if (!equippedWeaponId) return baseBonus;
  const weapon = itemDefs.get(equippedWeaponId);
  if (!weapon?.equippable) return baseBonus;
  return baseBonus + (weapon.attackBonus ?? 0);
}

export function getPlayerDamage(
  baseDamage: string,
  equippedWeaponId: string | null,
  itemDefs: Map<string, ItemDefinition>,
): string {
  if (!equippedWeaponId) return baseDamage;
  const weapon = itemDefs.get(equippedWeaponId);
  if (!weapon?.equippable || !weapon.damage) return baseDamage;
  return weapon.damage;
}

export function getPlayerAc(
  baseAc: number,
  equippedArmorId: string | null,
  equippedAccessoryId: string | null,
  itemDefs: Map<string, ItemDefinition>,
): number {
  let ac = baseAc;
  for (const id of [equippedArmorId, equippedAccessoryId]) {
    if (!id) continue;
    const item = itemDefs.get(id);
    if (item?.equippable && item.acBonus != null) {
      ac += item.acBonus;
    }
  }
  return ac;
}

// ─── Defeat Reset ────────────────────────────────────────────────────────────

export interface DefeatResetTarget {
  combat: unknown;
  hp: number;
  maxHp: number;
  currentRoom: string;
}

export function resetPlayerAfterDefeat(target: DefeatResetTarget, respawnRoom: string): void {
  target.combat = null;
  target.hp = target.maxHp;
  target.currentRoom = respawnRoom;
}

// ─── Inventory State Builder ─────────────────────────────────────────────────

export interface InventoryItemState {
  id: string;
  name: string;
  equippable: boolean;
  usable: boolean;
}

export interface InventoryState {
  items: InventoryItemState[];
  equipped: Record<string, { id: string; name: string } | null>;
}

export function buildInventoryState(
  inventory: string[],
  equipped: Record<string, string | null>,
  itemDefs: Map<string, ItemDefinition>,
): InventoryState {
  const items = inventory.map(id => {
    const def = itemDefs.get(id);
    return {
      id,
      name: def?.name ?? id,
      equippable: def?.equippable ?? false,
      usable: def?.usable ?? false,
    };
  });

  const equippedState: Record<string, { id: string; name: string } | null> = {};
  for (const [slot, id] of Object.entries(equipped)) {
    if (id) {
      const def = itemDefs.get(id);
      equippedState[slot] = { id, name: def?.name ?? id };
    } else {
      equippedState[slot] = null;
    }
  }

  return { items, equipped: equippedState };
}

// ─── Token Bucket Rate Limiter ───────────────────────────────────────────────

/**
 * A token-bucket rate limiter. Each bucket starts full and refills at a
 * constant rate. Callers consume one token per request; when the bucket is
 * empty the request is rejected (returns false).
 *
 * Designed to be stored per-session so each player has independent limits.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillRate: number, // tokens per second
  ) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`TokenBucket: capacity must be a positive finite number, got ${capacity}`);
    }
    if (!Number.isFinite(refillRate) || refillRate <= 0) {
      throw new Error(`TokenBucket: refillRate must be a positive finite number, got ${refillRate}`);
    }
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** Try to consume one token. Returns true if allowed, false if throttled. */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = Math.max(0, (now - this.lastRefill) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    // Always update lastRefill so the bucket refills in continuous wall-clock time,
    // regardless of whether the previous consume() succeeded or was throttled.
    this.lastRefill = now;
  }
}

// ─── Help Entries ────────────────────────────────────────────────────────────

export interface HelpEntry {
  command: string;
  aliases: string[];
  usage: string;
  description: string;
  detail: string;
  examples: string[];
}

export const helpEntries: Record<string, HelpEntry> = {
  look: {
    command: "look",
    aliases: ["l"],
    usage: "look",
    description: "Look around the current room",
    detail: "Displays the full room description including exits, NPCs present, and items on the ground.",
    examples: ["look", "l"],
  },
  go: {
    command: "go",
    aliases: ["north", "south", "east", "west", "up", "down", "n", "s", "e", "w", "u", "d", "ne", "nw", "se", "sw", "northeast", "northwest", "southeast", "southwest"],
    usage: "go <direction>",
    description: "Move in a direction (n, s, e, w, u, d, ne, nw, se, sw)",
    detail: "Moves your character to an adjacent room. You can type the full direction name, an abbreviation, or use `go <direction>`. You cannot move while in combat — use `flee` first.",
    examples: ["go north", "north", "n", "go up", "sw"],
  },
  examine: {
    command: "examine",
    aliases: [],
    usage: "examine <thing>",
    description: "Examine something in the room",
    detail: "Shows a detailed description of an item on the ground or in your inventory. Also works for items you are carrying.",
    examples: ["examine rusty key", "examine bread"],
  },
  talk: {
    command: "talk",
    aliases: [],
    usage: "talk <npc> [message]",
    description: "Talk to an NPC",
    detail: "Starts or continues a conversation with an NPC in the room. You can speak freely — NPCs understand natural language and will respond in character. Say goodbye to end a conversation.",
    examples: ["talk crier", "talk priestess I need healing", "talk gorath Tell me about your forge"],
  },
  get: {
    command: "get",
    aliases: ["take"],
    usage: "get <item>",
    description: "Pick up an item",
    detail: "Picks up an item from the ground in the current room and adds it to your inventory. Some items are fixed in place and cannot be picked up.",
    examples: ["get rusty key", "take bread"],
  },
  drop: {
    command: "drop",
    aliases: [],
    usage: "drop <item>",
    description: "Drop an item from your inventory",
    detail: "Removes an item from your inventory and places it on the ground in the current room. Equipped items must be unequipped first.",
    examples: ["drop bread", "drop rusty key"],
  },
  inventory: {
    command: "inventory",
    aliases: ["inv", "i"],
    usage: "inventory",
    description: "Show your inventory and equipment",
    detail: "Lists all items you are carrying and what you have equipped in each slot (weapon, armor, accessory).",
    examples: ["inventory", "inv", "i"],
  },
  equip: {
    command: "equip",
    aliases: [],
    usage: "equip <item>",
    description: "Equip a weapon, armor, or accessory",
    detail: "Equips an item from your inventory into its appropriate slot. The item must be equippable. If a slot is already occupied, unequip the current item first.",
    examples: ["equip rusty sword", "equip cloak"],
  },
  unequip: {
    command: "unequip",
    aliases: [],
    usage: "unequip <slot>",
    description: "Unequip an item (weapon, armor, accessory)",
    detail: "Removes the item from the specified equipment slot and returns it to your inventory.",
    examples: ["unequip weapon", "unequip armor", "unequip accessory"],
  },
  use: {
    command: "use",
    aliases: [],
    usage: "use <item>",
    description: "Use an item",
    detail: "Activates a usable item from your inventory. Effects depend on the item — food heals you, a lantern lights a dark room, a rod lets you fish, and so on.",
    examples: ["use bread", "use fishing rod", "use candle"],
  },
  combine: {
    command: "combine",
    aliases: [],
    usage: "combine <item> with <item>",
    description: "Combine two items together",
    detail: "Attempts to combine two items from your inventory using a known recipe. Both items are consumed and a new item is produced if the recipe is valid.",
    examples: ["combine broken lantern with candle"],
  },
  attack: {
    command: "attack",
    aliases: [],
    usage: "attack <npc>",
    description: "Attack a hostile NPC",
    detail: "Initiates combat with an NPC in the room. Combat is turn-based — each `attack` command resolves one round. Your equipped weapon affects your damage and attack bonus.",
    examples: ["attack gorath", "attack bandit"],
  },
  flee: {
    command: "flee",
    aliases: [],
    usage: "flee",
    description: "Flee from combat",
    detail: "Attempts to escape from combat. You will move to a random adjacent room. If there are no exits, you cannot flee.",
    examples: ["flee"],
  },
  say: {
    command: "say",
    aliases: [],
    usage: "say <message>",
    description: "Say something to others in the room",
    detail: "Broadcasts a message to all other players in the same room. Only players in your current room will see it.",
    examples: ["say Hello everyone!", "say Anyone know where the key is?"],
  },
  who: {
    command: "who",
    aliases: [],
    usage: "who",
    description: "See who is online",
    detail: "Shows a list of all players currently connected to the game and which room they are in.",
    examples: ["who"],
  },
  help: {
    command: "help",
    aliases: [],
    usage: "help [command]",
    description: "Show help or detailed command info",
    detail: "Without an argument, shows the full command list. With a command name, shows detailed usage, examples, and tips for that specific command.",
    examples: ["help", "help go", "help talk", "help combine"],
  },
  hint: {
    command: "hint",
    aliases: [],
    usage: "hint",
    description: "Get a context-aware hint",
    detail: "Provides a helpful suggestion based on your current situation — where you are, what you're carrying, and what's around you. Uses AI when available, otherwise shows general tips.",
    examples: ["hint"],
  },
};

/** Look up a help entry by command name or alias. */
export function getHelpEntry(query: string): HelpEntry | undefined {
  const q = query.toLowerCase();
  if (Object.hasOwn(helpEntries, q)) return helpEntries[q];
  for (const entry of Object.values(helpEntries)) {
    if (entry.aliases.includes(q)) return entry;
  }
  return undefined;
}

/** Check whether a command string starts with a recognized game verb. */
export function isValidCommand(command: string): boolean {
  const verb = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!verb) return false;
  return getHelpEntry(verb) !== undefined;
}

/** Build the MUDdown content string for a single command's detail block. */
export function buildHelpBlock(entry: HelpEntry): string {
  const aliasLine = entry.aliases.length > 0
    ? `\n**Aliases:** ${entry.aliases.map(a => `\`${a}\``).join(", ")}`
    : "";
  const examplesBlock = entry.examples.map(e => `- \`${e}\``).join("\n");
  return `:::system{type="help"}
# Help: ${entry.command}

**Usage:** \`${entry.usage}\`${aliasLine}

${entry.detail}

## Examples

${examplesBlock}
:::`;
}

/** Build the MUDdown content string for the full command table. */
export function buildHelpTable(entries: Record<string, HelpEntry>): string {
  const rows = Object.values(entries).map(e =>
    `| [${e.command}](help:${e.command}) | ${e.description} |`
  ).join("\n");
  return `:::system{type="help"}
# Commands

| Command | Description |
|---------|-------------|
${rows}

You can also click on **links** in room descriptions to interact.
Type \`help <command>\` for detailed usage and examples.
:::`;
}

/** Neutralize content that could break out of a MUDdown container block. */
function sanitizeBlockContent(value: string): string {
  return value
    .split("\n")
    .map(line => /^:{3,}/.test(line) ? line.replace(/^:{3,}/, m => "\u200b" + m) : line)
    .join("\n");
}

/** Build the MUDdown content string for a hint block. */
export function buildHintBlock(hint: string, suggestedCommands: string[]): string {
  const safeHint = sanitizeBlockContent(hint);
  const cmdSection = suggestedCommands.length > 0
    ? `\n\n**Try:**\n${suggestedCommands.map(c => `- \`${sanitizeBlockContent(c)}\``).join("\n")}`
    : "";
  return `:::system{type="hint"}\n${safeHint}${cmdSection}\n:::`;
}

// ─── Hint Context Builder ────────────────────────────────────────────────────

export interface BuildHintContextInput {
  playerName: string;
  playerClass: string | null;
  inventory: string[];
  inCombat: boolean;
  hp: number;
  maxHp: number;
  roomMuddown: string | undefined;
  roomName: string;
  exits: string[];
  npcIds: string[];
  roomItemIds: string[];
  itemDefs: Map<string, ItemDefinition>;
  npcDefs: Map<string, NpcDefinition>;
}

/** Pure helper to build a HintContext from world/session data. */
export function buildHintContext(input: BuildHintContextInput): HintContext {
  const npcNames = input.npcIds
    .map(id => input.npcDefs.get(id)?.name)
    .filter((n): n is string => n != null);
  const roomItemNames = input.roomItemIds
    .map(id => input.itemDefs.get(id)?.name)
    .filter((n): n is string => n != null);
  const invNames = input.inventory
    .map(id => input.itemDefs.get(id)?.name ?? id);

  return {
    playerName: input.playerName,
    playerClass: input.playerClass,
    roomName: input.roomName,
    roomDescription: input.roomMuddown?.substring(0, 300) ?? "",
    exits: input.exits,
    npcs: npcNames,
    roomItems: roomItemNames,
    inventoryItems: invNames,
    inCombat: input.inCombat,
    hp: input.hp,
    maxHp: input.maxHp,
  };
}
