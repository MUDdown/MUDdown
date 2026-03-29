import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadWorld } from "../src/world.js";
import { createFixtureDir, cleanupFixtureDir, writeItem } from "./fixtures.js";

describe("loadWorld — items", () => {
  let dir: string;

  beforeEach(() => {
    dir = createFixtureDir();
  });

  afterEach(() => {
    cleanupFixtureDir(dir);
  });

  it("loads a basic non-equippable non-usable item", () => {
    writeItem(dir, "rope.json", {
      id: "rope",
      name: "Coil of Rope",
      description: "Fifty feet of hemp rope.",
      weight: 2.0,
      rarity: "common",
      fixed: false,
      equippable: false,
      usable: false,
    });

    const world = loadWorld(dir);
    expect(world.itemDefs.size).toBe(1);
    const item = world.itemDefs.get("rope");
    expect(item).toBeDefined();
    expect(item!.name).toBe("Coil of Rope");
    expect(item!.equippable).toBe(false);
    expect(item!.usable).toBe(false);
  });

  it("loads an equippable item with slot", () => {
    writeItem(dir, "sword.json", {
      id: "sword",
      name: "Iron Sword",
      description: "A sturdy blade.",
      weight: 1.5,
      rarity: "common",
      fixed: false,
      equippable: true,
      slot: "weapon",
      usable: false,
    });

    const world = loadWorld(dir);
    const item = world.itemDefs.get("sword");
    expect(item).toBeDefined();
    expect(item!.equippable).toBe(true);
    if (item!.equippable) {
      expect(item!.slot).toBe("weapon");
    }
  });

  it("loads a usable item with useEffect", () => {
    writeItem(dir, "bread.json", {
      id: "bread",
      name: "Loaf of Bread",
      description: "A fresh loaf.",
      weight: 0.5,
      rarity: "common",
      fixed: false,
      equippable: false,
      usable: true,
      useEffect: "eat",
    });

    const world = loadWorld(dir);
    const item = world.itemDefs.get("bread");
    expect(item).toBeDefined();
    expect(item!.usable).toBe(true);
    if (item!.usable) {
      expect(item!.useEffect).toBe("eat");
    }
  });

  it("loads a fixed item", () => {
    writeItem(dir, "telescope.json", {
      id: "telescope",
      name: "Brass Telescope",
      description: "Bolted to the railing.",
      weight: 5.0,
      rarity: "uncommon",
      fixed: true,
      equippable: false,
      usable: true,
      useEffect: "look-through",
    });

    const world = loadWorld(dir);
    const item = world.itemDefs.get("telescope");
    expect(item).toBeDefined();
    expect(item!.fixed).toBe(true);
  });

  it("loads multiple items from separate files", () => {
    writeItem(dir, "a.json", {
      id: "item-a", name: "A", description: "Desc A",
      weight: 1, rarity: "common", fixed: false, equippable: false, usable: false,
    });
    writeItem(dir, "b.json", {
      id: "item-b", name: "B", description: "Desc B",
      weight: 2, rarity: "rare", fixed: false, equippable: false, usable: false,
    });

    const world = loadWorld(dir);
    expect(world.itemDefs.size).toBe(2);
    expect(world.itemDefs.has("item-a")).toBe(true);
    expect(world.itemDefs.has("item-b")).toBe(true);
  });

  it("skips items with missing id", () => {
    writeItem(dir, "bad.json", {
      name: "No ID", description: "Missing id field",
      weight: 1, rarity: "common", fixed: false, equippable: false, usable: false,
    });

    const world = loadWorld(dir);
    expect(world.itemDefs.size).toBe(0);
  });

  it("skips items with invalid rarity", () => {
    writeItem(dir, "bad.json", {
      id: "bad", name: "Bad", description: "Bad rarity",
      weight: 1, rarity: "mythical", fixed: false, equippable: false, usable: false,
    });

    const world = loadWorld(dir);
    expect(world.itemDefs.size).toBe(0);
  });

  it("skips equippable items with invalid slot", () => {
    writeItem(dir, "bad.json", {
      id: "bad", name: "Bad", description: "Invalid slot",
      weight: 1, rarity: "common", fixed: false,
      equippable: true, slot: "boots", usable: false,
    });

    const world = loadWorld(dir);
    expect(world.itemDefs.size).toBe(0);
  });

  it("skips usable items without useEffect", () => {
    writeItem(dir, "bad.json", {
      id: "bad", name: "Bad", description: "Missing useEffect",
      weight: 1, rarity: "common", fixed: false,
      equippable: false, usable: true,
    });

    const world = loadWorld(dir);
    expect(world.itemDefs.size).toBe(0);
  });

  it("skips non-.json files in items directory", () => {
    writeFileSync(join(dir, "items", "readme.txt"), "Not an item");

    const world = loadWorld(dir);
    expect(world.itemDefs.size).toBe(0);
  });

  it("handles missing items directory gracefully", () => {
    rmSync(join(dir, "items"), { recursive: true, force: true });

    const world = loadWorld(dir);
    expect(world.itemDefs.size).toBe(0);
  });
});
