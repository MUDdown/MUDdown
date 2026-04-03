import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ServerMessage, ClientMessage } from "@muddown/shared";

/** Timeout for waiting on a command response (ms). */
const COMMAND_TIMEOUT = 10_000;

/**
 * Tracks game state received from the MUDdown server and provides a
 * request/response interface on top of the fire-and-forget WebSocket
 * protocol.
 *
 * The bridge connects as a guest player and caches the latest room,
 * inventory, and help messages so MCP resources can serve them.
 */
export class GameBridge {
  private ws: WebSocket | null = null;

  // ── Cached game state ──────────────────────────────────────────────────
  currentRoom: string | null = null;
  inventory: string | null = null;
  helpText: string | null = null;
  playerStats: PlayerStats = { hp: 20, maxHp: 20, xp: 0, class: null };
  worldMap: WorldMapEntry[] = [];
  private playerName: string | null = null;

  // ── Command response tracking ──────────────────────────────────────────
  private pendingCommand: {
    resolve: (value: string) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private readonly serverUrl: string,
  ) {}

  /** Connect to the game server. Resolves once the WebSocket is open. */
  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let connected = false;
      this.ws = new WebSocket(this.serverUrl);

      this.ws.on("open", () => {
        connected = true;
        resolve();
      });

      this.ws.on("message", (data) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(data)) as ServerMessage;
        } catch {
          console.error("[bridge] Received non-JSON message:", String(data).slice(0, 200));
          return;
        }
        try {
          this.handleServerMessage(msg);
        } catch (err) {
          console.error("[bridge] handleServerMessage threw unexpectedly:", err);
          this.rejectPendingCommand(new Error("Internal error processing server message"));
        }
      });

      this.ws.on("error", (err) => {
        if (!connected) {
          reject(err);
          return;
        }
        console.error("[bridge] WebSocket error:", err);
        this.rejectPendingCommand(new Error(`WebSocket error: ${err.message}`));
      });

      this.ws.on("close", (code) => {
        this.ws = null;
        if (!connected) {
          reject(new Error(`WebSocket closed before connection established (code ${code})`));
          return;
        }
        this.rejectPendingCommand(new Error(`WebSocket closed while waiting for command response (code ${code})`));
      });
    });
  }

  /**
   * Send a command and wait for the next server response.
   * Returns the MUDdown content of the response.
   */
  async sendCommand(command: string): Promise<string> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to game server");
    }

    // Flush any pending command
    if (this.pendingCommand) {
      this.rejectPendingCommand(new Error("Superseded by new command"));
    }

    const msg: ClientMessage = {
      v: 1,
      id: randomUUID(),
      type: "command",
      timestamp: new Date().toISOString(),
      command,
    };

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommand = null;
        reject(new Error(`Command timed out after ${COMMAND_TIMEOUT}ms: ${command}`));
      }, COMMAND_TIMEOUT);

      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        reject(new Error("Connection lost before command could be sent"));
        return;
      }
      this.pendingCommand = { resolve, reject, timer };
      ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          this.rejectPendingCommand(new Error(`Failed to send command: ${err.message}`));
        }
      });
    });
  }

  /** Disconnect from the game server. */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Reject any in-flight command promise and clear its timeout. */
  private rejectPendingCommand(error: Error): void {
    if (this.pendingCommand) {
      const { reject: pendingReject, timer } = this.pendingCommand;
      this.pendingCommand = null;
      clearTimeout(timer);
      pendingReject(error);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  private handleServerMessage(msg: ServerMessage): void {
    // Update cached state based on message type
    switch (msg.type) {
      case "room":
        this.currentRoom = msg.muddown;
        this.updateWorldMap(msg);
        break;
      case "system":
        this.handleSystemMessage(msg);
        break;
    }

    // Resolve pending command if any.
    // NOTE: The server protocol is fire-and-forget (no correlation IDs), so
    // we resolve on the first message received after sending a command.
    // Ambient broadcasts (e.g. narrative from other players) could race with
    // the actual response, but in practice MCP commands are sequential and
    // the server replies before processing the next player's input.
    // TODO: add correlation via meta.command_id once the server supports it.
    if (this.pendingCommand) {
      const { resolve, timer } = this.pendingCommand;
      this.pendingCommand = null;
      clearTimeout(timer);
      resolve(msg.muddown);
    }
  }

  private handleSystemMessage(msg: ServerMessage): void {
    const md = msg.muddown;

    if (md.includes('type="inventory"')) {
      this.inventory = md;
    } else if (md.includes('type="help"')) {
      this.helpText = md;
    } else if (md.includes('type="welcome"')) {
      // Extract player name from "Welcome to <place>, <name>!"
      const nameMatch = md.match(/\*\*Welcome to\s+.+?\*\*,\s+(.+?)!/);
      if (nameMatch) {
        this.playerName = nameMatch[1];
      }
    }

    // TODO: parse msg.meta.inventoryState to update this.playerStats
  }

  private updateWorldMap(msg: ServerMessage): void {
    const roomId = typeof msg.meta?.room_id === "string" ? msg.meta.room_id : null;
    const region = typeof msg.meta?.region === "string" ? msg.meta.region : null;
    if (!roomId) return;

    // Extract exits from the MUDdown content
    const exits: Record<string, string> = {};
    const exitRegex = /\[(\w+)\]\(go:(\w+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = exitRegex.exec(msg.muddown)) !== null) {
      exits[match[2]] = match[2]; // direction → direction
    }

    // Extract room title
    const titleMatch = msg.muddown.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1] ?? roomId;

    // Update or add entry
    const existing = this.worldMap.find((e) => e.id === roomId);
    if (existing) {
      existing.title = title;
      existing.region = region;
      existing.exits = exits;
    } else {
      this.worldMap.push({ id: roomId, title, region, exits });
    }
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlayerStats {
  hp: number;
  maxHp: number;
  xp: number;
  class: string | null;
}

export interface WorldMapEntry {
  id: string;
  title: string;
  region: string | null;
  exits: Record<string, string>;
}
