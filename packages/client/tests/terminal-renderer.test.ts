import { describe, it, expect } from "vitest";
import {
  renderTerminal,
  wordWrap,
} from "../src/terminal-renderer.js";

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Strip ANSI escape sequences for content-only assertions. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, "");
}

// ─── wordWrap ────────────────────────────────────────────────────────────────

describe("wordWrap", () => {
  it("wraps text at the specified column width", () => {
    const result = wordWrap("one two three four five", 10);
    expect(result).toBe("one two\nthree four\nfive");
  });

  it("does not break words longer than column width", () => {
    const result = wordWrap("superlongword short", 5);
    expect(result).toBe("superlongword\nshort");
  });

  it("returns text unchanged when it fits", () => {
    expect(wordWrap("hello", 80)).toBe("hello");
  });

  it("handles empty string", () => {
    expect(wordWrap("", 80)).toBe("");
  });

  it("handles zero column width gracefully", () => {
    expect(wordWrap("hello", 0)).toBe("hello");
  });
});

// ─── renderTerminal — plain text mode ────────────────────────────────────────

describe("renderTerminal (plain text)", () => {
  const opts = { ansi: false, cols: 80, linkMode: "plain" as const };

  it("renders headings as plain text", () => {
    const { text } = renderTerminal("# Room Title", opts);
    expect(text).toBe("Room Title");
  });

  it("renders H2 headings", () => {
    const { text } = renderTerminal("## Exits", opts);
    expect(text).toBe("Exits");
  });

  it("renders list items with bullet character", () => {
    const { text } = renderTerminal("- An item on the floor", opts);
    expect(text).toBe("• An item on the floor");
  });

  it("renders bold as plain text", () => {
    const { text } = renderTerminal("**bold text**", opts);
    expect(text).toBe("bold text");
  });

  it("renders italic as plain text", () => {
    const { text } = renderTerminal("*italic text*", opts);
    expect(text).toBe("italic text");
  });

  it("renders inline code as plain text", () => {
    const { text } = renderTerminal("`code`", opts);
    expect(text).toBe("code");
  });

  it("renders game links with command in parentheses", () => {
    const { text } = renderTerminal("[North](go:north)", opts);
    expect(text).toBe("North (go north)");
  });

  it("strips container block fences", () => {
    const input = `:::room{id="test" region="town" lighting="bright"}\n# Town Square\n\nA sunny plaza.\n:::`;
    const { text } = renderTerminal(input, opts);
    expect(text).toContain("Town Square");
    expect(text).toContain("A sunny plaza.");
    expect(text).not.toContain(":::");
  });

  it("preserves blank lines as visual separators", () => {
    const input = "# Title\n\nParagraph";
    const { text } = renderTerminal(input, opts);
    expect(text).toBe("Title\n\nParagraph");
  });

  it("renders blockquotes with plain bar", () => {
    const { text } = renderTerminal("> A quote", opts);
    expect(text).toBe("| A quote");
  });

  it("renders table rows", () => {
    const input = "| Name | Value |\n|------|-------|\n| HP | 100 |";
    const { text } = renderTerminal(input, opts);
    expect(text).toContain("Name");
    expect(text).toContain("Value");
    expect(text).toContain("HP");
    expect(text).toContain("100");
    // Separator row stripped
    expect(text).not.toContain("---");
  });

  it("aligns table columns with padding", () => {
    const input =
      "| Command | Description |\n|---------|-------------|\n| look | Look around |\n| inventory | Show items |";
    const { text } = renderTerminal(input, opts);
    const lines = text.split("\n").filter(l => l.trim());
    // "Command" (7) and "inventory" (9) → column padded to 9
    // Header "Command" should be padded to match "inventory" width
    expect(lines[0]).toContain("Command   | Description");
    // Separator line after header
    expect(lines[1]).toMatch(/-\+-/);
    expect(lines[2]).toContain("look      | Look around");
    expect(lines[3]).toContain("inventory | Show items");
  });
});

// ─── renderTerminal — ANSI styling ──────────────────────────────────────────

