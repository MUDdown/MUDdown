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

  it("neutralizes embedded ::: fences so a hostile string can't break out of the block", () => {
    const block = buildWorldBroadcastBlock("safe\n:::system{scope=\"player\"}\ninjected\n:::");
    // The inner :::-prefixed lines must be prefixed with U+200B so they no
    // longer match the closing-fence regex used by parsers.
    expect(block.startsWith(':::system{type="notification" scope="world"}\n')).toBe(true);
    expect(block.endsWith("\n:::")).toBe(true);
    // Count of ::: that appear at the very start of a line: outer-open + outer-close = 2.
    const fenceLines = block.split("\n").filter((l) => /^:{3,}/.test(l));
    expect(fenceLines).toHaveLength(2);
  });
});
