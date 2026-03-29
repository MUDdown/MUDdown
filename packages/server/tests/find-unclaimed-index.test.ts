import { describe, it, expect } from "vitest";
import { findUnclaimedIndex } from "../src/helpers.js";

describe("findUnclaimedIndex", () => {
  it("finds first occurrence of target", () => {
    expect(findUnclaimedIndex(["a", "b", "c"], "b", new Set())).toBe(1);
  });

  it("returns -1 when target not in array", () => {
    expect(findUnclaimedIndex(["a", "b", "c"], "d", new Set())).toBe(-1);
  });

  it("skips claimed indices", () => {
    const arr = ["a", "b", "a", "c"];
    const claimed = new Set([0]); // first "a" is claimed
    expect(findUnclaimedIndex(arr, "a", claimed)).toBe(2); // should return second "a"
  });

  it("returns -1 when all occurrences are claimed", () => {
    const arr = ["a", "b", "a"];
    const claimed = new Set([0, 2]);
    expect(findUnclaimedIndex(arr, "a", claimed)).toBe(-1);
  });

  it("handles empty array", () => {
    expect(findUnclaimedIndex([], "a", new Set())).toBe(-1);
  });

  it("handles duplicate items correctly for combine recipe", () => {
    // Simulate combining two of the same item (e.g., "stick" + "stick")
    const arr = ["stick", "rope", "stick"];
    const claimed = new Set<number>();

    const first = findUnclaimedIndex(arr, "stick", claimed);
    expect(first).toBe(0);
    claimed.add(first);

    const second = findUnclaimedIndex(arr, "stick", claimed);
    expect(second).toBe(2);
    claimed.add(second);

    const third = findUnclaimedIndex(arr, "stick", claimed);
    expect(third).toBe(-1);
  });

  it("works with consecutive duplicates", () => {
    const arr = ["a", "a", "a"];
    const claimed = new Set([0, 1]);
    expect(findUnclaimedIndex(arr, "a", claimed)).toBe(2);
  });
});
