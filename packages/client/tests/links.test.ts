import { describe, it, expect } from "vitest";
import { resolveGameLink } from "../src/links.js";

describe("resolveGameLink", () => {
  it("resolves go: scheme", () => {
    expect(resolveGameLink("go", "north")).toBe("go north");
  });

  it("resolves cmd: scheme", () => {
    expect(resolveGameLink("cmd", "look")).toBe("look");
  });

  it("resolves npc: scheme", () => {
    expect(resolveGameLink("npc", "crier")).toBe("talk crier");
  });

  it("resolves item: scheme", () => {
    expect(resolveGameLink("item", "key")).toBe("examine key");
  });

  it("resolves help: scheme", () => {
    expect(resolveGameLink("help", "combat")).toBe("help combat");
  });

  it("resolves player: scheme", () => {
    expect(resolveGameLink("player", "someone")).toBe("look someone");
  });

  it("returns null for unknown scheme", () => {
    expect(resolveGameLink("unknown", "target")).toBeNull();
  });

  it("strips control characters from target", () => {
    expect(resolveGameLink("go", "north\nsecret")).toBe("go northsecret");
  });

  it("returns null for empty target after stripping", () => {
    expect(resolveGameLink("go", "\n\r\t")).toBeNull();
  });

  it("trims whitespace from target", () => {
    expect(resolveGameLink("item", "  key  ")).toBe("examine key");
  });

  it("returns null for empty target", () => {
    expect(resolveGameLink("go", "")).toBeNull();
  });

  it("returns null for whitespace-only target", () => {
    expect(resolveGameLink("go", "   ")).toBeNull();
  });

  it("schemes are case-sensitive", () => {
    expect(resolveGameLink("GO", "north")).toBeNull();
    expect(resolveGameLink("Cmd", "look")).toBeNull();
  });

  it("preserves hyphens and spaces in targets", () => {
    expect(resolveGameLink("npc", "town-crier")).toBe("talk town-crier");
    expect(resolveGameLink("item", "old key")).toBe("examine old key");
  });
});
