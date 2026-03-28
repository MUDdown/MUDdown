import { describe, it, expect } from "vitest";
import { parseSections } from "../src/index.js";

describe("parseSections", () => {
  it("parses a single H2 section", () => {
    const content = "## Description\nA quiet town square.";
    const result = parseSections(content);
    expect(result).toEqual({ Description: "A quiet town square." });
  });

  it("parses multiple H2 sections", () => {
    const content = [
      "## Description",
      "A dusty road.",
      "",
      "## Exits",
      "[North](go:iron-gate)",
      "[South](go:docks)",
    ].join("\n");
    const result = parseSections(content);
    expect(result).toEqual({
      Description: "A dusty road.",
      Exits: "[North](go:iron-gate)\n[South](go:docks)",
    });
  });

  it("returns empty object when no H2 headings", () => {
    const result = parseSections("Just some text without headings.");
    expect(result).toEqual({});
  });

  it("ignores content before the first H2", () => {
    const content = "Preamble text\n## Section One\nContent here.";
    const result = parseSections(content);
    expect(result).toEqual({ "Section One": "Content here." });
  });

  it("trims whitespace from section content", () => {
    const content = "## Title\n\n  Some padded content.\n\n";
    const result = parseSections(content);
    expect(result).toEqual({ Title: "Some padded content." });
  });

  it("handles H2 with special characters in heading", () => {
    const content = "## NPCs & Items\nA list of things.";
    const result = parseSections(content);
    expect(result).toEqual({ "NPCs & Items": "A list of things." });
  });

  it("overwrites earlier section when duplicate H2 headings appear", () => {
    const content = "## Description\nFirst.\n## Description\nSecond.";
    const result = parseSections(content);
    expect(result).toEqual({ Description: "Second." });
  });

  it("produces empty string for a section immediately followed by another H2", () => {
    const content = "## Title\n## Next\nSome content.";
    const result = parseSections(content);
    expect(result).toEqual({ Title: "", Next: "Some content." });
  });

  it("produces empty string for an H2 at end of input", () => {
    const content = "## Intro\nHello.\n## EOF";
    const result = parseSections(content);
    expect(result).toEqual({ Intro: "Hello.", EOF: "" });
  });

  it("ignores H1 and H3 headings, only parses H2", () => {
    const content = "# Top Level\n## Real Section\nContent.\n### Subsection\nMore.";
    const result = parseSections(content);
    expect(result).toEqual({ "Real Section": "Content.\n### Subsection\nMore." });
  });
});
