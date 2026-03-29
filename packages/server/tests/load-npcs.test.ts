import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadWorld } from "../src/world.js";
import { createFixtureDir, cleanupFixtureDir, writeNpc } from "./fixtures.js";

describe("loadWorld — NPCs", () => {
  let dir: string;

  beforeEach(() => {
    dir = createFixtureDir();
  });

  afterEach(() => {
    cleanupFixtureDir(dir);
  });

  it("loads a NPC with dialogue tree", () => {
    writeNpc(dir, "bartender.json", {
      id: "bartender",
      name: "Bartender",
      description: "A gruff man polishing a mug.",
      location: "tavern",
      dialogue: {
        start: {
          text: "What'll it be?",
          mood: "gruff",
          narrative: "He looks at you expectantly.",
          responses: [
            { text: "An ale, please.", next: "ale" },
            { text: "Nothing.", next: null },
          ],
        },
        ale: {
          text: "Good choice.",
          mood: "pleased",
          responses: [{ text: "Thanks.", next: null }],
        },
      },
    });

    const world = loadWorld(dir);
    expect(world.npcDefs.size).toBe(1);
    const npc = world.npcDefs.get("bartender");
    expect(npc).toBeDefined();
    expect(npc!.name).toBe("Bartender");
    expect(npc!.location).toBe("tavern");
    expect(npc!.dialogue["start"]).toBeDefined();
    expect(npc!.dialogue["start"].text).toBe("What'll it be?");
    expect(npc!.dialogue["start"].mood).toBe("gruff");
    expect(npc!.dialogue["start"].narrative).toBe("He looks at you expectantly.");
    expect(npc!.dialogue["start"].responses).toHaveLength(2);
    expect(npc!.dialogue["ale"]).toBeDefined();
    expect(npc!.dialogue["ale"].responses[0].next).toBeNull();
  });

  it("populates roomNpcs mapping", () => {
    writeNpc(dir, "guard.json", {
      id: "guard",
      name: "Guard",
      description: "A guard.",
      location: "gate",
      dialogue: { start: { text: "Halt!", responses: [] } },
    });
    writeNpc(dir, "baker.json", {
      id: "baker",
      name: "Baker",
      description: "A baker.",
      location: "bakery",
      dialogue: { start: { text: "Hi!", responses: [] } },
    });
    writeNpc(dir, "merchant.json", {
      id: "merchant",
      name: "Merchant",
      description: "A merchant.",
      location: "gate",
      dialogue: { start: { text: "Buy something.", responses: [] } },
    });

    const world = loadWorld(dir);
    expect(world.npcDefs.size).toBe(3);
    const gateNpcs = world.roomNpcs.get("gate");
    expect(gateNpcs).toBeDefined();
    expect(gateNpcs).toHaveLength(2);
    expect(gateNpcs).toContain("guard");
    expect(gateNpcs).toContain("merchant");
    expect(world.roomNpcs.get("bakery")).toEqual(["baker"]);
  });

  it("skips NPCs with missing fields", () => {
    writeNpc(dir, "bad.json", {
      id: "bad",
      name: "Bad NPC",
      // missing description and location
      dialogue: { start: { text: "Hi", responses: [] } },
    });

    const world = loadWorld(dir);
    expect(world.npcDefs.size).toBe(0);
  });

  it("skips NPCs without a start dialogue node", () => {
    writeNpc(dir, "bad.json", {
      id: "bad",
      name: "Bad",
      description: "Bad NPC",
      location: "somewhere",
      dialogue: {
        greeting: { text: "Hi", responses: [] }, // no "start" node
      },
    });

    const world = loadWorld(dir);
    expect(world.npcDefs.size).toBe(0);
  });

  it("handles optional mood and narrative fields", () => {
    writeNpc(dir, "simple.json", {
      id: "simple",
      name: "Simple NPC",
      description: "A simple NPC.",
      location: "room",
      dialogue: {
        start: {
          text: "Hello.",
          responses: [{ text: "Hi.", next: null }],
        },
      },
    });

    const world = loadWorld(dir);
    const npc = world.npcDefs.get("simple");
    expect(npc!.dialogue["start"].mood).toBeUndefined();
    expect(npc!.dialogue["start"].narrative).toBeUndefined();
  });

  it("handles missing npcs directory gracefully", () => {
    rmSync(join(dir, "npcs"), { recursive: true, force: true });

    const world = loadWorld(dir);
    expect(world.npcDefs.size).toBe(0);
  });

  it("filters out invalid dialogue responses", () => {
    writeNpc(dir, "npc.json", {
      id: "npc",
      name: "NPC",
      description: "An NPC.",
      location: "room",
      dialogue: {
        start: {
          text: "Hello.",
          responses: [
            { text: "Valid", next: "node2" },
            { text: 123, next: "bad" }, // text is not a string
            { text: "Also valid", next: null },
          ],
        },
      },
    });

    const world = loadWorld(dir);
    const npc = world.npcDefs.get("npc");
    expect(npc!.dialogue["start"].responses).toHaveLength(2);
  });
});
