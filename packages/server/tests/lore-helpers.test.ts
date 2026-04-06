import { describe, it, expect } from "vitest";
import { buildLoreBlock } from "../src/helpers.js";

describe("buildLoreBlock", () => {
  it('wraps content in :::system{type="lore"} block', () => {
    const block = buildLoreBlock("The blacksmith is at the Forge.", []);
    expect(block).toMatch(/^:::system\{type="lore"\}/);
    expect(block.trimEnd()).toMatch(/:::$/);
  });

  it("includes Sources line when sources are provided", () => {
    const block = buildLoreBlock("Some answer.", ["Forge", "Blacksmith"]);
    expect(block).toContain("*Sources: Forge, Blacksmith*");
  });

  it("omits Sources line when sources array is empty", () => {
    const block = buildLoreBlock("Some answer.", []);
    expect(block).not.toContain("Sources:");
  });

  it("neutralizes ::: in answer text to prevent block breakout", () => {
    const block = buildLoreBlock(":::close me\nSafe text", []);
    expect(block).toContain("\u200b:::");
    expect(block).toContain("Safe text");
  });

  it("neutralizes ::: in source titles", () => {
    const block = buildLoreBlock("Answer.", [":::evil title"]);
    expect(block).toContain("\u200b:::");
  });

  it("handles empty answer string", () => {
    const block = buildLoreBlock("", []);
    expect(block).toMatch(/^:::system\{type="lore"\}/);
    expect(block.trimEnd()).toMatch(/:::$/);
  });
});
