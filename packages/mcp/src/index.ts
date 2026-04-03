#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { GameBridge } from "./bridge.js";

const GAME_SERVER_URL = process.env.MUDDOWN_SERVER_URL ?? "ws://localhost:3300";

const server = new McpServer(
  {
    name: "muddown-mcp",
    version: "0.1.0",
  },
  {
    instructions:
      "MUDdown game server MCP interface. Use read_resource to inspect current room, " +
      "inventory, and player stats. Use the game_command tool to play the game. " +
      "The world/map resource shows the full room graph. " +
      "Always read the current room before deciding on a command.",
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
  "Execute a game command. Examples: 'look', 'go north', 'examine key', " +
    "'get sword', 'inventory', 'talk crier', 'attack goblin', 'help'",
  { command: z.string() },
  handleGameCommand,
);

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
