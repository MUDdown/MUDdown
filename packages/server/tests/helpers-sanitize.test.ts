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

  it("breaks scheme-based markdown links", () => {
    const result = sanitizeRoomDescription("A [shiny sword](item:magic-sword) on the ground");
    expect(result).toContain("]\u200b(item:");
    expect(result).not.toMatch(/\]\(item:/);
  });

  it("breaks multiple scheme links in one string", () => {
    const result = sanitizeRoomDescription("[Click](cmd:drop all) and [North](go:north)");
    expect(result).not.toMatch(/\]\(cmd:/);
    expect(result).not.toMatch(/\]\(go:/);
  });

  it("prevents leading heading marker from becoming a section", () => {
    const result = sanitizeRoomDescription("## Fake Section");
    expect(result).toBe("\u200b## Fake Section");
  });

  it("does not alter heading markers that are not at the start", () => {
    const result = sanitizeRoomDescription("text with ## in the middle");
    expect(result).toBe("text with ## in the middle");
  });
});
