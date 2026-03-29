import { describe, it, expect, vi } from "vitest";
import {
  rollD20, rollDice, resolveAttack, formatAttackLine,
  getPlayerAttackBonus, getPlayerDamage, getPlayerAc,
  resetPlayerAfterDefeat,
} from "../src/helpers.js";
import type { ItemDefinition } from "@muddown/shared";

// ─── rollD20 ─────────────────────────────────────────────────────────────────

describe("rollD20", () => {
  it("returns a number between 1 and 20", () => {
    for (let i = 0; i < 100; i++) {
      const roll = rollD20();
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(20);
    }
  });
});

// ─── rollDice ────────────────────────────────────────────────────────────────

describe("rollDice", () => {
  it("parses 1d6 and rolls in range", () => {
    for (let i = 0; i < 50; i++) {
      const result = rollDice("1d6");
      expect(result.rolls).toHaveLength(1);
      expect(result.modifier).toBe(0);
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeLessThanOrEqual(6);
    }
  });

  it("parses 2d8+3", () => {
    for (let i = 0; i < 50; i++) {
      const result = rollDice("2d8+3");
      expect(result.rolls).toHaveLength(2);
      expect(result.modifier).toBe(3);
      expect(result.total).toBeGreaterThanOrEqual(5); // 2×1 + 3
      expect(result.total).toBeLessThanOrEqual(19);   // 2×8 + 3
    }
  });

  it("parses 1d4-1 with negative modifier", () => {
    const result = rollDice("1d4-1");
    expect(result.modifier).toBe(-1);
    expect(result.total).toBeGreaterThanOrEqual(0); // min 0
    expect(result.total).toBeLessThanOrEqual(3);
  });

  it("returns 0 for invalid expressions", () => {
    const result = rollDice("invalid");
    expect(result.total).toBe(0);
    expect(result.rolls).toEqual([0]);
  });
});

// ─── resolveAttack ───────────────────────────────────────────────────────────

describe("resolveAttack", () => {
  it("returns a valid AttackResult structure", () => {
    const result = resolveAttack(2, "1d6", 12);
    expect(result).toHaveProperty("roll");
    expect(result).toHaveProperty("attackBonus", 2);
    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("targetAc", 12);
    expect(result).toHaveProperty("hit");
    expect(result).toHaveProperty("damage");
    expect(result.roll).toBeGreaterThanOrEqual(1);
    expect(result.roll).toBeLessThanOrEqual(20);
    expect(result.total).toBe(result.roll + 2);
  });

  it("deals at least 1 damage on hit", () => {
    // Run many times to catch at least one hit
    let sawHit = false;
    for (let i = 0; i < 200; i++) {
      const result = resolveAttack(10, "1d4", 10); // high bonus, should hit often
      if (result.hit) {
        expect(result.damage).toBeGreaterThanOrEqual(1);
        sawHit = true;
      }
    }
    expect(sawHit).toBe(true);
  });

  it("deals 0 damage on miss", () => {
    let sawMiss = false;
    for (let i = 0; i < 200; i++) {
      const result = resolveAttack(-5, "1d6", 25); // low bonus, high AC
      if (!result.hit) {
        expect(result.damage).toBe(0);
        sawMiss = true;
      }
    }
    expect(sawMiss).toBe(true);
  });
});

// ─── formatAttackLine ────────────────────────────────────────────────────────

describe("formatAttackLine", () => {
  it("formats a hit correctly", () => {
    const result = {
      roll: 15, attackBonus: 3, total: 18, targetAc: 14,
      hit: true, damage: 7, damageRolls: [5], damageModifier: 2,
    };
    const text = formatAttackLine("@Tharion", "Wolf", "longsword", result, 5, 12);
    expect(text).toContain("**@Tharion** attacks **Wolf** with a longsword...");
    expect(text).toContain("15 + 3 = 18 vs AC 14");
    expect(text).toContain("**Hit!**");
    expect(text).toContain("Damage: 7");
    expect(text).toContain("Wolf HP: 5/12");
  });

  it("formats a miss correctly", () => {
    const result = {
      roll: 5, attackBonus: 2, total: 7, targetAc: 15,
      hit: false, damage: 0, damageRolls: [], damageModifier: 0,
    };
    const text = formatAttackLine("Wolf", "@Tharion", undefined, result, 18, 20);
    expect(text).toContain("**Wolf** attacks **@Tharion**...");
    expect(text).toContain("**Miss!**");
    expect(text).not.toContain("Damage:");
  });
});

// ─── getPlayerAttackBonus ────────────────────────────────────────────────────

