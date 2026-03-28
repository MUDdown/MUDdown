import { describe, it, expect } from "vitest";
import { parse } from "../src/index.js";

describe("parse (full document)", () => {
  it("parses a document with frontmatter and blocks", () => {
    const input = [
      "---",
      "type: room",
      "server: Northkeep",
      "---",
      ':::room{id="town-square"}',
      "## Description",
      "The town square bustles with life.",
      ":::",
    ].join("\n");

    const doc = parse(input);
    expect(doc.frontmatter).toEqual({ type: "room", server: "Northkeep" });
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].type).toBe("room");
    expect(doc.raw).toBe(input);
  });

  it("parses a document without frontmatter", () => {
    const input = [
      ':::system',
      "Welcome to MUDdown!",
      ":::",
    ].join("\n");

    const doc = parse(input);
    expect(doc.frontmatter).toEqual({});
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].type).toBe("system");
  });

  it("parses frontmatter with colon in value", () => {
    const input = [
      "---",
      "timestamp: 2026-03-28T12:00:00Z",
      "---",
      ":::system",
      "Hello.",
      ":::",
    ].join("\n");

    const doc = parse(input);
    expect(doc.frontmatter.timestamp).toBe("2026-03-28T12:00:00Z");
  });

  it("preserves raw input", () => {
    const input = ":::system\nTest.\n:::";
    const doc = parse(input);
    expect(doc.raw).toBe(input);
  });

  it("handles document with multiple blocks", () => {
    const input = [
      "---",
      "type: narrative",
      "---",
      ':::room{id="a"}',
      "Room A.",
      ":::",
      ':::npc{id="bob" name="Bob"}',
      "A friendly face.",
      ":::",
    ].join("\n");

    const doc = parse(input);
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0].type).toBe("room");
    expect(doc.blocks[1].type).toBe("npc");
    expect(doc.blocks[1].attributes.name).toBe("Bob");
  });

  it("returns empty blocks for document with only frontmatter", () => {
    const input = "---\ntype: system\n---\n";
    const doc = parse(input);
    expect(doc.frontmatter).toEqual({ type: "system" });
    expect(doc.blocks).toEqual([]);
  });

  // TODO: revisit to accept EOF-delimited frontmatter (no trailing newline)
  it("requires trailing newline after closing frontmatter delimiter", () => {
    const input = "---\ntype: room\n---";
    const doc = parse(input);
    // Without a trailing \n after ---, the parser cannot find \n---\n,
    // so frontmatter is silently dropped and --- lines pass through as body.
    expect(doc.frontmatter).toEqual({});
    expect(doc.raw).toBe(input);
  });
});
