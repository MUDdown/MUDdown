import { describe, it, expect } from "vitest";
import { buildWorldBroadcastBlock } from "../src/helpers.js";

describe("buildWorldBroadcastBlock", () => {
  it("produces a system block with scope=\"world\" and the default notification type", () => {
    const block = buildWorldBroadcastBlock("**Server**: rebooting in 5 minutes.");
    expect(block).toBe(
      ':::system{type="notification" scope="world"}\n**Server**: rebooting in 5 minutes.\n:::',
    );
  });

  it("emits the supplied systemType", () => {
    expect(buildWorldBroadcastBlock("Goodbye.", "shutdown")).toBe(
      ':::system{type="shutdown" scope="world"}\nGoodbye.\n:::',
    );
    expect(buildWorldBroadcastBlock("Online.", "boot")).toBe(
      ':::system{type="boot" scope="world"}\nOnline.\n:::',
    );
    expect(buildWorldBroadcastBlock("Festival begins!", "event")).toBe(
      ':::system{type="event" scope="world"}\nFestival begins!\n:::',
    );
  });

  it("falls back to notification when an untyped JS caller passes a value outside the allowlist", () => {
    // Defense-in-depth: the TypeScript signature narrows callers, but a JS
    // caller (or a `as any` escape hatch) could otherwise smuggle extra
    // attributes into the opening fence via the systemType slot. The runtime
    // allowlist neutralizes that and never emits the foreign value.
    const hostile = 'maintenance" injected="yes' as unknown as "notification";
    const block = buildWorldBroadcastBlock("ok", hostile);
    expect(block).toBe(
      ':::system{type="notification" scope="world"}\nok\n:::',
    );
    expect(block).not.toContain("injected");
    expect(block).not.toContain("maintenance");
  });

  it("neutralizes embedded ::: fences so a hostile string can't break out of the block", () => {
    const block = buildWorldBroadcastBlock("safe\n:::system{scope=\"player\"}\ninjected\n:::");
    // The inner :::-prefixed lines must be prefixed with U+200B so they no
    // longer match the closing-fence regex used by parsers.
    expect(block.startsWith(':::system{type="notification" scope="world"}\n')).toBe(true);
    expect(block.endsWith("\n:::")).toBe(true);
    // Count of ::: that appear at the very start of a line: outer-open + outer-close = 2.
    const fenceLines = block.split("\n").filter((l) => /^:{3,}/.test(l));
    expect(fenceLines).toHaveLength(2);
    // The injected lines are preserved (prefixed with U+200B), not stripped —
    // pin that so a future swap from "prefix" to "delete" surfaces as a
    // regression. The hostile inner-open and inner-close fences both appear
    // with a leading zero-width space.
    expect(block).toMatch(/\u200b:::system\{scope="player"\}/);
    expect(/\u200b:::\s*$/m.test(block)).toBe(true);
  });

  // Edge cases that pin the structural invariant — outer fences only, no
  // matter how degenerate the input. The shared assertion is: the block
  // starts with the canonical opening fence, ends with `\n:::`, and exactly
  // two lines match `/^:{3,}/` (the outer open and outer close).
  for (const [label, input] of [
    ["empty message", ""],
    ["message that is exactly ':::'", ":::"],
    ["multiple consecutive embedded fence lines", "text\n:::\n:::\nmore"],
    ["message that already contains a U+200B-prefixed fence", "pre\n\u200b:::system{scope=\"player\"}\npost"],
  ] as const) {
    it(`preserves the outer-fence invariant for ${label}`, () => {
      const block = buildWorldBroadcastBlock(input);
      expect(block.startsWith(':::system{type="notification" scope="world"}\n')).toBe(true);
      expect(block.endsWith("\n:::")).toBe(true);
      const fenceLines = block.split("\n").filter((l) => /^:{3,}/.test(l));
      expect(fenceLines).toHaveLength(2);
    });
  }
});