describe("renderTerminal (ANSI)", () => {
  const opts = { cols: 80, linkMode: "plain" as const };

  it("applies ANSI codes (output differs from stripped content)", () => {
    const input = `:::room{id="test"}\n# Room Title\n:::`;
    const { text } = renderTerminal(input, opts);
    // ANSI-styled text should contain escape sequences
    expect(text).toContain("\x1b[");
    // Stripped content should match
    expect(stripAnsi(text)).toBe("Room Title");
  });

  it("applies bold styling using ANSI", () => {
    const { text } = renderTerminal("**bold**", opts);
    expect(text).toContain("\x1b[");
    expect(stripAnsi(text)).toBe("bold");
  });

  it("applies italic styling using ANSI", () => {
    const { text } = renderTerminal("*italic*", opts);
    expect(text).toContain("\x1b[");
    expect(stripAnsi(text)).toBe("italic");
  });

  it("uses room styles for room blocks", () => {
    const input = `:::room{id="test"}\n# Green Title\n:::`;
    const { text } = renderTerminal(input, opts);
    // Green = \x1b[32m in ANSI
    expect(text).toContain("\x1b[");
    expect(stripAnsi(text)).toContain("Green Title");
  });

  it("uses combat styles for combat blocks", () => {
    const input = `:::combat{id="test"}\n# Battle!\n:::`;
    const { text } = renderTerminal(input, opts);
    expect(text).toContain("\x1b[");
    expect(stripAnsi(text)).toContain("Battle!");
  });

  it("uses system styles for system blocks", () => {
    const input = `:::system{type="info"}\n# System Message\n:::`;
    const { text } = renderTerminal(input, opts);
    expect(text).toContain("\x1b[");
    expect(stripAnsi(text)).toContain("System Message");
  });

  it("uses dialogue styles for dialogue blocks", () => {
    const input = `:::dialogue{npc="crier"}\n# Town Crier\n:::`;
    const { text } = renderTerminal(input, opts);
    expect(text).toContain("\x1b[");
    expect(stripAnsi(text)).toContain("Town Crier");
  });
});

// ─── Link modes ─────────────────────────────────────────────────────────────

describe("renderTerminal — link modes", () => {
  const input = "- [North](go:north)\n- [Examine sword](item:rusty-sword)";

  it("plain mode renders command in parentheses", () => {
    const { text, links } = renderTerminal(input, { ansi: false, linkMode: "plain" });
    expect(text).toContain("North (go north)");
    expect(text).toContain("Examine sword (examine rusty-sword)");
    expect(links).toHaveLength(0);
  });

  it("numbered mode appends [N] and populates links array", () => {
    const { text, links } = renderTerminal(input, { ansi: false, linkMode: "numbered" });
    expect(text).toContain("[1]");
    expect(text).toContain("[2]");
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ index: 1, command: "go north" });
    expect(links[1]).toEqual({ index: 2, command: "examine rusty-sword" });
  });

  it("osc8 mode shows game links as command hints (not clickable)", () => {
    const { text } = renderTerminal(input, { ansi: false, linkMode: "osc8" });
    expect(text).not.toContain("\x1b]8;;");
    expect(text).toContain("North (go north)");
    expect(text).toContain("Examine sword (examine rusty-sword)");
  });

  it("osc8 mode emits OSC 8 for external URLs", () => {
    const httpInput = "- [MUDdown](https://muddown.com)";
    const { text } = renderTerminal(httpInput, { ansi: false, linkMode: "osc8" });
    expect(text).toContain("\x1b]8;;https://muddown.com\x1b\\");
  });

  it("player links use display name instead of UUID", () => {
    const playerInput = "- [@Kandawen](player:a781b366-54a3-4ee0-a230-d1b5fb32b2c0)";
    const { text, links } = renderTerminal(playerInput, { ansi: false, linkMode: "numbered" });
    expect(links[0].command).toBe("look Kandawen");
    expect(text).not.toContain("a781b366");
  });

  it("player links show name in plain mode", () => {
    const playerInput = "- [@Kandawen](player:a781b366-54a3-4ee0-a230-d1b5fb32b2c0)";
    const { text } = renderTerminal(playerInput, { ansi: false, linkMode: "plain" });
    expect(text).toContain("look Kandawen");
    expect(text).not.toContain("a781b366");
  });
});

