import { describe, it, expect } from "vitest";
import type { ItemDefinition } from "@muddown/shared";
import { buildInventoryState } from "../src/helpers.js";

function makeItem(overrides: Partial<ItemDefinition> & { id: string; name: string }): ItemDefinition {
  return {
    description: "test item",
    weight: 1,
    rarity: "common",
    fixed: false,
    equippable: false,
    usable: false,
    ...overrides,
  } as ItemDefinition;
}

const EMPTY_EQUIPPED = { weapon: null, armor: null, accessory: null };

describe("buildInventoryState", () => {
  it("returns empty items and null slots for an empty inventory", () => {
    const result = buildInventoryState([], EMPTY_EQUIPPED, new Map());
    expect(result.items).toHaveLength(0);
    expect(result.equipped.weapon).toBeNull();
    expect(result.equipped.armor).toBeNull();
    expect(result.equipped.accessory).toBeNull();
  });

  it("maps known item IDs to their definition fields", () => {
    const defs = new Map<string, ItemDefinition>([
      ["sword", makeItem({ id: "sword", name: "Iron Sword", equippable: true, slot: "weapon" })],
    ]);
    const result = buildInventoryState(["sword"], EMPTY_EQUIPPED, defs);
    expect(result.items[0]).toEqual({
      id: "sword",
      name: "Iron Sword",
      equippable: true,
      usable: false,
    });
  });

  it("falls back to raw ID and false flags for unknown item IDs", () => {
    const result = buildInventoryState(["ghost-item"], EMPTY_EQUIPPED, new Map());
    expect(result.items[0]).toEqual({
      id: "ghost-item",
      name: "ghost-item",
      equippable: false,
      usable: false,
    });
  });

  it("maps equipped slots to name/id pairs for known defs", () => {
    const defs = new Map<string, ItemDefinition>([
      ["sword", makeItem({ id: "sword", name: "Iron Sword", equippable: true, slot: "weapon" })],
    ]);
    const result = buildInventoryState(["sword"], { weapon: "sword", armor: null, accessory: null }, defs);
    expect(result.equipped.weapon).toEqual({ id: "sword", name: "Iron Sword" });
    expect(result.equipped.armor).toBeNull();
  });

  it("falls back to raw ID for equipped items with missing defs", () => {
    const result = buildInventoryState(["ghost"], { weapon: "ghost", armor: null, accessory: null }, new Map());
    expect(result.equipped.weapon).toEqual({ id: "ghost", name: "ghost" });
  });

  it("includes equipped items in items list", () => {
    const defs = new Map<string, ItemDefinition>([
      ["sword", makeItem({ id: "sword", name: "Iron Sword", equippable: true, slot: "weapon" })],
    ]);
    const result = buildInventoryState(["sword"], { weapon: "sword", armor: null, accessory: null }, defs);
    expect(result.equipped.weapon?.id).toBe("sword");
    expect(result.items.find(i => i.id === "sword")).toBeDefined();
  });
});
