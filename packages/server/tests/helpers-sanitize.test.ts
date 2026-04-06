import { describe, it, expect } from "vitest";
import { sanitizeRoomDescription } from "../src/helpers.js";

describe("sanitizeRoomDescription", () => {
  it("collapses newlines to spaces", () => {
    expect(sanitizeRoomDescription("line one\nline two")).toBe("line one line two");
  });

  it("neutralizes ::: sequences with zero-width space", () => {
    const result = sanitizeRoomDescription("some :::close text");
    expect(result).toContain("\u200b:::");
    expect(result).not.toMatch(/(?<!\u200b):::/);
  });

  it("strips leading and trailing whitespace", () => {
    expect(sanitizeRoomDescription("  hello  ")).toBe("hello");
  });

  it("preserves safe text unchanged", () => {
    expect(sanitizeRoomDescription("A bustling square at the heart of Northkeep."))
      .toBe("A bustling square at the heart of Northkeep.");
  });

  it("handles CRLF line endings", () => {
    expect(sanitizeRoomDescription("line one\r\nline two")).toBe("line one line two");
  });

  it("neutralizes multiple ::: sequences throughout the string", () => {
    const result = sanitizeRoomDescription(":::start middle::: end:::");
    expect(result).not.toMatch(/(?<!\u200b):::/);
    expect(result).toContain("\u200b:::");
  });

  it("neutralizes ::: at string start", () => {
    const result = sanitizeRoomDescription(":::atstart");
    expect(result).not.toMatch(/(?<!\u200b):::/);
    expect(result).toContain("\u200b:::");
  });

  it("neutralizes ::: at string end", () => {
    const result = sanitizeRoomDescription("end:::");
    expect(result).not.toMatch(/(?<!\u200b):::/);
    expect(result).toContain("\u200b:::");
  });

  it("neutralizes consecutive ::: patterns (e.g., ::::::)", () => {
    const result = sanitizeRoomDescription("text::::::more");
    // The greedy :{3,} matches all 6 colons as one sequence, prefixing with \u200b
    expect(result).toContain("\u200b");
    expect(result).toBe("text\u200b::::::more");
  });
});
