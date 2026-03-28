import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@muddown/shared";
import { loadWorld, type WorldMap } from "./world.js";

// ─── Player Session ──────────────────────────────────────────────────────────

interface PlayerSession {
  id: string;
  name: string;
  currentRoom: string;
  ws: WebSocket;
}

// ─── Server ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3300;
const world: WorldMap = loadWorld();
const sessions = new Map<WebSocket, PlayerSession>();

const wss = new WebSocketServer({ port: PORT });

console.log(`MUDdown server listening on ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  const session: PlayerSession = {
    id: randomUUID(),
    name: `Adventurer-${Math.floor(Math.random() * 9000) + 1000}`,
    currentRoom: "town-square",
    ws,
  };
  sessions.set(ws, session);

  // Send welcome
  send(ws, {
    v: 1,
    id: randomUUID(),
    type: "system",
    timestamp: new Date().toISOString(),
    muddown: `:::system{type="welcome"}
**Welcome to Northkeep**, ${session.name}!

Type commands or click links to explore. Try: \`look\`, \`go north\`, \`help\`
:::`,
  });

  // Send initial room
  sendRoom(ws, session.currentRoom);

  ws.on("message", (data) => {
    try {
      const msg: ClientMessage = JSON.parse(String(data));
      handleCommand(ws, msg);
    } catch {
      send(ws, systemMessage("Could not understand that command."));
    }
  });

  ws.on("close", () => {
    sessions.delete(ws);
  });
});

// ─── Command Handling ────────────────────────────────────────────────────────

function handleCommand(ws: WebSocket, msg: ClientMessage): void {
  const session = sessions.get(ws);
  if (!session) return;

  const raw = (msg.command ?? "").trim().toLowerCase();
  const [verb, ...rest] = raw.split(/\s+/);
  const arg = rest.join(" ");

  switch (verb) {
    case "go":
    case "north":
    case "south":
    case "east":
    case "west":
    case "up":
    case "down": {
      const direction = verb === "go" ? arg : verb;
      move(ws, session, direction);
      break;
    }
    case "look":
    case "l":
      sendRoom(ws, session.currentRoom);
      break;
    case "help":
      sendHelp(ws);
      break;
    case "say": {
      broadcast(session, arg);
      break;
    }
    case "who":
      sendWho(ws);
      break;
    case "examine": {
      sendExamine(ws, session, arg);
      break;
    }
    default:
      send(ws, systemMessage(`Unknown command: \`${verb}\`. Type \`help\` for a list of commands.`));
  }
}

function move(ws: WebSocket, session: PlayerSession, direction: string): void {
  const exits = world.connections.get(session.currentRoom);
  const targetRoom = exits?.[direction];

  if (!targetRoom) {
    send(ws, systemMessage(`You can't go **${direction}** from here.`));
    return;
  }

  if (!world.rooms.has(targetRoom)) {
    send(ws, systemMessage("That path leads somewhere not yet built..."));
    return;
  }

  // Notify others in old room
  broadcastToRoom(session.currentRoom, session, `*${session.name} heads ${direction}.*`);

  session.currentRoom = targetRoom;

  // Notify others in new room
  broadcastToRoom(session.currentRoom, session, `*${session.name} arrives.*`);

  sendRoom(ws, session.currentRoom);
}

function sendRoom(ws: WebSocket, roomId: string): void {
  const room = world.rooms.get(roomId);
  if (!room) {
    send(ws, systemMessage("You are nowhere. This shouldn't happen."));
    return;
  }

  // Append other players in the room
  const othersHere = [...sessions.values()]
    .filter((s) => s.currentRoom === roomId && s.ws !== ws)
    .map((s) => `- [@${s.name}](player:${s.id}) is here.`);

  let muddown = room.muddown;
  if (othersHere.length > 0) {
    const playersSection = "\n" + othersHere.join("\n");
    // Insert before the closing :::
    muddown = muddown.replace(/\n:::\s*$/, playersSection + "\n:::");
  }

  send(ws, {
    v: 1,
    id: randomUUID(),
    type: "room",
    timestamp: new Date().toISOString(),
    muddown,
    meta: { room_id: roomId, region: room.attributes.region },
  });
}

function sendHelp(ws: WebSocket): void {
  send(ws, {
    v: 1,
    id: randomUUID(),
    type: "system",
    timestamp: new Date().toISOString(),
    muddown: `:::system{type="help"}
# Commands

| Command | Description |
|---------|-------------|
| \`look\` | Look around the current room |
| \`go <direction>\` | Move in a direction (north, south, east, west, up, down) |
| \`examine <thing>\` | Examine something in the room |
| \`say <message>\` | Say something to others in the room |
| \`who\` | See who is online |
| \`help\` | Show this help |

You can also click on **links** in room descriptions to interact.
:::`,
  });
}

function sendWho(ws: WebSocket): void {
  const players = [...sessions.values()].map(
    (s) => `- [@${s.name}](player:${s.id}) — *${world.rooms.get(s.currentRoom)?.attributes.id ?? "unknown"}*`
  );
  send(ws, {
    v: 1,
    id: randomUUID(),
    type: "system",
    timestamp: new Date().toISOString(),
    muddown: `:::system{type="who"}
# Who's Online

${players.join("\n")}
:::`,
  });
}

function sendExamine(ws: WebSocket, session: PlayerSession, target: string): void {
  // Simple examine: just acknowledge for now
  send(ws, {
    v: 1,
    id: randomUUID(),
    type: "narrative",
    timestamp: new Date().toISOString(),
    muddown: `You take a closer look at **${target || "your surroundings"}**... but find nothing remarkable yet.\n\n*Detailed examination coming in a future update.*`,
  });
}

function broadcast(sender: PlayerSession, message: string): void {
  const muddown = `**${sender.name}** says: "${message}"`;
  for (const [ws, s] of sessions) {
    if (s.currentRoom === sender.currentRoom) {
      send(ws, {
        v: 1,
        id: randomUUID(),
        type: "narrative",
        timestamp: new Date().toISOString(),
        muddown,
      });
    }
  }
}

function broadcastToRoom(roomId: string, exclude: PlayerSession, message: string): void {
  for (const [ws, s] of sessions) {
    if (s.currentRoom === roomId && s.id !== exclude.id) {
      send(ws, {
        v: 1,
        id: randomUUID(),
        type: "narrative",
        timestamp: new Date().toISOString(),
        muddown: message,
      });
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function systemMessage(text: string): ServerMessage {
  return {
    v: 1,
    id: randomUUID(),
    type: "system",
    timestamp: new Date().toISOString(),
    muddown: `:::system{type="notification"}\n${text}\n:::`,
  };
}
