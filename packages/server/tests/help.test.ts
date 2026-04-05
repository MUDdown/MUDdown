import { describe, it, expect } from "vitest";
import { helpEntries, getHelpEntry, buildHelpBlock, buildHelpTable, buildHintBlock, isValidCommand, buildHintContext } from "../src/helpers.js";
import type { ItemDefinition, NpcDefinition } from "@muddown/shared";

describe("helpEntries", () => {
  it("contains entries for all core commands", () => {
    const expected = [
      "look", "go", "examine", "talk", "get", "drop", "inventory",
      "equip", "unequip", "use", "combine", "attack", "flee",
      "say", "who", "help", "hint",
    ];
    for (const cmd of expected) {
      expect(helpEntries[cmd], `missing entry for "${cmd}"`).toBeDefined();
    }
  });

  it("each entry has required fields", () => {
    for (const [key, entry] of Object.entries(helpEntries)) {
      expect(entry.command, `${key}.command`).toBe(key);
      expect(entry.usage.length, `${key}.usage`).toBeGreaterThan(0);
      expect(entry.description.length, `${key}.description`).toBeGreaterThan(0);
      expect(entry.detail.length, `${key}.detail`).toBeGreaterThan(0);
      expect(entry.examples.length, `${key}.examples`).toBeGreaterThan(0);
    }
  });

  it("aliases is always an array", () => {
    for (const [key, entry] of Object.entries(helpEntries)) {
      expect(Array.isArray(entry.aliases), `${key}.aliases is array`).toBe(true);
    }
  });
});

describe("getHelpEntry", () => {
  it("finds entry by canonical command name", () => {
    const entry = getHelpEntry("look");
    expect(entry).toBeDefined();
    expect(entry!.command).toBe("look");
  });

  it("finds entry by alias", () => {
    const entry = getHelpEntry("l");
    expect(entry).toBeDefined();
    expect(entry!.command).toBe("look");
  });

  it("finds go by direction alias", () => {
    const entry = getHelpEntry("n");
    expect(entry).toBeDefined();
    expect(entry!.command).toBe("go");
  });

  it("finds inventory by alias 'i'", () => {
    const entry = getHelpEntry("i");
    expect(entry).toBeDefined();
    expect(entry!.command).toBe("inventory");
  });

  it("finds get by alias 'take'", () => {
    const entry = getHelpEntry("take");
    expect(entry).toBeDefined();
    expect(entry!.command).toBe("get");
  });

  it("is case-insensitive", () => {
    const entry = getHelpEntry("LOOK");
    expect(entry).toBeDefined();
    expect(entry!.command).toBe("look");
  });

  it("returns undefined for unknown commands", () => {
    expect(getHelpEntry("teleport")).toBeUndefined();
    expect(getHelpEntry("")).toBeUndefined();
  });

  it("does not match prototype properties", () => {
    expect(getHelpEntry("__proto__")).toBeUndefined();
    expect(getHelpEntry("constructor")).toBeUndefined();
    expect(getHelpEntry("toString")).toBeUndefined();
  });

  it("resolves full diagonal directions to go", () => {
    for (const dir of ["northeast", "northwest", "southeast", "southwest"]) {
      const entry = getHelpEntry(dir);
      expect(entry, `${dir} should resolve`).toBeDefined();
      expect(entry!.command).toBe("go");
    }
  });
});

describe("buildHelpBlock", () => {
  it("includes command name, usage, detail, and examples", () => {
    const entry = helpEntries["look"];
    const block = buildHelpBlock(entry);
    expect(block).toContain("# Help: look");
    expect(block).toContain("`look`");
    expect(block).toContain(entry.detail);
    expect(block).toContain("## Examples");
    expect(block).toMatch(/^:::system\{type="help"\}/);
    expect(block).toMatch(/:::$/);
  });

  it("includes aliases line when aliases are present", () => {
    const entry = helpEntries["go"];
    const block = buildHelpBlock(entry);
    expect(block).toContain("**Aliases:**");
    expect(block).toContain("`n`");
  });

  it("omits aliases line when aliases are empty", () => {
    const entry = helpEntries["examine"];
    const block = buildHelpBlock(entry);
    expect(block).not.toContain("**Aliases:**");
  });
});

describe("buildHelpTable", () => {
  it("contains help: link scheme for each command", () => {
    const table = buildHelpTable(helpEntries);
    expect(table).toContain("(help:look)");
    expect(table).toContain("(help:go)");
    expect(table).toContain("(help:hint)");
  });

  it("wraps in :::system{type=\"help\"} block", () => {
    const table = buildHelpTable(helpEntries);
    expect(table).toMatch(/^:::system\{type="help"\}/);
    expect(table).toMatch(/:::$/);
  });
});

