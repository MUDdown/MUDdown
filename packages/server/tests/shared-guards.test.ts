import { describe, it, expect } from "vitest";
import { isOAuthProvider, isCharacterClass } from "@muddown/shared";

// ─── isOAuthProvider ─────────────────────────────────────────────────────────

describe("isOAuthProvider", () => {
  it("accepts 'discord'", () => {
    expect(isOAuthProvider("discord")).toBe(true);
  });

  it("accepts 'github'", () => {
    expect(isOAuthProvider("github")).toBe(true);
  });

  it("accepts 'microsoft'", () => {
    expect(isOAuthProvider("microsoft")).toBe(true);
  });

  it("accepts 'google'", () => {
    expect(isOAuthProvider("google")).toBe(true);
  });

  it("rejects unknown provider strings", () => {
    expect(isOAuthProvider("facebook")).toBe(false);
    expect(isOAuthProvider("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isOAuthProvider(42)).toBe(false);
    expect(isOAuthProvider(null)).toBe(false);
    expect(isOAuthProvider(undefined)).toBe(false);
    expect(isOAuthProvider({})).toBe(false);
  });
});

// ─── isCharacterClass ────────────────────────────────────────────────────────

describe("isCharacterClass", () => {
  it("accepts 'warrior'", () => {
    expect(isCharacterClass("warrior")).toBe(true);
  });

  it("accepts 'mage'", () => {
    expect(isCharacterClass("mage")).toBe(true);
  });

  it("accepts 'rogue'", () => {
    expect(isCharacterClass("rogue")).toBe(true);
  });

  it("accepts 'cleric'", () => {
    expect(isCharacterClass("cleric")).toBe(true);
  });

  it("rejects unknown class strings", () => {
    expect(isCharacterClass("bard")).toBe(false);
    expect(isCharacterClass("paladin")).toBe(false);
    expect(isCharacterClass("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isCharacterClass(0)).toBe(false);
    expect(isCharacterClass(null)).toBe(false);
    expect(isCharacterClass(undefined)).toBe(false);
    expect(isCharacterClass(true)).toBe(false);
  });
});
