import { describe, it, expect, beforeAll } from "vitest";
import type { WorldMap } from "../src/world.js";
import { loadWorld } from "../src/world.js";

describe("loadWorld — production Northkeep data", () => {
  let world: WorldMap;

  beforeAll(() => {
    world = loadWorld();
  });

  it("loads all 31 items from world/items/", () => {
    expect(world.itemDefs.size).toBe(31);
  });

  it("loads all 2 recipes", () => {
    expect(world.recipes).toHaveLength(2);
  });

  it("loads all 16 NPCs", () => {
    expect(world.npcDefs.size).toBe(16);
  });

  it("loads all 24 rooms", () => {
    expect(world.rooms.size).toBe(24);
  });

  const opposites: Record<string, string> = {
    north: "south", south: "north",
    east: "west", west: "east",
    up: "down", down: "up",
    northeast: "southwest", southwest: "northeast",
    northwest: "southeast", southeast: "northwest",
  };

  it("every room has bidirectional exits", () => {
    for (const [roomId, exits] of world.connections) {
      for (const [direction, targetId] of Object.entries(exits)) {
        const reverseExits = world.connections.get(targetId);
        expect(reverseExits, `Room "${targetId}" (target of ${roomId}→${direction}) has no connections`).toBeDefined();
        const reverse = opposites[direction];
        if (reverse) {
          expect(
            reverseExits![reverse],
            `${targetId} should have ${reverse}→${roomId} (reverse of ${roomId}→${direction}→${targetId})`
          ).toBe(roomId);
        }
      }
    }
  });

  it("every room item reference corresponds to a valid item definition", () => {
    for (const [roomId, itemIds] of world.roomItems) {
      for (const itemId of itemIds) {
        expect(
          world.itemDefs.has(itemId),
          `Room "${roomId}" references unknown item "${itemId}"`
        ).toBe(true);
      }
    }
  });

  it("every NPC location corresponds to a valid room", () => {
    for (const [npcId, npc] of world.npcDefs) {
      expect(
        world.rooms.has(npc.location),
        `NPC "${npcId}" has location "${npc.location}" which is not a valid room`
      ).toBe(true);
    }
  });

  it("every recipe references valid item definitions", () => {
    for (const recipe of world.recipes) {
      expect(world.itemDefs.has(recipe.item1), `Recipe ingredient "${recipe.item1}" not found`).toBe(true);
      expect(world.itemDefs.has(recipe.item2), `Recipe ingredient "${recipe.item2}" not found`).toBe(true);
      expect(world.itemDefs.has(recipe.result), `Recipe result "${recipe.result}" not found`).toBe(true);
    }
  });

  it("every NPC has a valid start dialogue node", () => {
    for (const [npcId, npc] of world.npcDefs) {
      expect(
        npc.dialogue["start"],
        `NPC "${npcId}" has no "start" dialogue node`
      ).toBeDefined();
      expect(npc.dialogue["start"].text).toBeTruthy();
      expect(npc.dialogue["start"].responses).toBeDefined();
    }
  });

  it("every NPC dialogue response references a valid node or null", () => {
    for (const [npcId, npc] of world.npcDefs) {
      for (const [nodeId, node] of Object.entries(npc.dialogue)) {
        for (const resp of node.responses) {
          if (resp.next !== null) {
            expect(
              npc.dialogue[resp.next],
              `NPC "${npcId}" dialogue node "${nodeId}" response "${resp.text}" references missing node "${resp.next}"`
            ).toBeDefined();
          }
        }
      }
    }
  });

  it("specific known items exist with correct properties", () => {
    const bread = world.itemDefs.get("bread");
    expect(bread).toBeDefined();
    expect(bread!.name).toBe("Loaf of Bread");
    expect(bread!.usable).toBe(true);
    expect(bread!.fixed).toBe(false);

    const telescope = world.itemDefs.get("telescope");
    expect(telescope).toBeDefined();
    expect(telescope!.fixed).toBe(true);

    const longbow = world.itemDefs.get("longbow");
    expect(longbow).toBeDefined();
    expect(longbow!.equippable).toBe(true);
  });

  it("specific known NPCs exist in correct rooms", () => {
    const crier = world.npcDefs.get("crier");
    expect(crier).toBeDefined();
    expect(crier!.name).toBe("Town Crier");
    expect(crier!.location).toBe("town-square");

    const priestess = world.npcDefs.get("priestess");
    expect(priestess).toBeDefined();
    expect(priestess!.location).toBe("temple");

    const wolf = world.npcDefs.get("wolf");
    expect(wolf).toBeDefined();
    expect(wolf!.location).toBe("deep-forest");
  });

  it("combat NPCs have valid combat stats", () => {
    const combatNpcs = [...world.npcDefs.values()].filter((npc) => npc.combat);
    expect(combatNpcs.length).toBeGreaterThan(0);
    for (const npc of combatNpcs) {
      const stats = npc.combat!;
      expect(stats.hp, `NPC "${npc.id}" hp`).toBeGreaterThan(0);
      expect(stats.maxHp, `NPC "${npc.id}" maxHp`).toBe(stats.hp);
      expect(stats.ac, `NPC "${npc.id}" ac`).toBeGreaterThan(0);
      expect(stats.attackBonus, `NPC "${npc.id}" attackBonus`).toBeGreaterThanOrEqual(0);
      expect(stats.damage, `NPC "${npc.id}" damage`).toMatch(/^[1-9]\d*d[1-9]\d*([+-]\d+)?$/);
      expect(stats.xp, `NPC "${npc.id}" xp`).toBeGreaterThan(0);
    }
  });

  it("non-combat NPCs do not have combat stats", () => {
    const crier = world.npcDefs.get("crier");
    expect(crier).toBeDefined();
    expect(crier!.combat).toBeUndefined();

    const priestess = world.npcDefs.get("priestess");
    expect(priestess).toBeDefined();
    expect(priestess!.combat).toBeUndefined();
  });

  it("equippable weapons with damage have valid damage expressions", () => {
    const weapons = [...world.itemDefs.values()].filter(
      (item) => item.equippable && item.damage,
    );
    expect(weapons.length).toBeGreaterThan(0);
    for (const weapon of weapons) {
      if (!weapon.equippable) continue; // type narrowing
      expect(weapon.damage, `Item "${weapon.id}" damage`).toMatch(/^[1-9]\d*d[1-9]\d*([+-]\d+)?$/);
      expect(weapon.attackBonus ?? 0, `Item "${weapon.id}" attackBonus`).toBeGreaterThanOrEqual(0);
    }
  });

  it("town-square room exists and has correct region", () => {
    const townSquare = world.rooms.get("town-square");
    expect(townSquare).toBeDefined();
    expect(townSquare!.attributes.region).toBe("northkeep");
    expect(townSquare!.muddown).toContain("Town Square");
  });
});