// ─── Container fence detection ──────────────────────────────────────────────

describe("renderTerminal — block type detection", () => {
  it("detects room block type from :::room{...}", () => {
    const input = `:::room{id="test"}\n# Title\n:::`;
    const { text } = renderTerminal(input, { cols: 80 });
    // Room heading should have ANSI codes (green for dark theme)
    expect(text).toContain("\x1b[");
  });

  it("detects combat block type from :::combat{...}", () => {
    const input = `:::combat{id="fight"}\n# Fight\n:::`;
    const { text } = renderTerminal(input, { cols: 80 });
    expect(text).toContain("\x1b[");
  });

  it("falls back to room style for unknown block types", () => {
    const input = `:::unknown{id="what"}\n# Something\n:::`;
    const { text } = renderTerminal(input, { cols: 80 });
    expect(stripAnsi(text)).toBe("Something");
  });

  it("uses narrative styles for :::narrative blocks", () => {
    const input = `:::narrative{id="test"}\n# A Vision\nYou see a distant light.\n:::`;
    const { text } = renderTerminal(input, { cols: 80 });
    expect(text).toContain("\x1b[");
    expect(stripAnsi(text)).toContain("A Vision");
    expect(stripAnsi(text)).toContain("You see a distant light.");
  });

  it("renders narrative block as plain text when ansi is false", () => {
    const input = `:::narrative{id="test"}\n# A Vision\nYou see a distant light.\n:::`;
    const { text } = renderTerminal(input, { ansi: false, cols: 80 });
    expect(text).not.toContain("\x1b[");
    expect(text).toContain("A Vision");
    expect(text).toContain("You see a distant light.");
  });
});

// ─── Word wrap integration ──────────────────────────────────────────────────

describe("renderTerminal — word wrap", () => {
  it("wraps long lines to specified column width", () => {
    const longLine = "word ".repeat(20).trim();
    const { text } = renderTerminal(longLine, { ansi: false, cols: 30 });
    const lines = text.split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });

  it("respects custom column width", () => {
    const longLine = "word ".repeat(20).trim();
    const { text: narrow } = renderTerminal(longLine, { ansi: false, cols: 20 });
    const { text: wide } = renderTerminal(longLine, { ansi: false, cols: 60 });
    expect(narrow.split("\n").length).toBeGreaterThan(wide.split("\n").length);
  });
});

// ─── Full room rendering ────────────────────────────────────────────────────

describe("renderTerminal — full room", () => {
  const room = `:::room{id="town-square" region="northkeep" lighting="bright"}
# Town Square

A bustling plaza with a **stone fountain** in the center.

## Exits
- [North](go:north) — Iron Gate
- [East](go:east) — Market Entrance

## Present
- A [town crier](npc:crier) stands near the fountain.

## Items
- A [rusty key](item:rusty-key) lies in the dust.
:::`;

  it("renders all sections in plain text", () => {
    const { text } = renderTerminal(room, { ansi: false, linkMode: "plain" });
    expect(text).toContain("Town Square");
    expect(text).toContain("stone fountain");
    expect(text).toContain("Exits");
    expect(text).toContain("North (go north)");
    expect(text).toContain("Iron Gate");
    expect(text).toContain("town crier (talk crier)");
    expect(text).toContain("rusty key (examine rusty-key)");
    expect(text).not.toContain(":::");
  });

  it("renders with numbered links and returns link table", () => {
    const { text, links } = renderTerminal(room, { ansi: false, linkMode: "numbered" });
    expect(links.length).toBe(4);
    expect(links[0].command).toBe("go north");
    expect(links[1].command).toBe("go east");
    // NPC and item links
    expect(links.some(l => l.command === "talk crier")).toBe(true);
    expect(links.some(l => l.command === "examine rusty-key")).toBe(true);
  });
});
