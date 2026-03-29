import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoomAttributes, ItemDefinition, CombineRecipe, EquipSlot, NpcDefinition, DialogueNode, DialogueResponse } from "@muddown/shared";

export interface Room {
  attributes: RoomAttributes;
  muddown: string;
}

export interface WorldMap {
  rooms: Map<string, Room>;
  connections: Map<string, Record<string, string>>; // room-id → { direction → room-id }
  itemDefs: Map<string, ItemDefinition>;
  roomItems: Map<string, string[]>; // room-id → [item-id, ...]
  recipes: CombineRecipe[];
  npcDefs: Map<string, NpcDefinition>;
  roomNpcs: Map<string, string[]>; // room-id → [npc-id, ...]
}

// ─── YAML Frontmatter Parser (minimal, no dependencies) ─────────────────────

interface RoomFrontmatter {
  id?: string;
  region?: string;
  lighting?: string;
  connections?: Record<string, string>;
  items?: string[];
}

function parseFrontmatter(raw: string): { meta: RoomFrontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error("Room file missing YAML frontmatter");
  }

  const yamlBlock = match[1];
  const body = match[2].trim();
  const meta: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let nestedObj: Record<string, string> | null = null;
  let arrayItems: string[] | null = null;

  for (const line of yamlBlock.split("\n")) {
    // Array item: "  - value"
    const arrayMatch = line.match(/^  - (.+)$/);
    if (arrayMatch && currentKey) {
      if (!arrayItems) arrayItems = [];
      arrayItems.push(arrayMatch[1].trim());
      continue;
    }

    // Nested key: value (indented under a parent)
    const nestedMatch = line.match(/^  (\w[\w-]*):\s*(.+)$/);
    if (nestedMatch && currentKey) {
      if (!nestedObj) nestedObj = {};
      nestedObj[nestedMatch[1]] = nestedMatch[2].trim();
      continue;
    }

    // Flush any pending nested object or array
    if (currentKey && nestedObj) {
      meta[currentKey] = nestedObj;
      nestedObj = null;
    }
    if (currentKey && arrayItems) {
      meta[currentKey] = arrayItems;
      arrayItems = null;
    }

    // Top-level key: value
    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (topMatch) {
      currentKey = topMatch[1];
      const value = topMatch[2].trim();
      if (value) {
        meta[currentKey] = value;
        currentKey = null;
      }
      // else: value is on next lines (nested object or array)
    }
  }

  // Flush final nested object or array
  if (currentKey && nestedObj) {
    meta[currentKey] = nestedObj;
  }
  if (currentKey && arrayItems) {
    meta[currentKey] = arrayItems;
  }

  return {
    meta: meta as unknown as RoomFrontmatter,
    body,
  };
}

// ─── World Loader ────────────────────────────────────────────────────────────

function getWorldDir(): string {
  // Works in both dev (src/) and built (dist/) contexts
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // From src/ or dist/, go up to packages/server/world/
  return join(thisDir, "..", "world");
}

