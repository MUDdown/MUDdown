#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { GameBridge, parseNpcsFromRoom, parseItemsFromRoom, parseExitsFromRoom } from "./bridge.js";

const GAME_SERVER_URL = process.env.MUDDOWN_SERVER_URL ?? "ws://localhost:3300";

const server = new McpServer(
  {
    name: "muddown-mcp",
    version: "0.1.0",
  },
  {
    instructions:
      "MUDdown game server MCP interface. Use the specific action tools " +
      "(look, go, examine, get, drop, inventory, equip, unequip, use, talk, " +
      "attack, say, combine, lore) to play the game. Use available_actions to see " +
      "what you can do right now. Use read_resource to inspect current room, " +
      "inventory, stats, and the world map. Use game_command as a fallback " +
      "for commands without a dedicated tool. Always read the current room " +
      "or call available_actions before deciding on a command.",
  },
);

const bridge = new GameBridge(GAME_SERVER_URL);

// ─── Resources ───────────────────────────────────────────────────────────────

server.registerResource(
  "current-room",
  "muddown://room/current",
  {
    title: "Current Room",
    description: "The player's current room rendered as MUDdown markup",
    mimeType: "text/markdown",
  },
  async (uri) => {
    const room = bridge.currentRoom;
    if (!room) {
      return { contents: [{ uri: uri.href, text: "*No room data yet — send a `look` command first.*" }] };
    }
    return { contents: [{ uri: uri.href, text: room }] };
  },
);

server.registerResource(
  "player-inventory",
  "muddown://player/inventory",
  {
    title: "Player Inventory",
    description: "The player's current inventory and equipment",
    mimeType: "text/markdown",
  },
  async (uri) => {
    const inv = bridge.inventory;
    if (!inv) {
      return { contents: [{ uri: uri.href, text: "*No inventory data yet — send an `inventory` command first.*" }] };
    }
    return { contents: [{ uri: uri.href, text: inv }] };
  },
);

server.registerResource(
  "player-stats",
  "muddown://player/stats",
  {
    title: "Player Stats",
    description: "Player statistics: HP, class, XP, equipment. Always returns initial defaults until stats parsing is implemented.",
    mimeType: "application/json",
  },
  async (uri) => {
    const stats = bridge.playerStats;
    return { contents: [{ uri: uri.href, text: JSON.stringify(stats, null, 2) }] };
  },
);

server.registerResource(
  "world-map",
  "muddown://world/map",
  {
    title: "World Map",
    description: "Known rooms with available exit directions (discovered via exploration)",
    mimeType: "application/json",
  },
  async (uri) => {
    const map = bridge.worldMap;
    return { contents: [{ uri: uri.href, text: JSON.stringify(map, null, 2) }] };
  },
);

server.registerResource(
  "help",
  "muddown://help/commands",
  {
    title: "Help — Commands",
    description: "Game command reference",
    mimeType: "text/markdown",
  },
  async (uri) => {
    const help = bridge.helpText;
    if (!help) {
      return { contents: [{ uri: uri.href, text: "*Send `help` command first to load help text.*" }] };
    }
    return { contents: [{ uri: uri.href, text: help }] };
  },
);

// ─── Tools ───────────────────────────────────────────────────────────────────

