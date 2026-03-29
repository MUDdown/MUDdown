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