export function loadWorld(worldDir?: string): WorldMap {
  const dir = worldDir ?? getWorldDir();
  const rooms = new Map<string, Room>();
  const connections = new Map<string, Record<string, string>>();
  const roomItems = new Map<string, string[]>();

  // Load item definitions from world/items/*.json
  const itemDefs = new Map<string, ItemDefinition>();
  let recipes: CombineRecipe[] = [];
  const itemsDir = join(dir, "items");
  try {
    for (const file of readdirSync(itemsDir)) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(itemsDir, file);
      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      if (!raw.id || typeof raw.id !== "string") {
        console.warn(`Skipping ${file}: missing or invalid id`);
        continue;
      }
      if (typeof raw.name !== "string" || typeof raw.description !== "string") {
        console.warn(`Skipping item "${raw.id}": missing name or description`);
        continue;
      }
      if (typeof raw.weight !== "number" || typeof raw.fixed !== "boolean") {
        console.warn(`Skipping item "${raw.id}": missing or invalid weight/fixed`);
        continue;
      }
      const validRarities = ["common", "uncommon", "rare", "legendary"] as const;
      if (typeof raw.rarity !== "string" || !validRarities.includes(raw.rarity as typeof validRarities[number])) {
        console.warn(`Skipping item "${raw.id}": invalid rarity "${raw.rarity}"`);
        continue;
      }

      const base = {
        id: raw.id,
        name: raw.name,
        description: raw.description,
        weight: raw.weight,
        rarity: raw.rarity as ItemDefinition["rarity"],
        fixed: raw.fixed,
      };

      const validSlots: EquipSlot[] = ["weapon", "armor", "accessory"];
      const equip = raw.equippable === true
        ? validSlots.includes(raw.slot as EquipSlot)
          ? { equippable: true as const, slot: raw.slot as EquipSlot }
          : (() => { console.warn(`Item "${raw.id}" is equippable but has invalid slot "${raw.slot}"`); return null; })()
        : { equippable: false as const };
      if (!equip) continue;

      const use = raw.usable === true
        ? typeof raw.useEffect === "string"
          ? { usable: true as const, useEffect: raw.useEffect }
          : (() => { console.warn(`Item "${raw.id}" is usable but has no useEffect`); return null; })()
        : { usable: false as const };
      if (!use) continue;

      if (itemDefs.has(raw.id)) {
        console.warn(`Duplicate item ID "${raw.id}" — overwriting previous definition`);
      }
      itemDefs.set(raw.id, { ...base, ...equip, ...use } as ItemDefinition);
    }
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`No items directory found at ${itemsDir}, skipping item loading`);
    } else {
      console.error(`Error loading items from ${itemsDir}:`, err);
      throw err;
    }
  }

  // Load recipes from world/recipes.json
  const recipesPath = join(dir, "recipes.json");
  try {
    const recipesRaw = JSON.parse(readFileSync(recipesPath, "utf-8")) as unknown;
    if (Array.isArray(recipesRaw)) {
      for (const raw of recipesRaw as Record<string, unknown>[]) {
        if (
          typeof raw.item1 === "string" &&
          typeof raw.item2 === "string" &&
          typeof raw.result === "string" &&
          typeof raw.description === "string"
        ) {
          recipes.push({ item1: raw.item1, item2: raw.item2, result: raw.result, description: raw.description });
        } else {
          console.warn("Skipping invalid recipe (missing item1, item2, result, or description):", raw);
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`No recipes.json found at ${recipesPath}, skipping recipe loading`);
    } else {
      console.error(`Error loading recipes from ${recipesPath}:`, err);
      throw err;
    }
  }
  console.log(`Loaded ${itemDefs.size} item definitions, ${recipes.length} recipes`);

  // Load NPC definitions from world/npcs/*.json
  const npcDefs = new Map<string, NpcDefinition>();
  const roomNpcs = new Map<string, string[]>();
  const npcsDir = join(dir, "npcs");
  try {
    for (const file of readdirSync(npcsDir)) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(npcsDir, file);
      try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.description !== "string" || typeof raw.location !== "string") {
        console.warn(`Skipping NPC in ${file}: missing fields`);
        continue;
      }
      if (typeof raw.dialogue !== "object" || raw.dialogue === null || !("start" in (raw.dialogue as Record<string, unknown>))) {
        console.warn(`Skipping NPC "${raw.id}": missing or invalid dialogue (must have "start" node)`);
        continue;
      }
      const dialogue: Record<string, DialogueNode> = {};
      for (const [nodeId, nodeRaw] of Object.entries(raw.dialogue as Record<string, unknown>)) {
        const node = nodeRaw as Record<string, unknown>;
        if (typeof node.text !== "string" || !Array.isArray(node.responses)) {
          console.warn(`Skipping dialogue node "${nodeId}" for NPC "${raw.id}": missing text or responses`);
          continue;
        }
        const responses: DialogueResponse[] = [];
        for (const resp of node.responses as unknown[]) {
          if (!resp || typeof resp !== "object") {
            console.warn(`Skipping malformed dialogue response in node "${nodeId}" for NPC "${raw.id}":`, JSON.stringify(resp));
            continue;
          }
          const respObj = resp as Record<string, unknown>;
          if (typeof respObj.text === "string" && (respObj.next === null || typeof respObj.next === "string")) {
            responses.push({ text: respObj.text, next: respObj.next as string | null });
          } else {
            console.warn(`Skipping malformed dialogue response in node "${nodeId}" for NPC "${raw.id}":`, JSON.stringify(resp));
          }
        }
        dialogue[nodeId] = {
          text: node.text,
          mood: typeof node.mood === "string" ? node.mood : undefined,
          narrative: typeof node.narrative === "string" ? node.narrative : undefined,
          responses,
        };
      }
      if (!dialogue["start"]) {
        console.warn(`Skipping NPC "${raw.id}": "start" dialogue node failed validation`);
        continue;
      }
      const npc: NpcDefinition = { id: raw.id, name: raw.name, description: raw.description, location: raw.location, dialogue };
      npcDefs.set(npc.id, npc);
      const list = roomNpcs.get(npc.location) ?? [];
      list.push(npc.id);
      roomNpcs.set(npc.location, list);
      } catch (fileErr) {
        console.error(`Error loading NPC file ${filePath}:`, fileErr instanceof Error ? fileErr.message : fileErr);
        continue;
      }
    }
    console.log(`Loaded ${npcDefs.size} NPC definitions`);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      console.warn(`No npcs directory found at ${npcsDir}, skipping NPC loading`);
    } else {
      console.error(`Error loading NPCs from ${npcsDir}:`, err);
      throw err;
    }
  }

  // Skip non-room directories (items/ and npcs/ are loaded separately above)
  const skipDirs = new Set(["items", "npcs"]);
  function loadDir(dirPath: string): void {
    for (const entry of readdirSync(dirPath)) {
      const fullPath = join(dirPath, entry);
      if (statSync(fullPath).isDirectory()) {
        if (dirPath === dir && skipDirs.has(entry)) continue;
        loadDir(fullPath);
        continue;
      }
      if (!entry.endsWith(".md")) continue;

      try {
        const raw = readFileSync(fullPath, "utf-8");
        const { meta, body } = parseFrontmatter(raw);

        if (!meta.id) {
          console.warn(`Skipping ${fullPath}: missing 'id' in frontmatter`);
          continue;
        }

        const attributes: RoomAttributes = {
          id: meta.id,
          region: meta.region,
          lighting: meta.lighting,
        };

        rooms.set(meta.id, { attributes, muddown: body });

        if (meta.connections) {
          connections.set(meta.id, meta.connections);
        }

        if (meta.items && meta.items.length > 0) {
          roomItems.set(meta.id, [...meta.items]);
        }
      } catch (err) {
        console.error(`Error loading room file ${fullPath}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  loadDir(dir);
  console.log(`Loaded ${rooms.size} rooms from ${dir}`);

  // Validate NPC locations reference existing rooms
  for (const [npcId, npc] of npcDefs) {
    if (!rooms.has(npc.location)) {
      console.warn(`NPC "${npcId}" references unknown room "${npc.location}"`);
    }
  }

  return { rooms, connections, itemDefs, roomItems, recipes, npcDefs, roomNpcs };
}