// MCP SDK overload resolution triggers TS2589 with zod v3/v4 compat layer.
// Extracting the handler avoids the excessive type depth during overload matching.
async function handleGameCommand(args: Record<string, unknown>): Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}> {
  const command = args.command;
  if (typeof command !== "string" || !command.trim()) {
    return {
      content: [{ type: "text", text: "Missing or empty 'command' argument." }],
      isError: true,
    };
  }
  try {
    const response = await bridge.sendCommand(command);
    return { content: [{ type: "text", text: response }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Command failed: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

// MCP SDK overload resolution hits TS2589 with zod v3/v4 compat layer — cast the method, not the server.
const registerTool = server.tool.bind(server) as (
  name: string,
  description: string,
  schema: Record<string, z.ZodTypeAny>,
  handler: typeof handleGameCommand,
) => void;
registerTool(
  "game_command",
  "Execute a raw game command string. Prefer the specific tools (look, go, " +
    "examine, get, drop, inventory, equip, unequip, use, talk, attack, say, " +
    "combine, lore) when possible. Use available_actions to see what you can do " +
    "right now. Falls back to this for commands without a dedicated tool.",
  { command: z.string() },
  handleGameCommand,
);

// ─── Granular Tools ──────────────────────────────────────────────────────────

registerTool(
  "look",
  "Look around the current room. Returns the full room description including " +
    "exits, NPCs present, and items on the ground.",
  {},
  async () => {
    try {
      const response = await bridge.sendCommand("look");
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "go",
  "Move in a direction. Valid directions depend on the current room's exits " +
    "(e.g. north, south, east, west, up, down).",
  { direction: z.string().describe("The direction to move") },
  async (args) => {
    const dir = args.direction;
    if (typeof dir !== "string" || !dir.trim()) {
      return { content: [{ type: "text", text: "Missing 'direction' argument." }], isError: true };
    }
    try {
      const response = await bridge.sendCommand(`go ${dir.trim()}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "examine",
  "Examine an item, NPC, or object in the room or your inventory for a " +
    "detailed description.",
  { target: z.string().describe("The name of the thing to examine") },
  async (args) => {
    const target = args.target;
    if (typeof target !== "string" || !target.trim()) {
      return { content: [{ type: "text", text: "Missing 'target' argument." }], isError: true };
    }
    try {
      const response = await bridge.sendCommand(`examine ${target.trim()}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "get",
  "Pick up an item from the current room and add it to your inventory.",
  { item: z.string().describe("The name of the item to pick up") },
  async (args) => {
    const item = args.item;
    if (typeof item !== "string" || !item.trim()) {
      return { content: [{ type: "text", text: "Missing 'item' argument." }], isError: true };
    }
    try {
      const response = await bridge.sendCommand(`get ${item.trim()}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "drop",
  "Drop an item from your inventory into the current room.",
  { item: z.string().describe("The name of the item to drop") },
  async (args) => {
    const item = args.item;
    if (typeof item !== "string" || !item.trim()) {
      return { content: [{ type: "text", text: "Missing 'item' argument." }], isError: true };
    }
    try {
      const response = await bridge.sendCommand(`drop ${item.trim()}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "inventory",
  "Check your current inventory and equipped items.",
  {},
  async () => {
    try {
      const response = await bridge.sendCommand("inventory");
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "equip",
  "Equip an item from your inventory (weapon, armor, or accessory slot).",
  { item: z.string().describe("The name of the item to equip") },
  async (args) => {
    const item = args.item;
    if (typeof item !== "string" || !item.trim()) {
      return { content: [{ type: "text", text: "Missing 'item' argument." }], isError: true };
    }
    try {
      const response = await bridge.sendCommand(`equip ${item.trim()}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "unequip",
  "Unequip an item from an equipment slot. Pass the slot name: 'weapon', " +
    "'armor', or 'accessory'. The item is returned to your inventory.",
  { slot: z.enum(["weapon", "armor", "accessory"]).describe("The equipment slot to unequip") },
  async (args) => {
    try {
      const response = await bridge.sendCommand(`unequip ${args.slot}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "use",
  "Use an item from your inventory (e.g. eat bread, read scroll, light lantern). " +
    "Some items require a target.",
  {
    item: z.string().describe("The name of the item to use"),
    target: z.string().optional().describe("Optional target for the item"),
  },
  async (args) => {
    const item = args.item;
    if (typeof item !== "string" || !item.trim()) {
      return { content: [{ type: "text", text: "Missing 'item' argument." }], isError: true };
    }
    const target = typeof args.target === "string" && args.target.trim() ? ` ${args.target.trim()}` : "";
    try {
      const response = await bridge.sendCommand(`use ${item.trim()}${target}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "talk",
  "Talk to an NPC in the current room. Optionally include a message for " +
    "freeform conversation (if the server supports LLM-powered dialogue).",
  {
    npc: z.string().describe("The name of the NPC to talk to"),
    message: z.string().optional().describe("Optional message to say to the NPC"),
  },
  async (args) => {
    const npc = args.npc;
    if (typeof npc !== "string" || !npc.trim()) {
      return { content: [{ type: "text", text: "Missing 'npc' argument." }], isError: true };
    }
    const msg = typeof args.message === "string" && args.message.trim() ? ` ${args.message.trim()}` : "";
    try {
      const response = await bridge.sendCommand(`talk ${npc.trim()}${msg}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "attack",
  "Attack an NPC in the current room. Initiates turn-based combat.",
  { target: z.string().describe("The name of the NPC to attack") },
  async (args) => {
    const target = args.target;
    if (typeof target !== "string" || !target.trim()) {
      return { content: [{ type: "text", text: "Missing 'target' argument." }], isError: true };
    }
    try {
      const response = await bridge.sendCommand(`attack ${target.trim()}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "say",
  "Say something aloud in the current room. Other players in the room will see it.",
  { message: z.string().describe("The message to say") },
  async (args) => {
    const message = args.message;
    if (typeof message !== "string" || !message.trim()) {
      return { content: [{ type: "text", text: "Missing 'message' argument." }], isError: true };
    }
    try {
      const response = await bridge.sendCommand(`say ${message.trim()}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "combine",
  "Combine two items from your inventory to create something new.",
  {
    item1: z.string().describe("The first item to combine"),
    item2: z.string().describe("The second item to combine"),
  },
  async (args) => {
    const item1 = args.item1;
    const item2 = args.item2;
    if (typeof item1 !== "string" || !item1.trim() || typeof item2 !== "string" || !item2.trim()) {
      return { content: [{ type: "text", text: "Both 'item1' and 'item2' arguments are required." }], isError: true };
    }
    try {
      const response = await bridge.sendCommand(`combine ${item1.trim()} with ${item2.trim()}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "lore",
  "Ask a question about the game world, its lore, NPCs, locations, or items. " +
    "Uses vector search and (if available) LLM synthesis to answer from game data.",
  { question: z.string().describe("The question to ask about the game world") },
  async (args) => {
    const question = args.question;
    if (typeof question !== "string" || !question.trim()) {
      return { content: [{ type: "text", text: "Missing 'question' argument." }], isError: true };
    }
    try {
      const response = await bridge.sendCommand(`lore ${question.trim()}`);
      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return { content: [{ type: "text", text: errorText(err) }], isError: true };
    }
  },
);

registerTool(
  "available_actions",
  "Get a structured summary of what the player can do right now: available " +
    "exits, NPCs to talk to or fight, items on the ground, and inventory items.",
  {},
  async () => {
    const room = bridge.currentRoom;
    if (!room) {
      // Try to get room data first
      try {
        await bridge.sendCommand("look");
      } catch (err) {
        return { content: [{ type: "text", text: errorText(err) }], isError: true };
      }
      if (!bridge.currentRoom) {
        return {
          content: [{ type: "text", text: "look command sent but room data was not received. The server may have responded with a non-room message." }],
          isError: true,
        };
      }
    }

    const current = bridge.currentRoom!;
    const exits = parseExitsFromRoom(current);
    const npcs = parseNpcsFromRoom(current);
    const items = parseItemsFromRoom(current);
    const inv = bridge.inventoryState;

    const summary: AvailableActions = {
      roomId: bridge.currentRoomId,
      exits,
      npcs: npcs.map((n) => n.name),
      items: items.map((i) => i.name),
      inventory: inv?.items?.map((i) => i.name) ?? [],
      equipped: inv?.equipped
        ? Object.fromEntries(
            Object.entries(inv.equipped).map(([slot, val]) => [slot, val?.name ?? null]),
          )
        : {},
    };
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  },
);

function errorText(err: unknown): string {
  return `Command failed: ${err instanceof Error ? err.message : String(err)}`;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface AvailableActions {
  roomId: string | null;
  exits: string[];
  npcs: string[];
  items: string[];
  inventory: string[];
  equipped: Record<string, string | null>;
}

// ─── Startup ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await bridge.connect();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown — idempotent, invoked on signals and unhandled errors
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    bridge.disconnect();
    await server.close();
  }
  function handleSignal(signal: string): void {
    shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`[mcp] Shutdown failed on ${signal}:`, err);
        process.exit(1);
      });
  }
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  // Request initial state — non-fatal if the server is slow.
  // Commands are sequential because the bridge has a single pendingCommand slot.
  try {
    await bridge.sendCommand("look");
    await bridge.sendCommand("help");
  } catch (err) {
    console.error("[bridge] Initial state prefetch failed (non-fatal):", err);
  }
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
