import type { ItemDefinition, NpcDefinition, CombineRecipe } from "@muddown/shared";
import type { WorldMap } from "./world.js";
import { extractNarrativeDescription, helpEntries } from "./helpers.js";

// ─── Document Types ──────────────────────────────────────────────────────────

export type LoreCategory = "room" | "npc" | "item" | "recipe" | "help";

export interface LoreDocument {
  id: string;
  content: string;
  category: LoreCategory;
  title: string;
}

export interface SearchResult {
  document: LoreDocument;
  score: number;
}

// ─── Tokenization ────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "not", "no",
  "this", "that", "these", "those", "it", "its", "my", "your", "his",
  "her", "our", "their", "what", "which", "who", "whom", "how",
  "when", "where", "why", "if", "then", "than", "so", "just",
  "also", "very", "too", "each", "every", "all", "any", "some",
]);

/** Tokenize text into lowercase terms, filtering stop words and short tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

// ─── TF-IDF Vector Store ─────────────────────────────────────────────────────

interface IndexedDocument {
  doc: LoreDocument;
  termFreqs: Map<string, number>;
  magnitude: number;
}

export class LoreVectorStore {
  private documents: IndexedDocument[] = [];
  private idf: Map<string, number> = new Map();

  /** Index an array of documents. Call once at startup. */
  index(docs: LoreDocument[]): void {
    this.documents = [];
    this.idf.clear();

    // Step 1: Compute raw term frequencies per document
    const rawTfs: Map<string, number>[] = [];
    const docFreq = new Map<string, number>();

    for (const doc of docs) {
      const tokens = tokenize(doc.content);
      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
      rawTfs.push(tf);

      for (const term of tf.keys()) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }

    // Step 2: Compute IDF (smoothed)
    const N = docs.length;
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
    }

    // Step 3: Build indexed documents with TF-IDF weights
    for (let i = 0; i < docs.length; i++) {
      const tf = rawTfs[i];
      let maxFreq = 1;
      for (const v of tf.values()) { if (v > maxFreq) maxFreq = v; }
      const tfidf = new Map<string, number>();
      let mag = 0;

      for (const [term, count] of tf) {
        const weight = (count / maxFreq) * (this.idf.get(term) ?? 0);
        tfidf.set(term, weight);
        mag += weight * weight;
      }

      this.documents.push({
        doc: docs[i],
        termFreqs: tfidf,
        magnitude: Math.sqrt(mag),
      });
    }
  }

  /** Search for the top-k most relevant documents by cosine similarity. */
  search(query: string, k = 5): SearchResult[] {
    if (this.documents.length === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    // Build query TF-IDF vector
    const queryTf = new Map<string, number>();
    for (const token of queryTokens) {
      queryTf.set(token, (queryTf.get(token) ?? 0) + 1);
    }
    let maxQf = 1;
    for (const v of queryTf.values()) { if (v > maxQf) maxQf = v; }
    let queryMag = 0;
    const queryVec = new Map<string, number>();
    for (const [term, count] of queryTf) {
      const idfWeight = this.idf.get(term) ?? 0;
      const weight = (count / maxQf) * idfWeight;
      queryVec.set(term, weight);
      queryMag += weight * weight;
    }
    queryMag = Math.sqrt(queryMag);

    if (queryMag === 0) return [];

    // Cosine similarity with each document
    const results: SearchResult[] = [];
    for (const indexed of this.documents) {
      if (indexed.magnitude === 0) continue;

      let dot = 0;
      for (const [term, weight] of queryVec) {
        const docWeight = indexed.termFreqs.get(term);
        if (docWeight !== undefined) {
          dot += weight * docWeight;
        }
      }

      const score = dot / (queryMag * indexed.magnitude);
      if (score > 0) {
        results.push({ document: indexed.doc, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  /** Return the number of indexed documents. */
  get size(): number {
    return this.documents.length;
  }
}

// ─── Corpus Builder ──────────────────────────────────────────────────────────

/** Extract the room title from its MUDdown. */
function getRoomTitle(muddown: string): string | null {
  return muddown.match(/^# (.+)$/m)?.[1] ?? null;
}

/** Build the full lore corpus from world data. */
export function buildLoreCorpus(world: WorldMap): LoreDocument[] {
  const docs: LoreDocument[] = [];

  // ── Rooms ──
  for (const [roomId, room] of world.rooms) {
    const title = getRoomTitle(room.muddown) ?? roomId;
    const description = extractNarrativeDescription(room.muddown)?.text ?? "";
    const exits = Object.keys(world.connections.get(roomId) ?? {});
    const npcs = (world.roomNpcs.get(roomId) ?? [])
      .map(id => world.npcDefs.get(id)?.name ?? id);
    const items = (world.roomItems.get(roomId) ?? [])
      .map(id => world.itemDefs.get(id)?.name ?? id);

    const parts = [title, description];
    if (room.attributes.region) parts.push(`Region: ${room.attributes.region}`);
    if (room.attributes.lighting) parts.push(`Lighting: ${room.attributes.lighting}`);
    if (exits.length > 0) parts.push(`Exits: ${exits.join(", ")}`);
    if (npcs.length > 0) parts.push(`NPCs: ${npcs.join(", ")}`);
    if (items.length > 0) parts.push(`Items: ${items.join(", ")}`);

    docs.push({ id: `room:${roomId}`, content: parts.join(". "), category: "room", title });
  }

  // ── NPCs ──
  for (const [npcId, npc] of world.npcDefs) {
    const parts = [`${npc.name}. ${npc.description}`];
    if (npc.backstory) parts.push(npc.backstory);
    if (npc.location) {
      const room = world.rooms.get(npc.location);
      const roomTitle = room ? getRoomTitle(room.muddown) : null;
      parts.push(`Located in: ${roomTitle ?? npc.location}`);
    }
    // Extract lore from dialogue tree
    for (const node of Object.values(npc.dialogue ?? {})) {
      parts.push(node.text);
    }
    if (npc.combat) {
      parts.push(`Combat NPC with ${npc.combat.hp} HP, AC ${npc.combat.ac}`);
    }
    docs.push({ id: `npc:${npcId}`, content: parts.join(". "), category: "npc", title: npc.name });
  }

  // ── Items ──
  // Build reverse lookup: itemId → roomId (first occurrence)
  const itemToRoom = new Map<string, string>();
  for (const [roomId, roomItemIds] of world.roomItems) {
    for (const itemId of roomItemIds) {
      if (!itemToRoom.has(itemId)) itemToRoom.set(itemId, roomId);
    }
  }

  for (const [itemId, item] of world.itemDefs) {
    const parts = [`${item.name}. ${item.description}`];
    parts.push(`Rarity: ${item.rarity}`);
    if (item.equippable && item.slot) parts.push(`Equippable: ${item.slot}`);
    if (item.usable && item.useEffect) parts.push(`Use effect: ${item.useEffect}`);
    if (item.fixed) parts.push("Cannot be picked up");
    const roomId = itemToRoom.get(itemId);
    if (roomId) {
      const room = world.rooms.get(roomId);
      const roomTitle = room ? getRoomTitle(room.muddown) : null;
      parts.push(`Found in: ${roomTitle ?? roomId}`);
    }
    docs.push({ id: `item:${itemId}`, content: parts.join(". "), category: "item", title: item.name });
  }

  // ── Recipes ──
  for (const recipe of world.recipes) {
    const item1Name = world.itemDefs.get(recipe.item1)?.name ?? recipe.item1;
    const item2Name = world.itemDefs.get(recipe.item2)?.name ?? recipe.item2;
    const resultName = world.itemDefs.get(recipe.result)?.name ?? recipe.result;
    const content = `Combine recipe: ${item1Name} + ${item2Name} = ${resultName}. ${recipe.description}`;
    docs.push({ id: `recipe:${recipe.item1}+${recipe.item2}`, content, category: "recipe", title: `${item1Name} + ${item2Name}` });
  }

  // ── Help entries ──
  for (const [cmd, entry] of Object.entries(helpEntries)) {
    const parts = [`Command: ${cmd}`];
    if (entry.aliases.length > 0) parts.push(`Aliases: ${entry.aliases.join(", ")}`);
    parts.push(entry.description);
    parts.push(entry.detail);
    if (entry.examples.length > 0) parts.push(`Examples: ${entry.examples.join(", ")}`);
    docs.push({ id: `help:${cmd}`, content: parts.join(". "), category: "help", title: `${cmd} command` });
  }

  return docs;
}
