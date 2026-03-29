import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadWorld } from "../src/world.js";
import { createFixtureDir, cleanupFixtureDir, writeRoom } from "./fixtures.js";

describe("loadWorld — rooms", () => {
  let dir: string;

  beforeEach(() => {
    dir = createFixtureDir();
  });

  afterEach(() => {
    cleanupFixtureDir(dir);
  });

  it("loads a room with full frontmatter", () => {
    writeRoom(dir, "test-region", "tavern.md", `---
id: tavern
region: test-region
lighting: bright
connections:
  north: market
  south: docks
items:
  - bread
  - candle
---
:::room{id="tavern" region="test-region" lighting="bright"}
# The Rusty Tavern

A warm, inviting place.

## Exits
- [North](go:north) — To the market
- [South](go:south) — To the docks
:::`);

    const world = loadWorld(dir);

    expect(world.rooms.size).toBe(1);
    const room = world.rooms.get("tavern");
    expect(room).toBeDefined();
    expect(room!.attributes.id).toBe("tavern");
    expect(room!.attributes.region).toBe("test-region");
    expect(room!.attributes.lighting).toBe("bright");
    expect(room!.muddown).toContain("# The Rusty Tavern");
  });

  it("loads connections from frontmatter", () => {
    writeRoom(dir, "region", "room-a.md", `---
id: room-a
region: region
connections:
  north: room-b
---
Body text`);

    writeRoom(dir, "region", "room-b.md", `---
id: room-b
region: region
connections:
  south: room-a
---
Body text`);

    const world = loadWorld(dir);

    expect(world.rooms.size).toBe(2);
    expect(world.connections.get("room-a")).toEqual({ north: "room-b" });
    expect(world.connections.get("room-b")).toEqual({ south: "room-a" });
  });

  it("loads room items from frontmatter", () => {
    writeRoom(dir, "region", "room.md", `---
id: room
region: region
items:
  - sword
  - shield
---
Body`);

    const world = loadWorld(dir);
    expect(world.roomItems.get("room")).toEqual(["sword", "shield"]);
  });

  it("skips rooms missing YAML frontmatter id", () => {
    writeRoom(dir, "region", "bad.md", `---
region: test
---
Body`);

    const world = loadWorld(dir);
    expect(world.rooms.size).toBe(0);
  });

  it("skips non-.md files", () => {
    writeRoom(dir, "region", "readme.txt", "Not a room");

    const world = loadWorld(dir);
    expect(world.rooms.size).toBe(0);
  });

  it("loads rooms from nested region subdirectories", () => {
    writeRoom(dir, "outer/inner", "deep.md", `---
id: deep-room
region: inner
---
Deep room body`);

    const world = loadWorld(dir);
    expect(world.rooms.has("deep-room")).toBe(true);
    expect(world.rooms.get("deep-room")!.attributes.region).toBe("inner");
  });
});
