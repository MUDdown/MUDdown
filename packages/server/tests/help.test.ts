import { describe, it, expect } from "vitest";
import { helpEntries, getHelpEntry, buildHelpBlock, buildHelpTable, buildHintBlock } from "../src/helpers.js";

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
});
