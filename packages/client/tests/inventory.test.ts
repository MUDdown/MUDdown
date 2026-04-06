import { describe, it, expect } from "vitest";
import { isInvState } from "../src/inventory.js";

describe("isInvState", () => {
  it("accepts a valid inventory state", () => {
    expect(
      isInvState({
        items: [{ id: "key", name: "Rusty Key", equippable: false, usable: true }],
        equipped: { weapon: null, armor: null, accessory: null },
      }),
    ).toBe(true);
  });

  it("accepts an empty inventory", () => {
    expect(isInvState({ items: [], equipped: {} })).toBe(true);
  });

  it("accepts equipped items", () => {
    expect(
      isInvState({
        items: [],
        equipped: { weapon: { id: "sword", name: "Sword" }, armor: null },
      }),
    ).toBe(true);
  });

  it("rejects null and undefined", () => {
    expect(isInvState(null)).toBe(false);
    expect(isInvState(undefined)).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isInvState("string")).toBe(false);
    expect(isInvState(42)).toBe(false);
  });

  it("rejects missing items array", () => {
    expect(isInvState({ equipped: {} })).toBe(false);
  });

  it("rejects missing equipped object", () => {
    expect(isInvState({ items: [] })).toBe(false);
  });

  it("rejects invalid item shape", () => {
    expect(
      isInvState({
        items: [{ id: "key" }], // missing name, equippable, usable
        equipped: {},
      }),
    ).toBe(false);
  });

  it("rejects array as equipped", () => {
    expect(isInvState({ items: [], equipped: [] })).toBe(false);
  });

  it("rejects invalid equipped value", () => {
    expect(
      isInvState({
        items: [],
        equipped: { weapon: "not-an-object" },
      }),
    ).toBe(false);
  });
});