describe("getPlayerAttackBonus", () => {
  const items = new Map<string, ItemDefinition>();
  items.set("sword", {
    id: "sword", name: "Sword", description: "", weight: 1, rarity: "common", fixed: false,
    equippable: true, slot: "weapon", attackBonus: 3, damage: "1d8",
    usable: false,
  } as ItemDefinition);

  it("returns base bonus with no weapon", () => {
    expect(getPlayerAttackBonus(2, null, items)).toBe(2);
  });

  it("adds weapon attackBonus", () => {
    expect(getPlayerAttackBonus(2, "sword", items)).toBe(5);
  });

  it("returns base bonus for unknown weapon", () => {
    expect(getPlayerAttackBonus(2, "nonexistent", items)).toBe(2);
  });
});

// ─── getPlayerDamage ─────────────────────────────────────────────────────────

describe("getPlayerDamage", () => {
  const items = new Map<string, ItemDefinition>();
  items.set("sword", {
    id: "sword", name: "Sword", description: "", weight: 1, rarity: "common", fixed: false,
    equippable: true, slot: "weapon", attackBonus: 3, damage: "1d8",
    usable: false,
  } as ItemDefinition);

  it("returns base damage with no weapon", () => {
    expect(getPlayerDamage("1d4", null, items)).toBe("1d4");
  });

  it("uses weapon damage", () => {
    expect(getPlayerDamage("1d4", "sword", items)).toBe("1d8");
  });

  it("returns base damage for unknown weapon", () => {
    expect(getPlayerDamage("1d4", "nonexistent", items)).toBe("1d4");
  });
});

// ─── getPlayerAc ─────────────────────────────────────────────────────────────

describe("getPlayerAc", () => {
  const items = new Map<string, ItemDefinition>();
  items.set("shield", {
    id: "shield", name: "Shield", description: "", weight: 3, rarity: "common", fixed: false,
    equippable: true, slot: "armor", acBonus: 2,
    usable: false,
  } as ItemDefinition);
  items.set("ring", {
    id: "ring", name: "Ring", description: "", weight: 0.1, rarity: "uncommon", fixed: false,
    equippable: true, slot: "accessory", acBonus: 1,
    usable: false,
  } as ItemDefinition);

  it("returns base AC with no equipment", () => {
    expect(getPlayerAc(10, null, null, items)).toBe(10);
  });

  it("adds armor AC bonus", () => {
    expect(getPlayerAc(10, "shield", null, items)).toBe(12);
  });

  it("adds both armor and accessory AC bonus", () => {
    expect(getPlayerAc(10, "shield", "ring", items)).toBe(13);
  });

  it("adds accessory-only AC bonus", () => {
    expect(getPlayerAc(10, null, "ring", items)).toBe(11);
  });

  it("returns base AC for unknown equipment", () => {
    expect(getPlayerAc(10, "nonexistent", "bogus", items)).toBe(10);
  });
});

// ─── resolveAttack (deterministic) ───────────────────────────────────────────

describe("resolveAttack deterministic", () => {
  it("natural 20 always hits regardless of AC", () => {
    vi.spyOn(Math, "random").mockReturnValue(19 / 20); // roll = 20
    const result = resolveAttack(0, "1d4", 100); // AC way higher than total
    expect(result.roll).toBe(20);
    expect(result.hit).toBe(true);
    expect(result.damage).toBeGreaterThanOrEqual(1);
    vi.restoreAllMocks();
  });

  it("natural 1 always misses regardless of total", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // roll = 1
    const result = resolveAttack(100, "1d4", 1); // total way higher than AC
    expect(result.roll).toBe(1);
    expect(result.hit).toBe(false);
    expect(result.damage).toBe(0);
    vi.restoreAllMocks();
  });

  it("clamps damage to minimum 1 on hit with 1d1-1", () => {
    // Force a non-critical hit: roll = 15 (Math.random = 14/20)
    vi.spyOn(Math, "random").mockReturnValue(14 / 20);
    const result = resolveAttack(5, "1d1-1", 10); // 1d1-1 → total = 0
    expect(result.hit).toBe(true);
    expect(result.damage).toBe(1);
    vi.restoreAllMocks();
  });
});

// ─── resetPlayerAfterDefeat ──────────────────────────────────────────────────

describe("resetPlayerAfterDefeat", () => {
  it("clears combat, restores HP, and sets respawn room", () => {
    const session = {
      combat: { npcId: "wolf", roomId: "forest", round: 3, npcHp: 5, npcMaxHp: 12 },
      hp: 0,
      maxHp: 20,
      currentRoom: "deep-forest",
    };
    resetPlayerAfterDefeat(session, "town-square");
    expect(session.combat).toBeNull();
    expect(session.hp).toBe(20);
    expect(session.currentRoom).toBe("town-square");
  });
});
