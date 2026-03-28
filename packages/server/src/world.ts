import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoomAttributes } from "@muddown/shared";

export interface Room {
  attributes: RoomAttributes;
  muddown: string;
}

export interface WorldMap {
  rooms: Map<string, Room>;
  connections: Map<string, Record<string, string>>; // room-id → { direction → room-id }
}

// ─── YAML Frontmatter Parser (minimal, no dependencies) ─────────────────────

interface RoomFrontmatter {
  id: string;
  region?: string;
  lighting?: string;
  connections?: Record<string, string>;
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

  for (const line of yamlBlock.split("\n")) {
    // Nested key: value (indented under a parent)
    const nestedMatch = line.match(/^  (\w[\w-]*):\s*(.+)$/);
    if (nestedMatch && currentKey) {
      if (!nestedObj) nestedObj = {};
      nestedObj[nestedMatch[1]] = nestedMatch[2].trim();
      continue;
    }

    // Flush any pending nested object
    if (currentKey && nestedObj) {
      meta[currentKey] = nestedObj;
      nestedObj = null;
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
      // else: value is on next lines (nested object)
    }
  }

  // Flush final nested object
  if (currentKey && nestedObj) {
    meta[currentKey] = nestedObj;
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

  function loadDir(dirPath: string): void {
    for (const entry of readdirSync(dirPath)) {
      const fullPath = join(dirPath, entry);
      if (statSync(fullPath).isDirectory()) {
        loadDir(fullPath);
        continue;
      }
      if (!entry.endsWith(".md")) continue;

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
    }
  }

  loadDir(dir);
  console.log(`Loaded ${rooms.size} rooms from ${dir}`);
  return { rooms, connections };
}
