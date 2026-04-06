import { describe, it, expect, beforeAll } from "vitest";
import { tokenize, LoreVectorStore, buildLoreCorpus } from "../src/vectorstore.js";
import type { LoreDocument, SearchResult } from "../src/vectorstore.js";
import { loadWorld } from "../src/world.js";

// ─── tokenize ────────────────────────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases and splits text", () => {
    const tokens = tokenize("The Quick Brown Fox");
    expect(tokens).toContain("quick");
    expect(tokens).toContain("brown");
    expect(tokens).toContain("fox");
  });

  it("removes stop words", () => {
    const tokens = tokenize("the and or but in on at to for of with");
    expect(tokens).toHaveLength(0);
  });

  it("filters single-character tokens", () => {
    const tokens = tokenize("I a x go north");
    expect(tokens).not.toContain("i");
    expect(tokens).not.toContain("a");
    expect(tokens).not.toContain("x");
    expect(tokens).toContain("go");
    expect(tokens).toContain("north");
  });

  it("strips punctuation", () => {
    const tokens = tokenize("Hello, world! What's up?");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
  });

  it("returns empty for empty input", () => {
    expect(tokenize("")).toHaveLength(0);
    expect(tokenize("   ")).toHaveLength(0);
  });
});

// ─── LoreVectorStore ─────────────────────────────────────────────────────────

describe("LoreVectorStore", () => {
  function makeDocs(): LoreDocument[] {
    return [
      { id: "room:temple", content: "The Temple of the Silver Moon is a holy place of worship with ancient stained glass windows", category: "room", title: "Temple of the Silver Moon" },
      { id: "npc:priestess", content: "Priestess Sera serves the Temple and knows ancient Eltharan history and magical lore", category: "npc", title: "Priestess Sera" },
      { id: "npc:crier", content: "Town Crier Cedric announces news in the town square with his brass bell", category: "npc", title: "Town Crier" },
      { id: "item:sword", content: "A dull shortsword with a nicked edge. Equippable as a weapon.", category: "item", title: "Dull Shortsword" },
      { id: "room:market", content: "A busy market square with colorful stalls selling goods and wares", category: "room", title: "Market Square" },
    ];
  }

  it("indexes documents and reports correct size", () => {
    const store = new LoreVectorStore();
    store.index(makeDocs());
    expect(store.size).toBe(5);
  });

  it("returns empty results for empty store", () => {
    const store = new LoreVectorStore();
    expect(store.search("temple")).toHaveLength(0);
  });

  it("returns empty results for empty query", () => {
    const store = new LoreVectorStore();
    store.index(makeDocs());
    expect(store.search("")).toHaveLength(0);
  });

  it("returns empty results for stop-word-only query", () => {
    const store = new LoreVectorStore();
    store.index(makeDocs());
    expect(store.search("the and or")).toHaveLength(0);
  });

  it("finds relevant documents by keyword", () => {
    const store = new LoreVectorStore();
    store.index(makeDocs());
    const results = store.search("temple");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].document.id).toBe("room:temple");
  });

  it("ranks the most relevant document first", () => {
    const store = new LoreVectorStore();
    store.index(makeDocs());
    const results = store.search("priestess temple ancient lore");
    expect(results.length).toBeGreaterThan(1);
    // Priestess doc has more overlapping terms
    expect(results[0].document.id).toBe("npc:priestess");
  });

  it("respects the top-k limit", () => {
    const store = new LoreVectorStore();
    store.index(makeDocs());
    const results = store.search("the town square market", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns scores between 0 and 1", () => {
    const store = new LoreVectorStore();
    store.index(makeDocs());
    const results = store.search("temple moon worship");
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("finds items by item-specific terms", () => {
    const store = new LoreVectorStore();
    store.index(makeDocs());
    const results = store.search("weapon sword equip");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].document.id).toBe("item:sword");
  });

  it("can re-index with new documents", () => {
    const store = new LoreVectorStore();
    store.index(makeDocs());
    expect(store.size).toBe(5);

    store.index([{ id: "test:1", content: "Only document here", category: "room", title: "Test" }]);
    expect(store.size).toBe(1);
    const results = store.search("Only document");
    expect(results).toHaveLength(1);
  });
});

// ─── buildLoreCorpus (production world) ──────────────────────────────────────

describe("buildLoreCorpus", () => {
  let world: ReturnType<typeof loadWorld>;
  let corpus: LoreDocument[];

  beforeAll(() => {
    world = loadWorld();
    corpus = buildLoreCorpus(world);
  });

  it("includes room documents", () => {
    const rooms = corpus.filter(d => d.category === "room");
    expect(rooms.length).toBe(world.rooms.size);
  });

  it("includes NPC documents", () => {
    const npcs = corpus.filter(d => d.category === "npc");
    expect(npcs.length).toBe(world.npcDefs.size);
  });

  it("includes item documents", () => {
    const items = corpus.filter(d => d.category === "item");
    expect(items.length).toBe(world.itemDefs.size);
  });

  it("includes recipe documents", () => {
    const recipes = corpus.filter(d => d.category === "recipe");
    expect(recipes.length).toBe(world.recipes.length);
  });

  it("includes help documents", () => {
    const help = corpus.filter(d => d.category === "help");
    expect(help.length).toBeGreaterThan(0);
  });

  it("produces non-empty content for all documents", () => {
    for (const doc of corpus) {
      expect(doc.content.length).toBeGreaterThan(0);
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.id.length).toBeGreaterThan(0);
    }
  });

  it("includes NPC backstories in NPC documents", () => {
    const priestess = corpus.find(d => d.id === "npc:priestess");
    expect(priestess).toBeDefined();
    expect(priestess!.content).toContain("Eltharan");
  });

  it("includes item locations in item documents", () => {
    // At least some items should have "Found in:" in their content
    const itemsWithLocation = corpus.filter(d => d.category === "item" && d.content.includes("Found in:"));
    expect(itemsWithLocation.length).toBeGreaterThan(0);
  });

  it("produces a corpus that can be indexed and searched", () => {
    const store = new LoreVectorStore();
    store.index(corpus);
    expect(store.size).toBe(corpus.length);

    const results = store.search("priestess temple silver moon");
    expect(results.length).toBeGreaterThan(0);
    // Should find temple or priestess
    const ids = results.map(r => r.document.id);
    expect(ids.some(id => id.includes("priestess") || id.includes("temple"))).toBe(true);
  });
});
