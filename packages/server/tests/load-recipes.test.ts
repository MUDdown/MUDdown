import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadWorld } from "../src/world.js";
import { createFixtureDir, cleanupFixtureDir, writeRecipes } from "./fixtures.js";

describe("loadWorld — recipes", () => {
  let dir: string;

  beforeEach(() => {
    dir = createFixtureDir();
  });

  afterEach(() => {
    cleanupFixtureDir(dir);
  });

  it("loads recipes from recipes.json", () => {
    writeRecipes(dir, [
      { item1: "a", item2: "b", result: "c", description: "Combined!" },
    ]);

    const world = loadWorld(dir);
    expect(world.recipes).toHaveLength(1);
    expect(world.recipes[0]).toEqual({
      item1: "a", item2: "b", result: "c", description: "Combined!",
    });
  });

  it("loads multiple recipes", () => {
    writeRecipes(dir, [
      { item1: "a", item2: "b", result: "c", description: "First" },
      { item1: "d", item2: "e", result: "f", description: "Second" },
    ]);

    const world = loadWorld(dir);
    expect(world.recipes).toHaveLength(2);
  });

  it("skips invalid recipes (missing fields)", () => {
    writeRecipes(dir, [
      { item1: "a", item2: "b" }, // missing result and description
      { item1: "a", item2: "b", result: "c", description: "Valid" },
    ]);

    const world = loadWorld(dir);
    expect(world.recipes).toHaveLength(1);
    expect(world.recipes[0].result).toBe("c");
    expect(world.recipes[0].description).toBe("Valid");
  });

  it("handles missing recipes.json gracefully", () => {
    // Don't write recipes.json
    const world = loadWorld(dir);
    expect(world.recipes).toHaveLength(0);
  });
});
