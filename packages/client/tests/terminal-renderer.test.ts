import { describe, it, expect, vi } from "vitest";
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

  it("does not split inside an OSC 8 hyperlink envelope", () => {
    // URI contains a literal space (`send:talk crier`).  Without OSC 8
    // awareness the wrapper would split between `talk` and `crier`,
    // breaking the envelope and leaking a raw space into the URI.
    const envelope = "\x1b]8;;send:talk crier\x1b\\town crier\x1b]8;;\x1b\\";
    const input = `prefix ${envelope} suffix`;
    const wrapped = wordWrap(input, 20);
    // The envelope and its inner text must stay together on one line —
    // no newline anywhere between the opener and its matching closer.
    expect(wrapped).toContain(envelope);
    // The URI must survive intact.
    expect(wrapped).toContain("send:talk crier");
    // And there must be no newline anywhere between the OSC 8 opener
    // and its matching closer.
    const openerIdx = wrapped.indexOf("\x1b]8;;send:");
    const closerIdx = wrapped.indexOf("\x1b]8;;\x1b\\", openerIdx + 1);
    expect(openerIdx).toBeGreaterThanOrEqual(0);
    expect(closerIdx).toBeGreaterThan(openerIdx);
    expect(wrapped.slice(openerIdx, closerIdx).includes("\n")).toBe(false);
  });

  it("treats a complete OSC 8 envelope as an atomic word", () => {
    // A long envelope that exceeds the column width must wrap as a
    // whole unit rather than being sliced mid-URI.
    const envelope = "\x1b]8;;send:examine%20the%20very%20long%20target\x1b\\look\x1b]8;;\x1b\\";
    const wrapped = wordWrap(`short ${envelope} tail`, 10);
    expect(wrapped.split("\n").some(line => line.includes(envelope))).toBe(true);
  });

  it("does not crash on an unterminated OSC 8 opener", () => {
    // No ST/BEL terminator — the opener runs to end-of-input. The
    // wrapper must still return a string (we accept a long unbreakable
    // line as the degraded outcome) and not throw.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const input = "pre \x1b]8;;send:go north\x1b\\north never closed";
      expect(() => wordWrap(input, 10)).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled(); // terminator IS present in the opener above
      // Now a truly unterminated opener:
      const broken = "pre \x1b]8;;send:go%20north and then more text";
      expect(() => wordWrap(broken, 10)).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
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

  it("osc8-send mode wraps game links in OSC 8 send: URIs", () => {
    const { text } = renderTerminal(input, { ansi: false, linkMode: "osc8-send" });
    // Format: ESC ] 8 ; ; send:<cmd> ESC \ TEXT ESC ] 8 ; ; ESC \
    expect(text).toContain("\x1b]8;;send:go north\x1b\\North\x1b]8;;\x1b\\");
    expect(text).toContain("\x1b]8;;send:examine rusty-sword\x1b\\Examine sword\x1b]8;;\x1b\\");
  });

  it("osc8-send mode emits OSC 8 for external URLs too", () => {
    const httpInput = "- [MUDdown](https://muddown.com)";
    const { text } = renderTerminal(httpInput, { ansi: false, linkMode: "osc8-send" });
    expect(text).toContain("\x1b]8;;https://muddown.com\x1b\\");
  });

  it("osc8 and osc8-send modes strip control bytes from external URLs", () => {
    // A URL containing ESC or BEL would close the OSC 8 envelope early.
    // Both OSC 8 modes must sanitize the URL before interpolating,
    // matching the game-link sanitizer behaviour.
    const hostile = "- [site](https://example.com/\x1bevil\x07more?q=1)";
    for (const mode of ["osc8", "osc8-send"] as const) {
      const { text } = renderTerminal(hostile, { ansi: false, linkMode: mode });
      // Raw control bytes must not appear anywhere in the output
      expect(text.includes("\x1b" + "evil")).toBe(false);
      expect(text.includes("\x07")).toBe(false);
      // Sanitized URL should be interpolated (control bytes stripped,
      // other characters preserved)
      expect(text).toContain("\x1b]8;;https://example.com/evilmore?q=1\x1b\\");
    }
  });

  it("osc8-send mode strips C0/C1 bytes from the send: URI to prevent envelope injection", () => {
    // A hostile link whose target contains ESC would close the outer
    // OSC 8 envelope early. The renderer must strip control bytes from
    // the resolved command before emitting the sequence.
    const hostile = "- [evil](cmd:go\x1bnorth)";
    const { text } = renderTerminal(hostile, { ansi: false, linkMode: "osc8-send" });
    expect(text.includes("\x1bnorth")).toBe(false);
    expect(text).toContain("\x1b]8;;send:gonorth\x1b\\");
  });

  it("osc8-send mode resolves player links to the display name", () => {
    const playerInput = "- [@Kandawen](player:a781b366-54a3-4ee0-a230-d1b5fb32b2c0)";
    const { text } = renderTerminal(playerInput, { ansi: false, linkMode: "osc8-send" });
    expect(text).toContain("\x1b]8;;send:look Kandawen\x1b\\");
    expect(text).not.toContain("a781b366");
  });

  it("osc8-send mode falls back to plain rendering when the sanitized command is empty", () => {
    // C1 bytes (0x80-0x9f) survive resolveGameLink (which strips only C0+DEL)
    // but are stripped by the osc8-send sanitizer. If the entire command is
    // C1 bytes the send: URI would be empty — a silently-clickable no-op.
    // The renderer must detect this and emit the plain fallback instead,
    // and must NOT echo the raw command (which is all control bytes).
    const input = `- [danger](cmd:\x9b\x9c\x9d)`;
    const { text } = renderTerminal(input, { ansi: false, linkMode: "osc8-send" });
    // Must NOT emit a send: URI with an empty command
    expect(text).not.toContain("send:\x1b\\");
    expect(text).not.toMatch(/send:[\s]*\x1b\\/);
    // Must still show the display text
    expect(text).toContain("danger");
    // Must NOT echo the raw C1 bytes into the terminal
    expect(text).not.toContain("\x9b");
    expect(text).not.toContain("\x9c");
    expect(text).not.toContain("\x9d");
    // Should surface the unsafe-command placeholder
    expect(text).toContain("<unsafe>");
  });

  it("osc8-send mode strips C1 bytes (0x9c/0x9d) as well as ESC", () => {
    // ST (0x9c) is the single-byte String Terminator — if it leaked into
    // the envelope a receiving terminal could treat it as a close marker.
    const hostile = "- [evil](cmd:go\x9cnorth\x9deast)";
    const { text } = renderTerminal(hostile, { ansi: false, linkMode: "osc8-send" });
    expect(text.includes("\x9c")).toBe(false);
    expect(text.includes("\x9d")).toBe(false);
    expect(text).toContain("send:gonortheast");
  });

  it("osc8-send mode does not append to the numbered-links table", () => {
    // The links array is used by the bridge to populate numbered shortcuts;
    // osc8-send must not leak entries into it or users could trigger
    // unexpected numbered commands in a mode that isn't numbered.
    const input = `- [North](go:north)\n- [South](go:south)`;
    const { links } = renderTerminal(input, { ansi: false, linkMode: "osc8-send" });
    expect(links).toHaveLength(0);
  });

  // ─── osc8Features: tooltip + menu enrichments ─────────────────────────

  it("osc8-send omits ?config when neither tooltip nor menu is enabled", () => {
    const input = "- [North](go:north)";
    const { text } = renderTerminal(input, { ansi: false, linkMode: "osc8-send" });
    expect(text).toContain("\x1b]8;;send:go north\x1b\\");
    expect(text).not.toContain("?config=");
  });

  it("osc8-send emits a tooltip-only ?config when only tooltip is enabled", () => {
    const input = "- [North](go:north)";
    const { text } = renderTerminal(input, {
      ansi: false,
      linkMode: "osc8-send",
      osc8Features: { tooltip: true },
    });
    // Extract and decode the config
    const m = text.match(/send:go north\?config=([^\x1b]+)/);
    expect(m).not.toBeNull();
    const cfg = JSON.parse(decodeURIComponent(m![1]));
    expect(cfg).toEqual({ tooltip: "Go north" });
  });

  it("osc8-send emits a menu-only ?config when only menu is enabled", () => {
    const input = "- A [rusty key](item:rusty-key) gleams.";
    const { text } = renderTerminal(input, {
      ansi: false,
      linkMode: "osc8-send",
      osc8Features: { menu: true },
    });
    const m = text.match(/send:examine rusty-key\?config=([^\x1b]+)/);
    expect(m).not.toBeNull();
    const cfg = JSON.parse(decodeURIComponent(m![1]));
    expect(cfg.tooltip).toBeUndefined();
    expect(cfg.menu).toEqual([
      { Examine: "send:examine rusty-key" },
      { Get: "send:get rusty-key" },
      { Drop: "send:drop rusty-key" },
    ]);
  });

  it("osc8-send emits both tooltip and menu when both are enabled for NPC links", () => {
    const input = "- The [town crier](npc:crier) waves.";
    const { text } = renderTerminal(input, {
      ansi: false,
      linkMode: "osc8-send",
      osc8Features: { tooltip: true, menu: true },
    });
    const m = text.match(/send:talk crier\?config=([^\x1b]+)/);
    expect(m).not.toBeNull();
    const cfg = JSON.parse(decodeURIComponent(m![1]));
    expect(cfg.tooltip).toBe("Talk to town crier");
    expect(cfg.menu).toEqual([
      { Talk: "send:talk crier" },
      { Examine: "send:examine crier" },
      "-",
      { Attack: "send:attack crier" },
    ]);
  });

  it("osc8-send player menu uses the display name, not the UUID, and includes a tell prompt", () => {
    const input = "[@Kandawen](player:a781b366-54a3-4ee0-a230-d1b5fb32b2c0)";
    const { text } = renderTerminal(input, {
      ansi: false,
      linkMode: "osc8-send",
      osc8Features: { tooltip: true, menu: true },
    });
    const m = text.match(/send:look Kandawen\?config=([^\x1b]+)/);
    expect(m).not.toBeNull();
    const cfg = JSON.parse(decodeURIComponent(m![1]));
    expect(cfg.tooltip).toBe("Look at Kandawen");
    expect(cfg.menu).toEqual([
      { Look: "send:look Kandawen" },
      { Tell: "prompt:tell Kandawen " },
    ]);
    // UUID must never leak into the envelope
    expect(text).not.toContain("a781b366");
  });

  it("osc8-send omits menu for help: and cmd: schemes (no meaningful related actions)", () => {
    const input = "- [combat help](help:combat)\n- [look around](cmd:look)";
    const { text } = renderTerminal(input, {
      ansi: false,
      linkMode: "osc8-send",
      osc8Features: { tooltip: true, menu: true },
    });
    // help: — has tooltip but no menu
    const helpMatch = text.match(/send:help combat\?config=([^\x1b]+)/);
    expect(helpMatch).not.toBeNull();
    const helpCfg = JSON.parse(decodeURIComponent(helpMatch![1]));
    expect(helpCfg.tooltip).toBe("Help: combat");
    expect(helpCfg.menu).toBeUndefined();
    // cmd: — has tooltip but no menu
    const cmdMatch = text.match(/send:look\?config=([^\x1b]+)/);
    expect(cmdMatch).not.toBeNull();
    const cmdCfg = JSON.parse(decodeURIComponent(cmdMatch![1]));
    expect(cmdCfg.tooltip).toBe("look");
    expect(cmdCfg.menu).toBeUndefined();
  });

  it("osc8-send config is percent-encoded (no raw control bytes or quotes in envelope)", () => {
    const input = "- [North](go:north)";
    const { text } = renderTerminal(input, {
      ansi: false,
      linkMode: "osc8-send",
      osc8Features: { tooltip: true },
    });
    // No raw JSON characters should appear between send: and ST
    const m = text.match(/\x1b\]8;;send:go north\?config=([^\x1b]+)\x1b\\/);
    expect(m).not.toBeNull();
    const encoded = m![1];
    // Percent-encoded payload must not contain unescaped JSON structural chars
    expect(encoded).not.toMatch(/[{}"]/);
    // Must decode to valid JSON
    expect(() => JSON.parse(decodeURIComponent(encoded))).not.toThrow();
  });

  it("osc8-send sanitizes control bytes from display text used in tooltips", () => {
    // A hostile display name with C0/C1 bytes must not leak into the
    // tooltip (which is JSON-encoded into the OSC 8 envelope).
    const input = "- The [hostile\x1bname\x9c](npc:crier) looms.";
    const { text } = renderTerminal(input, {
      ansi: false,
      linkMode: "osc8-send",
      osc8Features: { tooltip: true },
    });
    const m = text.match(/\?config=([^\x1b]+)/);
    expect(m).not.toBeNull();
    const cfg = JSON.parse(decodeURIComponent(m![1]));
    expect(cfg.tooltip).toBe("Talk to hostilename");
    expect(cfg.tooltip).not.toContain("\x1b");
    expect(cfg.tooltip).not.toContain("\x9c");
  });

  it("osc8 mode ignores osc8Features (only osc8-send honours tooltip/menu)", () => {
    // osc8 (host-terminal) mode uses a dimmed text hint, not an actual
    // send: URI, so there's nowhere to attach ?config=….
    const input = "- [North](go:north)";
    const { text } = renderTerminal(input, {
      ansi: false,
      linkMode: "osc8",
      osc8Features: { tooltip: true, menu: true },
    });
    expect(text).not.toContain("?config=");
    expect(text).not.toContain("send:");
  });

  it("osc8-send truncates oversized display text in tooltip at 200 chars", () => {
    // Guards the 200-char cap in sanitizeConfigString so a pathological
    // display name can't blow past Mudlet's 4096-byte URL limit.
    const long = "A".repeat(500);
    const input = `- The [${long}](npc:crier) waves.`;
    const { text } = renderTerminal(input, {
      ansi: false,
      linkMode: "osc8-send",
      osc8Features: { tooltip: true },
    });
    const m = text.match(/\?config=([^\x1b]+)/);
    expect(m).not.toBeNull();
    const cfg = JSON.parse(decodeURIComponent(m![1]));
    // Per the "osc8-send truncates oversized display text in tooltip at
    // 200 chars" contract: sanitizeConfigString caps the *entire*
    // tooltip string at 200 characters, so cfg.tooltip.length must be
    // <= 200 regardless of how long the source display name was.
    expect(cfg.tooltip.length).toBeLessThanOrEqual(200);
  });

  it("osc8-send attaches config to links inside headings", () => {
    const input = `# Welcome to [Northkeep](go:north)\n`;
    const { text } = renderTerminal(input, {
      ansi: false,
      linkMode: "osc8-send",
      osc8Features: { tooltip: true },
    });
    expect(text).toContain("?config=");
  });

  it("osc8-send attaches config to links inside blockquotes", () => {
    const input = `> See [the notice](help:notice) for details.\n`;
    const { text } = renderTerminal(input, {
      ansi: false,
      linkMode: "osc8-send",
      osc8Features: { tooltip: true },
    });
    expect(text).toContain("?config=");
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
