import type { ItemDefinition, NpcDefinition } from "@muddown/shared";

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
