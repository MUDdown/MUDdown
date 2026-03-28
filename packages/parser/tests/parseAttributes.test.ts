import { describe, it, expect } from "vitest";
import { parseAttributes } from "../src/index.js";

describe("parseAttributes", () => {
  it("parses string attributes with quoted values", () => {
    const result = parseAttributes('id="town-square" region="northkeep"');
    expect(result).toEqual({ id: "town-square", region: "northkeep" });
  });

  it("parses unquoted string values", () => {
    const result = parseAttributes("id=baker");
    expect(result).toEqual({ id: "baker" });
  });

  it("parses boolean true", () => {
    const result = parseAttributes("visited=true");
    expect(result).toEqual({ visited: true });
  });

  it("parses boolean false", () => {
    const result = parseAttributes("visited=false");
    expect(result).toEqual({ visited: false });
  });

  it("parses integer numbers", () => {
    const result = parseAttributes("hp=100");
    expect(result).toEqual({ hp: 100 });
  });

  it("parses decimal numbers", () => {
    const result = parseAttributes("weight=3.5");
    expect(result).toEqual({ weight: 3.5 });
  });

  it("parses mixed attribute types", () => {
    const result = parseAttributes('id="guard" name="Captain Aldric" hp=50 hostile=false');
    expect(result).toEqual({
      id: "guard",
      name: "Captain Aldric",
      hp: 50,
      hostile: false,
    });
  });

  it("returns empty object for empty string", () => {
    const result = parseAttributes("");
    expect(result).toEqual({});
  });

  it("handles hyphenated keys", () => {
    const result = parseAttributes('max-hp=100');
    expect(result).toEqual({ "max-hp": 100 });
  });

  it("correctly resets regex state across sequential calls", () => {
    const first = parseAttributes('id="alpha" hp=10');
    const second = parseAttributes('id="beta" hp=20');
    expect(first).toEqual({ id: "alpha", hp: 10 });
    expect(second).toEqual({ id: "beta", hp: 20 });
  });

  it("parses unquoted non-numeric values with multiple dots (e.g. 1.2.3)", () => {
    const result = parseAttributes("version=1.2.3");
    expect(result).toEqual({ version: "1.2.3" });
  });

  it("throws on unquoted value containing =", () => {
    expect(() => parseAttributes("id=foo=bar")).toThrow(/Invalid unquoted attribute value/);
  });

  it('throws on unquoted value containing "', () => {
    expect(() => parseAttributes('id=foo"bar')).toThrow(/Invalid unquoted attribute value/);
  });

  it("throws on unquoted value containing {", () => {
    expect(() => parseAttributes("id=foo{bar")).toThrow(/Invalid unquoted attribute value/);
  });

  it("throws on unquoted value containing }", () => {
    expect(() => parseAttributes("id=foo}bar")).toThrow(/Invalid unquoted attribute value/);
  });
});
