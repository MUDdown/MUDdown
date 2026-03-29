import { describe, it, expect } from "vitest";
import { dirAliases } from "../src/helpers.js";

describe("dirAliases", () => {
  it("maps single-letter cardinal directions", () => {
    expect(dirAliases["n"]).toBe("north");
    expect(dirAliases["s"]).toBe("south");
    expect(dirAliases["e"]).toBe("east");
    expect(dirAliases["w"]).toBe("west");
  });

  it("maps single-letter vertical directions", () => {
    expect(dirAliases["u"]).toBe("up");
    expect(dirAliases["d"]).toBe("down");
  });

  it("maps two-letter diagonal directions", () => {
    expect(dirAliases["ne"]).toBe("northeast");
    expect(dirAliases["nw"]).toBe("northwest");
    expect(dirAliases["se"]).toBe("southeast");
    expect(dirAliases["sw"]).toBe("southwest");
  });

  it("has exactly 10 aliases", () => {
    expect(Object.keys(dirAliases)).toHaveLength(10);
  });

  it("returns undefined for unknown aliases", () => {
    expect(dirAliases["north"]).toBeUndefined();
    expect(dirAliases["x"]).toBeUndefined();
  });
});
