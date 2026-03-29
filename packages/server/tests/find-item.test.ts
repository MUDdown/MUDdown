import { describe, it, expect } from "vitest";
import type { ItemDefinition } from "@muddown/shared";
import { findItemByName } from "../src/helpers.js";

function makeItem(overrides: Partial<ItemDefinition> & { id: string; name: string }): ItemDefinition {
  return {
    description: "Test item",
    weight: 1,
    rarity: "common",
    fixed: false,
    equippable: false,
    usable: false,
    ...overrides,
  } as ItemDefinition;
}

describe("findItemByName", () => {
  const sword = makeItem({ id: "iron-sword", name: "Iron Sword" });
  const shield = makeItem({ id: "wooden-shield", name: "Wooden Shield" });
  const bread = makeItem({ id: "bread", name: "Loaf of Bread", usable: true, useEffect: "eat" });

  const itemDefs = new Map<string, ItemDefinition>([
    ["iron-sword", sword],
    ["wooden-shield", shield],
    ["bread", bread],
  ]);

  const allIds = ["iron-sword", "wooden-shield", "bread"];

  it("finds item by exact id", () => {
    expect(findItemByName("iron-sword", allIds, itemDefs)).toBe(sword);
  });

  it("finds item by exact name (case-insensitive)", () => {
    expect(findItemByName("Iron Sword", allIds, itemDefs)).toBe(sword);
    expect(findItemByName("iron sword", allIds, itemDefs)).toBe(sword);
    expect(findItemByName("IRON SWORD", allIds, itemDefs)).toBe(sword);
  });

  it("finds item by partial id match", () => {
    expect(findItemByName("sword", allIds, itemDefs)).toBe(sword);
  });

  it("finds item by partial name match", () => {
    expect(findItemByName("loaf", allIds, itemDefs)).toBe(bread);
  });

  it("prefers exact match over partial match", () => {
    const iron = makeItem({ id: "iron", name: "Iron Ingot" });
    const extDefs = new Map(itemDefs);
    extDefs.set("iron", iron);
    const extIds = [...allIds, "iron"];
    expect(findItemByName("iron", extIds, extDefs)).toBe(iron);
  });

  it("returns undefined for no match", () => {
    expect(findItemByName("potion", allIds, itemDefs)).toBeUndefined();
  });

  it("only searches provided itemIds, not all defs", () => {
    expect(findItemByName("bread", ["iron-sword"], itemDefs)).toBeUndefined();
  });

  it("skips unknown IDs gracefully", () => {
    expect(findItemByName("sword", ["nonexistent", "iron-sword"], itemDefs)).toBe(sword);
  });

  it("returns undefined for empty list", () => {
    expect(findItemByName("sword", [], itemDefs)).toBeUndefined();
  });
});
