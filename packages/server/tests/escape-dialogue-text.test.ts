import { describe, it, expect } from "vitest";
import { escapeDialogueText } from "../src/helpers.js";

describe("escapeDialogueText", () => {
  it("replaces embedded double quotes with single quotes", () => {
    expect(escapeDialogueText('He said "stop" loudly')).toBe(
      "He said 'stop' loudly",
    );
  });

  it("handles multiple double quotes", () => {
    expect(escapeDialogueText('"Hello" and "goodbye"')).toBe(
      "'Hello' and 'goodbye'",
    );
  });

  it("returns text unchanged when no double quotes present", () => {
    const input = "Just some plain text.";
    expect(escapeDialogueText(input)).toBe(input);
  });

  it("returns empty string for empty input", () => {
    expect(escapeDialogueText("")).toBe("");
  });

  it("does not alter single quotes", () => {
    const input = "It's a fine day";
    expect(escapeDialogueText(input)).toBe(input);
  });

  it("does not alter backslashes", () => {
    const input = "path\\to\\file";
    expect(escapeDialogueText(input)).toBe(input);
  });
});
