import { describe, it, expect } from "vitest";
import { parseBlocks } from "../src/index.js";

describe("parseBlocks", () => {
  it("parses a single block with attributes", () => {
    const input = [
      ':::room{id="town-square" region="northkeep"}',
      "## Description",
      "The heart of Northkeep.",
      ":::",
    ].join("\n");

    const blocks = parseBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("room");
    expect(blocks[0].attributes).toEqual({ id: "town-square", region: "northkeep" });
    expect(blocks[0].content).toContain("The heart of Northkeep.");
  });

  it("parses a block without attributes", () => {
    const input = [":::system", "Server restarting in 5 minutes.", ":::"].join("\n");

    const blocks = parseBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("system");
    expect(blocks[0].attributes).toEqual({});
    expect(blocks[0].content).toBe("Server restarting in 5 minutes.");
  });

  it("parses multiple blocks", () => {
    const input = [
      ':::room{id="docks"}',
      "## Description",
      "Salty air and creaking wood.",
      ":::",
      "",
      ':::npc{id="fisher" name="Old Tom"}',
      "## Description",
      "A weathered fisherman.",
      ":::",
    ].join("\n");

    const blocks = parseBlocks(input);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("room");
    expect(blocks[1].type).toBe("npc");
    expect(blocks[1].attributes).toEqual({ id: "fisher", name: "Old Tom" });
  });

  it("extracts sections from block content", () => {
    const input = [
      ':::room{id="gate"}',
      "## Description",
      "An iron gate.",
      "## Exits",
      "[South](go:town-square)",
      ":::",
    ].join("\n");

    const blocks = parseBlocks(input);
    expect(blocks[0].sections).toEqual({
      Description: "An iron gate.",
      Exits: "[South](go:town-square)",
    });
  });

  it("extracts links from block content", () => {
    const input = [
      ':::room{id="square"}',
      "## Exits",
      "[North](go:iron-gate)",
      "[East](go:bakery)",
      ":::",
    ].join("\n");

    const blocks = parseBlocks(input);
    expect(blocks[0].links).toHaveLength(2);
    expect(blocks[0].links[0]).toEqual({
      displayText: "North",
      scheme: "go",
      target: "iron-gate",
    });
    expect(blocks[0].links[1]).toEqual({
      displayText: "East",
      scheme: "go",
      target: "bakery",
    });
  });

  it("ignores text outside of blocks", () => {
    const input = [
      "Some preamble.",
      ':::item{id="sword" name="Rusty Sword"}',
      "A battered old blade.",
      ":::",
      "Some trailing text.",
    ].join("\n");

    const blocks = parseBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("item");
  });

  it("handles empty block content", () => {
    const input = [':::combat{round=1}', ":::"].join("\n");
    const blocks = parseBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("");
    expect(blocks[0].attributes).toEqual({ round: 1 });
  });

  it("handles x- extension block types", () => {
    const input = [":::x-quest", "Find the lost ring.", ":::"].join("\n");
    const blocks = parseBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("x-quest");
  });

  it("throws when a block is never closed", () => {
    const input = [":::room", "No closing fence here."].join("\n");
    expect(() => parseBlocks(input)).toThrow(/Unclosed :::room block opened at line 1/);
  });
});
