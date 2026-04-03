import { describe, it, expect, beforeEach } from "vitest";
import { GameBridge } from "../src/bridge.js";
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
    expect(bridge.inventory).toBeNull();
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
});
