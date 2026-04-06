import { describe, it, expect, beforeEach } from "vitest";
import {
  GameBridge,
  parseNpcsFromRoom,
  parseItemsFromRoom,
  parseExitsFromRoom,
} from "../src/bridge.js";
import type { ServerMessage } from "@muddown/shared";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal ServerMessage for testing. */
function makeMsg(overrides: Partial<ServerMessage> & { type: ServerMessage["type"]; muddown: string }): ServerMessage {
  return {
    v: 1,
    id: "test-id",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Access the private handleServerMessage method for unit testing the state
 * machine without needing a real WebSocket connection.
 */
function feedMessage(bridge: GameBridge, msg: ServerMessage): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (bridge as any).handleServerMessage(msg);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GameBridge state tracking", () => {
  let bridge: GameBridge;

  beforeEach(() => {
    bridge = new GameBridge("ws://localhost:9999");
  });

  // ── Room state ───────────────────────────────────────────────────────────

  it("caches room MUDdown on room message", () => {
    const muddown = `:::room{id="town-square" region="northkeep" lighting="bright"}
# Town Square

A bustling town square.

## Exits
- [North](go:north) — The market
:::`;

    feedMessage(bridge, makeMsg({
      type: "room",
      muddown,
      meta: { room_id: "town-square", region: "northkeep" },
    }));

    expect(bridge.currentRoom).toBe(muddown);
  });

  it("updates world map from room messages", () => {
    feedMessage(bridge, makeMsg({
      type: "room",
      muddown: `:::room{id="plaza"}
# Plaza

## Exits
- [North](go:north) — Gate
- [East](go:east) — Market
:::`,
      meta: { room_id: "plaza", region: "northkeep" },
    }));

    expect(bridge.worldMap).toHaveLength(1);
    expect(bridge.worldMap[0]).toEqual({
      id: "plaza",
      title: "Plaza",
      region: "northkeep",
      exits: { north: "north", east: "east" },
    });
  });

  it("updates existing map entry on revisit", () => {
    feedMessage(bridge, makeMsg({
      type: "room",
      muddown: `:::room{id="gate"}\n# The Gate\n\n## Exits\n- [South](go:south)\n:::`,
      meta: { room_id: "gate", region: "northkeep" },
    }));

    feedMessage(bridge, makeMsg({
      type: "room",
      muddown: `:::room{id="gate"}\n# The Iron Gate\n\n## Exits\n- [South](go:south)\n- [North](go:north)\n:::`,
      meta: { room_id: "gate", region: "northkeep" },
    }));

    expect(bridge.worldMap).toHaveLength(1);
    expect(bridge.worldMap[0].title).toBe("The Iron Gate");
    expect(bridge.worldMap[0].exits).toEqual({ south: "south", north: "north" });
  });

  it("ignores room messages without room_id meta", () => {
    feedMessage(bridge, makeMsg({
      type: "room",
      muddown: "# No Meta Room\n",
    }));

    expect(bridge.currentRoom).toBe("# No Meta Room\n");
    expect(bridge.worldMap).toHaveLength(0);
  });

  // ── System messages ──────────────────────────────────────────────────────

  it("caches inventory from system inventory message", () => {
    const inv = `:::system{type="inventory"}
# Inventory

- [Rusty Key](item:rusty-key)

## Equipment

- **weapon**: *empty*
- **armor**: *empty*
- **accessory**: *empty*
:::`;

    feedMessage(bridge, makeMsg({ type: "system", muddown: inv }));
    expect(bridge.inventory).toBe(inv);
  });

  it("caches help text from system help message", () => {
    const help = `:::system{type="help"}
# Commands

| Command | Description |
|---------|-------------|
| \`look\` | Look around |
:::`;

    feedMessage(bridge, makeMsg({ type: "system", muddown: help }));
    expect(bridge.helpText).toBe(help);
  });

  it("extracts player name from welcome message", () => {
    feedMessage(bridge, makeMsg({
      type: "system",
      muddown: `:::system{type="welcome"}
**Welcome to Northkeep**, Adventurer-4321!

Type commands or click links to explore. Try: \`look\`, \`go north\`, \`help\`
:::`,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((bridge as any).playerName).toBe("Adventurer-4321");
  });

  it("does not crash on non-matching system messages", () => {
    feedMessage(bridge, makeMsg({
      type: "system",
      muddown: `:::system{type="who"}\n# Who's Online\n:::`,
    }));

    expect(bridge.inventory).toBeNull();
    expect(bridge.helpText).toBeNull();
  });

  // ── Other message types ──────────────────────────────────────────────────

  it("does not update room cache for non-room messages", () => {
    feedMessage(bridge, makeMsg({ type: "narrative", muddown: "The wind howls." }));
    expect(bridge.currentRoom).toBeNull();
  });

  // ── Initial state ────────────────────────────────────────────────────────

  it("starts with null state", () => {
    expect(bridge.currentRoom).toBeNull();
    expect(bridge.currentRoomId).toBeNull();
    expect(bridge.currentRegion).toBeNull();
    expect(bridge.inventory).toBeNull();
    expect(bridge.inventoryState).toBeNull();
    expect(bridge.helpText).toBeNull();
    expect(bridge.worldMap).toEqual([]);
    expect(bridge.playerStats).toEqual({ hp: 20, maxHp: 20, xp: 0, class: null });
  });

  // ── Multiple rooms build world map ─────────────────────────────────────

  it("builds world map from multiple room visits", () => {
    feedMessage(bridge, makeMsg({
      type: "room",
      muddown: `:::room{id="a"}\n# Room A\n\n## Exits\n- [North](go:north)\n:::`,
      meta: { room_id: "a", region: "r1" },
    }));

    feedMessage(bridge, makeMsg({
      type: "room",
      muddown: `:::room{id="b"}\n# Room B\n\n## Exits\n- [South](go:south)\n:::`,
      meta: { room_id: "b", region: "r1" },
    }));

    feedMessage(bridge, makeMsg({
      type: "room",
      muddown: `:::room{id="c"}\n# Room C\n\n## Exits\n- [West](go:west)\n- [East](go:east)\n:::`,
      meta: { room_id: "c", region: "r2" },
    }));

    expect(bridge.worldMap).toHaveLength(3);
    expect(bridge.worldMap.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  // ── Room ID / Region tracking ────────────────────────────────────────────

  it("tracks currentRoomId and currentRegion from room meta", () => {
    feedMessage(bridge, makeMsg({
      type: "room",
      muddown: `:::room{id="town-square"}\n# Town Square\n:::`,
      meta: { room_id: "town-square", region: "northkeep" },
    }));

    expect(bridge.currentRoomId).toBe("town-square");
    expect(bridge.currentRegion).toBe("northkeep");
  });

  it("preserves roomId/region when meta is missing", () => {
    feedMessage(bridge, makeMsg({
      type: "room",
      muddown: `:::room{id="a"}\n# A\n:::`,
      meta: { room_id: "a", region: "r1" },
    }));

    feedMessage(bridge, makeMsg({
      type: "room",
      muddown: `# No Meta\n`,
    }));

    expect(bridge.currentRoomId).toBe("a");
    expect(bridge.currentRegion).toBe("r1");
  });

  // ── Inventory state from meta ────────────────────────────────────────────

  it("caches inventoryState from system message meta", () => {
    feedMessage(bridge, makeMsg({
      type: "system",
      muddown: "",
      meta: {
        inventoryState: {
          items: [{ id: "bread", name: "Bread", equippable: false, usable: true }],
          equipped: { weapon: null, armor: null, accessory: null },
        },
      },
    }));

    expect(bridge.inventoryState).not.toBeNull();
    expect(bridge.inventoryState!.items).toHaveLength(1);
    expect(bridge.inventoryState!.items![0].name).toBe("Bread");
  });

  it("does not set inventoryState when meta has no inventoryState", () => {
    feedMessage(bridge, makeMsg({
      type: "system",
      muddown: `:::system{type="who"}\n# Who's Online\n:::`,
    }));

    expect(bridge.inventoryState).toBeNull();
  });

  it("ignores inventoryState when items field is not an array", () => {
    feedMessage(bridge, makeMsg({
      type: "system",
      muddown: "",
      meta: {
        inventoryState: { items: "not-an-array" },
      },
    }));
    expect(bridge.inventoryState).toBeNull();
  });

  it("ignores inventoryState when equipped field is null", () => {
    feedMessage(bridge, makeMsg({
      type: "system",
      muddown: "",
      meta: {
        inventoryState: { equipped: null },
      },
    }));
    expect(bridge.inventoryState).toBeNull();
  });
});

// ─── Parsing helpers ─────────────────────────────────────────────────────────

describe("parseNpcsFromRoom", () => {
  it("extracts NPC references from room MUDdown", () => {
    const muddown = `## Present
- A [town crier](npc:crier) stands near the fountain.
- A [guard captain](npc:guard-captain) patrols the square.`;

    const npcs = parseNpcsFromRoom(muddown);
    expect(npcs).toEqual([
      { name: "town crier", id: "crier" },
      { name: "guard captain", id: "guard-captain" },
    ]);
  });

  it("returns empty array when no NPCs present", () => {
    expect(parseNpcsFromRoom("# Empty Room\n\nNothing here.")).toEqual([]);
  });
});

describe("parseItemsFromRoom", () => {
  it("extracts item references from room MUDdown", () => {
    const muddown = `## Items
- A [rusty key](item:rusty-key) lies in the dust.
- A [broken lantern](item:broken-lantern) is on the ground.`;

    const items = parseItemsFromRoom(muddown);
    expect(items).toEqual([
      { name: "rusty key", id: "rusty-key" },
      { name: "broken lantern", id: "broken-lantern" },
    ]);
  });

  it("returns empty array when no items present", () => {
    expect(parseItemsFromRoom("# Empty Room")).toEqual([]);
  });
});

describe("parseExitsFromRoom", () => {
  it("extracts exit directions from room MUDdown", () => {
    const muddown = `## Exits
- [North](go:north) — The market
- [South](go:south) — Town square
- [East](go:east) — The docks`;

    const exits = parseExitsFromRoom(muddown);
    expect(exits).toEqual(["north", "south", "east"]);
  });

  it("returns empty array when no exits present", () => {
    expect(parseExitsFromRoom("# Dead End\n\nNo way out.")).toEqual([]);
  });

  it("matches multi-word exit labels", () => {
    expect(parseExitsFromRoom("- [Go North](go:north) — The gate")).toEqual(["north"]);
  });
});
