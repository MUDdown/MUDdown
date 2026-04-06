import { describe, it, expect } from "vitest";
import { parseHintBlock } from "../src/hints.js";

describe("parseHintBlock", () => {
  it("returns null for non-hint content", () => {
    expect(parseHintBlock("# Room Title\nSome text")).toBeNull();
  });

  it("returns null for empty hint body", () => {
    expect(parseHintBlock(':::system{type="hint"}\n:::')).toBeNull();
  });

  it("parses a basic hint without commands", () => {
    const md = ':::system{type="hint"}\nTry exploring the forest.\n:::';
    const result = parseHintBlock(md);
    expect(result).not.toBeNull();
    expect(result!.hint).toBe("Try exploring the forest.");
    expect(result!.commands).toEqual([]);
  });

  it("parses a hint with commands", () => {
    const md = [
      ':::system{type="hint"}',
      "You see a locked door.",
      "**Try:**",
      "- `use key`",
      "- `examine door`",
      ":::",
    ].join("\n");
    const result = parseHintBlock(md);
    expect(result).not.toBeNull();
    expect(result!.hint).toBe("You see a locked door.");
    expect(result!.commands).toEqual(["use key", "examine door"]);
  });

  it("handles single-quoted type attribute", () => {
    const md = ":::system{type='hint'}\nA hint.\n:::";
    const result = parseHintBlock(md);
    expect(result).not.toBeNull();
    expect(result!.hint).toBe("A hint.");
    expect(result!.commands).toEqual([]);
  });

  it("does not match type=hint outside the opening fence", () => {
    const md = ':::system{type="info"}\nThe type="hint" inscription glows.\n:::';
    expect(parseHintBlock(md)).toBeNull();
  });
});