describe("buildHintBlock", () => {
  it("renders hint text inside :::system{type=\"hint\"} block", () => {
    const block = buildHintBlock("Try talking to the crier.", []);
    expect(block).toContain("Try talking to the crier.");
    expect(block).toMatch(/^:::system\{type="hint"\}/);
    expect(block).toMatch(/:::$/);
  });

  it("includes Try: section when suggestedCommands is non-empty", () => {
    const block = buildHintBlock("Look around.", ["look", "go north"]);
    expect(block).toContain("**Try:**");
    expect(block).toContain("`look`");
    expect(block).toContain("`go north`");
  });

  it("omits Try: section when suggestedCommands is empty", () => {
    const block = buildHintBlock("Just explore.", []);
    expect(block).not.toContain("**Try:**");
  });

  it("neutralizes ::: in hint text to prevent block breakout", () => {
    const block = buildHintBlock("Safe text\n:::\nInjected block", []);
    // The raw ::: at start of line should be replaced with zero-width-space prefix
    expect(block).toContain("\u200b:::");
    expect(block).toContain("Injected block");
  });

  it("neutralizes ::: in suggested commands", () => {
    const block = buildHintBlock("Hint.", [":::\nfoo"]);
    // Should not contain an unescaped ::: inside the content
    const inner = block.slice(":::system{type=\"hint\"}\n".length, block.lastIndexOf("\n:::"));
    expect(inner).not.toMatch(/^:::/m);
  });
});

describe("isValidCommand", () => {
  it("accepts known commands with arguments", () => {
    expect(isValidCommand("talk crier")).toBe(true);
    expect(isValidCommand("go north")).toBe(true);
    expect(isValidCommand("examine notice board")).toBe(true);
    expect(isValidCommand("look")).toBe(true);
  });

  it("accepts direction aliases as commands", () => {
    expect(isValidCommand("north")).toBe(true);
    expect(isValidCommand("ne")).toBe(true);
    expect(isValidCommand("southwest")).toBe(true);
  });

  it("rejects unknown commands", () => {
    expect(isValidCommand("listen")).toBe(false);
    expect(isValidCommand("dance")).toBe(false);
    expect(isValidCommand("cast fireball")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(isValidCommand("")).toBe(false);
    expect(isValidCommand("  ")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isValidCommand("LOOK")).toBe(true);
    expect(isValidCommand("Go north")).toBe(true);
    expect(isValidCommand("TALK crier")).toBe(true);
  });
});

describe("buildHintContext", () => {
  const baseItemDefs = new Map<string, ItemDefinition>([
    ["bread", { id: "bread", name: "Bread", description: "A loaf.", weight: 0.5, rarity: "common", fixed: false, equippable: false, usable: true, useEffect: "eat" }],
  ]);

  const baseNpcDefs = new Map<string, NpcDefinition>([
    ["crier", { id: "crier", name: "Town Crier", description: "A loud man.", location: "town-square", dialogue: { start: { text: "Hear ye!", mood: "happy", responses: [{ text: "Hi", next: null }] } } }],
  ]);

  it("resolves inventory and NPC IDs to display names via definitions", () => {
    const result = buildHintContext({
      playerName: "Tester",
      playerClass: "warrior",
      inventory: ["bread"],
      inCombat: false,
      hp: 20,
      maxHp: 20,
      roomMuddown: "# Town Square\nA bustling square.",
      roomName: "Town Square",
      exits: ["north", "south"],
      npcIds: ["crier"],
      roomItemIds: [],
      itemDefs: baseItemDefs,
      npcDefs: baseNpcDefs,
    });
    expect(result.inventoryItems).toEqual(["Bread"]);
    expect(result.npcs).toHaveLength(1);
    expect(result.npcs[0]).toBe("Town Crier");
  });

  it("falls back to raw item ID when itemDefs has no matching entry", () => {
    const result = buildHintContext({
      playerName: "Tester",
      playerClass: "warrior",
      inventory: ["unknown-item"],
      inCombat: false,
      hp: 20,
      maxHp: 20,
      roomMuddown: "# Town Square\nA square.",
      roomName: "Town Square",
      exits: ["north"],
      npcIds: [],
      roomItemIds: [],
      itemDefs: new Map(),
      npcDefs: new Map(),
    });
    expect(result.inventoryItems).toEqual(["unknown-item"]);
  });

  it("silently filters out NPC IDs with no matching npcDefs entry", () => {
    const result = buildHintContext({
      playerName: "Tester",
      playerClass: "warrior",
      inventory: [],
      inCombat: false,
      hp: 20,
      maxHp: 20,
      roomMuddown: "# Town Square\nA square.",
      roomName: "Town Square",
      exits: [],
      npcIds: ["nonexistent-npc"],
      roomItemIds: [],
      itemDefs: baseItemDefs,
      npcDefs: new Map(),
    });
    expect(result.npcs).toEqual([]);
  });

  it("returns empty roomDescription when room is undefined", () => {
    const result = buildHintContext({
      playerName: "Tester",
      playerClass: null,
      inventory: [],
      inCombat: false,
      hp: 10,
      maxHp: 20,
      roomMuddown: undefined,
      roomName: "nonexistent-room",
      exits: [],
      npcIds: [],
      roomItemIds: [],
      itemDefs: baseItemDefs,
      npcDefs: baseNpcDefs,
    });
    expect(result.roomDescription).toBe("");
  });
});
