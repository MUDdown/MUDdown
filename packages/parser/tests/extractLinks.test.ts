import { describe, it, expect } from "vitest";
import { extractLinks } from "../src/index.js";

describe("extractLinks", () => {
  it("extracts go: links", () => {
    const result = extractLinks("[The Iron Gate](go:iron-gate)");
    expect(result).toEqual([
      { displayText: "The Iron Gate", scheme: "go", target: "iron-gate" },
    ]);
  });

  it("extracts cmd: links", () => {
    const result = extractLinks("[Look around](cmd:look)");
    expect(result).toEqual([
      { displayText: "Look around", scheme: "cmd", target: "look" },
    ]);
  });

  it("extracts item: links", () => {
    const result = extractLinks("[rusty sword](item:rusty-sword)");
    expect(result).toEqual([
      { displayText: "rusty sword", scheme: "item", target: "rusty-sword" },
    ]);
  });

  it("extracts npc: links", () => {
    const result = extractLinks("[the blacksmith](npc:blacksmith)");
    expect(result).toEqual([
      { displayText: "the blacksmith", scheme: "npc", target: "blacksmith" },
    ]);
  });

  it("extracts player: links", () => {
    const result = extractLinks("[@Aldric](player:aldric-01)");
    expect(result).toEqual([
      { displayText: "@Aldric", scheme: "player", target: "aldric-01" },
    ]);
  });

  it("extracts help: links", () => {
    const result = extractLinks("[commands](help:commands)");
    expect(result).toEqual([
      { displayText: "commands", scheme: "help", target: "commands" },
    ]);
  });

  it("extracts url: links", () => {
    const result = extractLinks("[wiki](url:https://example.com)");
    expect(result).toEqual([
      { displayText: "wiki", scheme: "url", target: "https://example.com" },
    ]);
  });

  it("extracts multiple links from one string", () => {
    const content = "Go [north](go:iron-gate) or visit [the baker](npc:baker).";
    const result = extractLinks(content);
    expect(result).toEqual([
      { displayText: "north", scheme: "go", target: "iron-gate" },
      { displayText: "the baker", scheme: "npc", target: "baker" },
    ]);
  });

  it("ignores links with unknown schemes", () => {
    const result = extractLinks("[broken](fake:thing)");
    expect(result).toEqual([]);
  });

  it("returns empty array for text with no links", () => {
    const result = extractLinks("Just some plain text.");
    expect(result).toEqual([]);
  });

  it("excludes links whose scheme is not in VALID_SCHEMES", () => {
    const result = extractLinks("[example](https://example.com)");
    expect(result).toEqual([]);
  });

  it("ignores empty display text", () => {
    const result = extractLinks("[](go:somewhere)");
    expect(result).toEqual([]);
  });

  it("extracts link with empty target", () => {
    const result = extractLinks("[text](go:)");
    expect(result).toEqual([
      { displayText: "text", scheme: "go", target: "" },
    ]);
  });

  it("extracts adjacent links without separating text", () => {
    const result = extractLinks("[a](go:x)[b](go:y)");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ displayText: "a", scheme: "go", target: "x" });
    expect(result[1]).toEqual({ displayText: "b", scheme: "go", target: "y" });
  });

  it("handles special characters in display text and target", () => {
    const result = extractLinks("[hello world!](go:path/to/place)");
    expect(result).toEqual([
      { displayText: "hello world!", scheme: "go", target: "path/to/place" },
    ]);
  });
});
