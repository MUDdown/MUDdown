import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage, EquipSlot, NpcDefinition, DialogueNode, CharacterRecord, CharacterClass } from "@muddown/shared";
import { PLAYER_DEFAULTS, CLASS_STATS } from "@muddown/shared";
import { loadWorld, type WorldMap } from "./world.js";
import {
  dirAliases, findItemByName, findNpcInRoom, findUnclaimedIndex,
  escapeMarkdownLinkLabel, escapeMarkdownLinkDest, escapeDialogueText,
  resolveAttack, formatAttackLine, getPlayerAttackBonus, getPlayerDamage, getPlayerAc,
  resetPlayerAfterDefeat, stripHtmlComments,
} from "./helpers.js";
import { SqliteDatabase } from "./db/index.js";
import type { GameDatabase } from "./db/types.js";
import { handleAuthRoute, resolveTicket, setCorsHeaders, type OAuthConfig } from "./auth.js";
import { fireHook, registerHook, createGreetingHook } from "./hooks.js";

// ─── Player Session ──────────────────────────────────────────────────────────

interface CombatState {
  npcId: string;
  roomId: string;
  round: number;
  npcMaxHp: number;
}

interface PlayerSession {
  id: string;
  name: string;
  currentRoom: string;
  ws: WebSocket;
  inventory: string[]; // item IDs
  equipped: Record<EquipSlot, string | null>;
  hp: number;
  maxHp: number;
  combat: CombatState | null;
  characterId: string | null;  // DB character ID (null = anonymous guest)
  accountId: string | null;    // DB account ID (null = anonymous guest)
  characterClass: CharacterClass | null;
  baseAc: number;
  baseAttackBonus: number;
  baseDamage: string;
  xp: number;
}

const RESPAWN_ROOM = "town-square";
const NPC_RESPAWN_MS = 20 * 60 * 1000; // 20 minutes
const SAVE_INTERVAL_MS = 60 * 1000;    // auto-save every 60 seconds

// ─── Shared NPC HP (for multi-player combat) ─────────────────────────────────

function getNpcHpKey(roomId: string, npcId: string): string {
  return `${roomId}:${npcId}`;
}

const npcHpMap = new Map<string, number>();

// ─── Server ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3300;
const world: WorldMap = loadWorld();
const sessions = new Map<WebSocket, PlayerSession>();

// ── Database ───────────────────────────────────────────────────────────────

const DB_PATH = process.env.MUDDOWN_DB ?? "muddown.sqlite";
let db: GameDatabase;
try {
  db = new SqliteDatabase(DB_PATH);
} catch (err) {
  console.error(`Fatal: failed to open database at "${DB_PATH}". Check path, permissions, and disk space.`, err);
  process.exit(1);
}

// Restore persisted world state from DB (room items, NPC HP)
function restoreWorldState(): void {
  const savedRoomItems = db.getAllRoomItems();
  if (savedRoomItems.size > 0) {
    for (const [roomId, items] of savedRoomItems) {
      world.roomItems.set(roomId, items);
    }
  }

  const savedNpcHp = db.getAllNpcHp();
  for (const [key, hp] of savedNpcHp) {
    npcHpMap.set(key, hp);
  }

  // Remove defeated NPCs from room NPC lists
  const defeated = db.getDefeatedNpcs();
  for (const record of defeated) {
    const roomNpcList = world.roomNpcs.get(record.roomId);
    if (roomNpcList) {
      const idx = roomNpcList.indexOf(record.npcId);
      if (idx !== -1) roomNpcList.splice(idx, 1);
    }
  }
}

try {
  restoreWorldState();
} catch (err) {
  console.error("Fatal: failed to restore world state from database.", err);
  process.exit(1);
}

// ── NPC Respawn Timer ──────────────────────────────────────────────────────

function respawnDefeatedNpcs(): void {
  const now = new Date();
  const defeated = db.getDefeatedNpcs();
  for (const record of defeated) {
    if (new Date(record.respawnAt) <= now) {
      try {
        // Restore NPC to its home room
        const npc = world.npcDefs.get(record.npcId);
        if (npc) {
          const homeRoom = npc.location;
          const roomNpcList = world.roomNpcs.get(homeRoom) ?? [];
          if (!roomNpcList.includes(record.npcId)) {
            roomNpcList.push(record.npcId);
            world.roomNpcs.set(homeRoom, roomNpcList);
          }
          // Reset HP to max
          if (npc.combat) {
            const hpKey = getNpcHpKey(homeRoom, record.npcId);
            npcHpMap.delete(hpKey);
            db.removeNpcHp(homeRoom, record.npcId);
          }
          // Fire onReset hook
          fireHook({
            event: "onReset",
            entityId: record.npcId,
            entityType: "npc",
            roomId: homeRoom,
          });
        }
        db.removeDefeatedNpc(record.npcId);
        console.log(`Respawned NPC "${record.npcId}" in room "${npc?.location ?? record.roomId}"`);
      } catch (err) {
        console.error(`Failed to respawn NPC "${record.npcId}" in room "${record.roomId}":`, err);
      }
    }
  }
}

const respawnTimer = setInterval(respawnDefeatedNpcs, 60_000); // check every minute

// ── Register NPC greeting hooks ────────────────────────────────────────────

for (const [npcId, npc] of world.npcDefs) {
  const startNode = npc.dialogue["start"];
  if (startNode) {
    registerHook(
      "npc", npcId, "onContact",
      createGreetingHook(npcId, `:::dialogue{npc="${npcId}" mood="${startNode.mood ?? "neutral"}"}\n> **${npc.name}** says, "${escapeDialogueText(startNode.text)}"\n:::`),
    );
  }
}

// ── OAuth Configuration ────────────────────────────────────────────────────

const oauthConfig: OAuthConfig | null =
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
    ? {
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackUrl: process.env.GITHUB_CALLBACK_URL ?? `http://localhost:${PORT}/auth/callback`,
      }
    : null;

if (!oauthConfig) {
  console.warn("GitHub OAuth not configured — players will connect as anonymous guests.");
  console.warn("Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable authentication.");
} else if (!process.env.GITHUB_CALLBACK_URL) {
  console.warn(`GITHUB_CALLBACK_URL not set — defaulting to http://localhost:${PORT}/auth/callback (set this in production).`);
}

// ── HTTP + WebSocket Server ────────────────────────────────────────────────

const server = createServer((req, res) => {
  const handleRequest = async (): Promise<void> => {
    // Handle auth routes if OAuth is configured (CORS handled inside handleAuthRoute)
    if (oauthConfig && await handleAuthRoute(req, res, oauthConfig, db)) {
      return;
    }

    // CORS for non-auth routes
    setCorsHeaders(req, res);

    // Health check
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", players: sessions.size }));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  };

  handleRequest().catch((err) => {
    console.error("HTTP request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal server error.");
    }
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req: IncomingMessage, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

server.listen(PORT, () => {
  console.log(`MUDdown server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});

wss.on("connection", (ws, req: IncomingMessage) => {
  // Authenticate via short-lived single-use ticket: ws://host/?ticket=...
  let character: CharacterRecord | undefined;
  let ticket: string | undefined;
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    ticket = url.searchParams.get("ticket") ?? undefined;
  } catch {
    // Ignore URL parse errors — proceed as guest
  }

  if (ticket) {
    const characterId = resolveTicket(ticket);
    if (characterId) {
      character = db.getCharacterById(characterId);
      if (!character) {
        console.warn(`Character referenced by ticket not found [ticket=${ticket}] [characterId=${characterId}]`);
      }
    }
  }

  const session: PlayerSession = character
    ? {
        id: randomUUID(),
        name: character.name,
        currentRoom: character.currentRoom,
        ws,
        inventory: [...character.inventory],
        equipped: { ...character.equipped },
        hp: character.hp,
        maxHp: character.maxHp,
        combat: null,
        characterId: character.id,
        accountId: character.accountId,
        characterClass: character.characterClass,
        baseAc: CLASS_STATS[character.characterClass].ac,
        baseAttackBonus: CLASS_STATS[character.characterClass].attackBonus,
        baseDamage: CLASS_STATS[character.characterClass].damage,
        xp: character.xp,
      }
    : {
        id: randomUUID(),
        name: `Adventurer-${Math.floor(Math.random() * 9000) + 1000}`,
        currentRoom: RESPAWN_ROOM,
        ws,
        inventory: [],
        equipped: { weapon: null, armor: null, accessory: null },
        hp: PLAYER_DEFAULTS.hp,
        maxHp: PLAYER_DEFAULTS.maxHp,
        combat: null,
        characterId: null,
        accountId: null,
        characterClass: null,
        baseAc: PLAYER_DEFAULTS.ac,
        baseAttackBonus: PLAYER_DEFAULTS.attackBonus,
        baseDamage: PLAYER_DEFAULTS.damage,
        xp: 0,
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
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      send(ws, systemMessage("Could not understand that command."));
      return;
    }
    try {
      handleCommand(ws, msg);
    } catch (err) {
      const session = sessions.get(ws);
      console.error(`Command error [player=${session?.id}] [command=${msg.command}]:`, err);
      send(ws, systemMessage("An internal error occurred."));
    }
  });

  ws.on("close", () => {
    const s = sessions.get(ws);
    if (s?.characterId) {
      saveCharacterSession(s);
    }
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
    case "down":
    case "northeast":
    case "northwest":
    case "southeast":
    case "southwest":
    case "n":
    case "s":
    case "e":
    case "w":
    case "u":
    case "d":
    case "ne":
    case "nw":
    case "se":
    case "sw": {
      const direction = verb === "go" ? (dirAliases[arg] ?? arg) : (dirAliases[verb] ?? verb);
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
    case "get":
    case "take": {
      handleGet(ws, session, arg);
      break;
    }
    case "drop": {
      handleDrop(ws, session, arg);
      break;
    }
    case "inventory":
    case "inv":
    case "i": {
      sendInventory(ws, session);
      break;
    }
    case "equip": {
      handleEquip(ws, session, arg);
      break;
    }
    case "unequip": {
      handleUnequip(ws, session, arg);
      break;
    }
    case "use": {
      handleUse(ws, session, arg);
      break;
    }
    case "combine": {
      handleCombine(ws, session, arg);
      break;
    }
    case "talk": {
      handleTalk(ws, session, arg);
      break;
    }
    case "attack": {
      handleAttack(ws, session, arg);
      break;
    }
    case "flee": {
      handleFlee(ws, session);
      break;
    }
    default:
      send(ws, systemMessage(`Unknown command: \`${verb}\`. Type \`help\` for a list of commands.`));
  }
}

function move(ws: WebSocket, session: PlayerSession, direction: string): void {
  if (session.combat) {
    send(ws, systemMessage("You're in combat! Use `flee` to escape or `attack` to fight."));
    return;
  }

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

  // Fire onContact hooks for NPCs in the new room
  const roomNpcIds = world.roomNpcs.get(targetRoom) ?? [];
  for (const npcId of roomNpcIds) {
    const results = fireHook({
      event: "onContact",
      entityId: npcId,
      entityType: "npc",
      contactId: session.characterId ?? session.id,
      contactType: "player",
      roomId: targetRoom,
    });
    for (const result of results) {
      if (result.message) {
        send(ws, {
          v: 1, id: randomUUID(), type: "dialogue",
          timestamp: new Date().toISOString(), muddown: result.message,
        });
      }
      if (result.broadcast) {
        broadcastToRoom(targetRoom, session, result.broadcast);
      }
    }
  }
}

function sendRoom(ws: WebSocket, roomId: string): void {
  const room = world.rooms.get(roomId);
  if (!room) {
    send(ws, systemMessage("You are nowhere. This shouldn't happen."));
    return;
  }

  // Dynamically build the Items section from room state
  const roomItemIds = world.roomItems.get(roomId) ?? [];
  const itemLines: string[] = [];
  for (const id of roomItemIds) {
    const def = world.itemDefs.get(id);
    if (!def) {
      console.warn(`Unknown item ID "${id}" in room "${roomId}"`);
      continue;
    }
    itemLines.push(`- [${def.name}](item:${def.id})`);
  }

  // Append other players in the room
  const othersHere = [...sessions.values()]
    .filter((s) => s.currentRoom === roomId && s.ws !== ws)
    .map((s) => `- [@${s.name}](player:${s.id}) is here.`);

  let muddown = stripHtmlComments(room.muddown);

  // Replace or inject dynamic Items section using header-boundary slicing
  const itemsHeaderIdx = muddown.indexOf("\n## Items\n");
  if (itemLines.length > 0) {
    const itemsBlock = "## Items\n\n" + itemLines.join("\n");
    if (itemsHeaderIdx !== -1) {
      // Find the end of the Items section: next ## header or closing :::
      const afterHeader = itemsHeaderIdx + 1; // skip the leading \n
      const nextHeaderIdx = muddown.indexOf("\n## ", afterHeader + 9); // after "## Items\n"
      const closingIdx = muddown.indexOf("\n:::", afterHeader);
      let sectionEnd: number;
      if (nextHeaderIdx !== -1 && (closingIdx === -1 || nextHeaderIdx < closingIdx)) {
        sectionEnd = nextHeaderIdx + 1; // include the \n, position at start of next ##
      } else if (closingIdx !== -1) {
        sectionEnd = closingIdx + 1; // include the \n, position at :::
      } else {
        sectionEnd = muddown.length;
      }
      muddown = muddown.substring(0, afterHeader) + itemsBlock + "\n" + muddown.substring(sectionEnd);
    } else {
      // No existing Items section — insert before closing :::
      const closingIdx = muddown.lastIndexOf("\n:::");
      if (closingIdx !== -1) {
        muddown = muddown.substring(0, closingIdx) + "\n\n" + itemsBlock + muddown.substring(closingIdx);
      } else {
        muddown += "\n\n" + itemsBlock;
      }
    }
  } else if (itemsHeaderIdx !== -1) {
    // Remove Items section since room has no items left
    const afterHeader = itemsHeaderIdx + 1;
    const nextHeaderIdx = muddown.indexOf("\n## ", afterHeader + 9);
    const closingIdx = muddown.indexOf("\n:::", afterHeader);
    let sectionEnd: number;
    if (nextHeaderIdx !== -1 && (closingIdx === -1 || nextHeaderIdx < closingIdx)) {
      sectionEnd = nextHeaderIdx; // keep the \n as separator
    } else if (closingIdx !== -1) {
      sectionEnd = closingIdx; // keep the \n before :::
    } else {
      sectionEnd = muddown.length;
    }
    muddown = muddown.substring(0, itemsHeaderIdx) + muddown.substring(sectionEnd);
  }

  if (othersHere.length > 0) {
    const playersSection = "\n" + othersHere.join("\n");
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
| \`go <direction>\` | Move in a direction (n, s, e, w, u, d, ne, nw, se, sw) |
| \`examine <thing>\` | Examine something in the room |
| \`talk <npc>\` | Talk to an NPC |
| \`get <item>\` | Pick up an item |
| \`drop <item>\` | Drop an item from your inventory |
| \`inventory\` | Show your inventory and equipment |
| \`equip <item>\` | Equip a weapon, armor, or accessory |
| \`unequip <slot>\` | Unequip an item (weapon, armor, accessory) |
| \`use <item>\` | Use an item |
| \`combine <item> with <item>\` | Combine two items together |
| \`attack <npc>\` | Attack a hostile NPC |
| \`flee\` | Flee from combat |
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
  if (!target) {
    send(ws, systemMessage("Examine what?"));
    return;
  }

  // Check inventory first, then room items
  const allItems = [...session.inventory, ...(world.roomItems.get(session.currentRoom) ?? [])];
  const def = findItemByName(target, allItems, world.itemDefs);
  if (def) {
    const tags: string[] = [];
    if (def.fixed) tags.push("fixed");
    if (def.equippable) tags.push(`equippable (${def.slot})`);
    if (def.usable) tags.push("usable");
    const tagLine = tags.length > 0 ? `\n*${tags.join(" · ")}*` : "";
    send(ws, {
      v: 1,
      id: randomUUID(),
      type: "narrative",
      timestamp: new Date().toISOString(),
      muddown: `:::item{id="${def.id}" name="${def.name}"}\n**${def.name}** — ${def.description}${tagLine}\n:::`,
    });
    return;
  }

  // Check NPCs in the room
  const npc = findNpcInRoom(target, session.currentRoom, world.roomNpcs, world.npcDefs);
  if (npc) {
    send(ws, {
      v: 1,
      id: randomUUID(),
      type: "narrative",
      timestamp: new Date().toISOString(),
      muddown: `:::npc{id="${npc.id}" name="${npc.name}"}\n**${npc.name}** — ${npc.description}\n:::`,
    });
    return;
  }

  send(ws, {
    v: 1,
    id: randomUUID(),
    type: "narrative",
    timestamp: new Date().toISOString(),
    muddown: `You take a closer look at **${target}**... but find nothing remarkable.`,
  });
}

// ─── NPC & Dialogue ──────────────────────────────────────────────────────────

function handleTalk(ws: WebSocket, session: PlayerSession, arg: string): void {
  if (!arg) {
    send(ws, systemMessage("Talk to whom? Usage: `talk <npc>`"));
    return;
  }

  // Parse: "talk <npc>" or "talk <npc-id> <node-id>" (from cmd: links)
  const parts = arg.split(/\s+/);

  // First try: exact NPC ID match on first token (for cmd: links like "talk guard-7 friendly")
  let npc: NpcDefinition | undefined = undefined;
  let nodeId = "start";

  const directNpc = world.npcDefs.get(parts[0]);
  if (directNpc && directNpc.location === session.currentRoom) {
    npc = directNpc;
    nodeId = parts.length > 1 ? parts.slice(1).join(" ") : "start";
  }

  // Fallback: name-based search using the full arg
  if (!npc) {
    npc = findNpcInRoom(arg, session.currentRoom, world.roomNpcs, world.npcDefs);
    nodeId = "start";
  }

  if (!npc) {
    send(ws, systemMessage(`There's no one called **${arg}** here to talk to.`));
    return;
  }

  // Explicit "end" sentinel — conversation is over
  if (nodeId === "end") {
    send(ws, {
      v: 1,
      id: randomUUID(),
      type: "dialogue",
      timestamp: new Date().toISOString(),
      muddown: `:::dialogue{npc="${npc.id}" mood="neutral"}\n**${npc.name}** nods and turns away.\n:::`,
    });
    return;
  }

  const node = npc.dialogue[nodeId];
  if (!node) {
    console.warn(`Unknown dialogue node "${nodeId}" for NPC "${npc.id}"`);
    send(ws, {
      v: 1,
      id: randomUUID(),
      type: "dialogue",
      timestamp: new Date().toISOString(),
      muddown: `:::dialogue{npc="${npc.id}" mood="neutral"}\n**${npc.name}** has nothing more to say.\n:::`,
    });
    return;
  }

  sendDialogueNode(ws, npc, nodeId, node);
}

function sendDialogueNode(ws: WebSocket, npc: NpcDefinition, nodeId: string, node: DialogueNode): void {
  const mood = node.mood ?? "neutral";
  const lines: string[] = [];
  lines.push(`:::dialogue{npc="${npc.id}" mood="${mood}"}`);
  lines.push(`> **${npc.name}** says, "${escapeDialogueText(node.text)}"`);
  if (node.narrative) {
    lines.push("");
    lines.push(node.narrative);
  }
  if (node.responses.length > 0) {
    lines.push("");
    lines.push("## Responses");
    for (const resp of node.responses) {
      const label = escapeMarkdownLinkLabel(resp.text);
      if (resp.next === null) {
        const dest = escapeMarkdownLinkDest(`cmd:talk ${npc.id} end`);
        lines.push(`- ["${label}"](${dest})`);
      } else {
        const dest = escapeMarkdownLinkDest(`cmd:talk ${npc.id} ${resp.next}`);
        lines.push(`- ["${label}"](${dest})`);
      }
    }
  }
  lines.push(":::");

  send(ws, {
    v: 1,
    id: randomUUID(),
    type: "dialogue",
    timestamp: new Date().toISOString(),
    muddown: lines.join("\n"),
  });
}

// ─── Combat ──────────────────────────────────────────────────────────────────

function handleAttack(ws: WebSocket, session: PlayerSession, arg: string): void {
  if (!arg && !session.combat) {
    send(ws, systemMessage("Attack whom? Usage: `attack <npc>`"));
    return;
  }

  let npc: NpcDefinition | undefined;

  if (session.combat) {
    // Continue existing combat (arg is optional — defaults to current opponent)
    npc = world.npcDefs.get(session.combat.npcId);
    if (!npc || !npc.combat) {
      console.error(`Combat NPC "${session.combat.npcId}" not found or has no combat stats`);
      session.combat = null;
      send(ws, systemMessage("Your opponent can no longer fight."));
      return;
    }
  } else {
    // Start new combat
    npc = findNpcInRoom(arg, session.currentRoom, world.roomNpcs, world.npcDefs);
    if (!npc) {
      send(ws, systemMessage(`There's no one called **${arg}** here to attack.`));
      return;
    }
    if (!npc.combat) {
      send(ws, systemMessage(`**${npc.name}** is not hostile and can't be attacked.`));
      return;
    }
    // Initialize combat state
    const hpKey = getNpcHpKey(session.currentRoom, npc.id);
    if (!npcHpMap.has(hpKey)) {
      npcHpMap.set(hpKey, npc.combat.hp);
    }
    session.combat = {
      npcId: npc.id,
      roomId: session.currentRoom,
      round: 0,
      npcMaxHp: npc.combat.maxHp,
    };
  }

  const combat = session.combat;
  const npcStats = npc.combat;
  if (!npcStats) {
    console.error(`Combat NPC "${npc.id}" lost combat stats mid-fight`);
    session.combat = null;
    send(ws, systemMessage("Your opponent can no longer fight."));
    return;
  }
  combat.round++;

  // Calculate player stats (class base + equipment bonuses)
  const playerAtk = getPlayerAttackBonus(session.baseAttackBonus, session.equipped.weapon, world.itemDefs);
  const playerDmg = getPlayerDamage(session.baseDamage, session.equipped.weapon, world.itemDefs);
  const playerAc = getPlayerAc(session.baseAc, session.equipped.armor, session.equipped.accessory, world.itemDefs);

  // Get shared NPC HP
  const hpKey = getNpcHpKey(combat.roomId, combat.npcId);
  let npcHp = npcHpMap.get(hpKey);
  if (npcHp == null || npcHp <= 0) {
    // Another player defeated this NPC
    session.combat = null;
    send(ws, systemMessage(`**${npc.name}** has already been defeated.`));
    return;
  }

  const initiative = `player:${session.name},npc:${npc.id}`;
  const lines: string[] = [];
  lines.push(`:::combat{round=${combat.round} initiative="${initiative}"}`);
  lines.push(`## Round ${combat.round}`);
  lines.push("");

  // Player attacks NPC
  const playerResult = resolveAttack(playerAtk, playerDmg, npcStats.ac);
  if (playerResult.hit) {
    npcHp = Math.max(0, npcHp - playerResult.damage);
    npcHpMap.set(hpKey, npcHp);
  }
  lines.push(formatAttackLine(
    `@${session.name}`, npc.name,
    session.equipped.weapon ? world.itemDefs.get(session.equipped.weapon)?.name : undefined,
    playerResult, npcHp, combat.npcMaxHp,
  ));

  // Check if NPC is defeated
  if (npcHp <= 0) {
    lines.push("");
    lines.push(`**${npc.name}** collapses!`);
    lines.push(":::");

    send(ws, {
      v: 1, id: randomUUID(), type: "combat",
      timestamp: new Date().toISOString(), muddown: lines.join("\n"),
    });

    // Victory message
    send(ws, systemMessage(`You defeated the **${npc.name}**! (+${npcStats.xp} XP)`));

    // Award XP (persisted for authenticated characters via saveCharacterSession)
    session.xp += npcStats.xp;

    // Remove NPC from room and clean up shared HP
    npcHpMap.delete(hpKey);
    db.removeNpcHp(combat.roomId, npc.id);
    const roomNpcList = world.roomNpcs.get(combat.roomId);
    if (roomNpcList) {
      const idx = roomNpcList.indexOf(npc.id);
      if (idx !== -1) roomNpcList.splice(idx, 1);
    }

    // Record defeated NPC for respawn
    const now = new Date();
    db.addDefeatedNpc({
      npcId: npc.id,
      roomId: combat.roomId,
      defeatedAt: now.toISOString(),
      respawnAt: new Date(now.getTime() + NPC_RESPAWN_MS).toISOString(),
    });

    // Notify other players in combat with this NPC that it's dead
    for (const [otherWs, otherSession] of sessions) {
      if (otherWs !== ws && otherSession.combat?.npcId === npc.id && otherSession.combat?.roomId === combat.roomId) {
        otherSession.combat = null;
        send(otherWs, systemMessage(`**${npc.name}** was defeated by ${session.name}!`));
      }
    }

    broadcastToRoom(session.currentRoom, session, `*${session.name} defeated the ${npc.name}!*`);
    session.combat = null;
    return;
  }

  // NPC retaliates
  lines.push("");
  const npcResult = resolveAttack(npcStats.attackBonus, npcStats.damage, playerAc);
  if (npcResult.hit) {
    session.hp = Math.max(0, session.hp - npcResult.damage);
  }
  lines.push(formatAttackLine(
    npc.name, `@${session.name}`, undefined,
    npcResult, session.hp, session.maxHp,
  ));

  // Check if player is defeated
  if (session.hp <= 0) {
    lines.push("");
    lines.push(`**@${session.name}** falls unconscious!`);
    lines.push(":::");

    send(ws, {
      v: 1, id: randomUUID(), type: "combat",
      timestamp: new Date().toISOString(), muddown: lines.join("\n"),
    });

    handlePlayerDefeat(ws, session);
    return;
  }

  // Combat continues — add action links
  lines.push("");
  lines.push(`@${session.name} HP: ${session.hp}/${session.maxHp}`);
  lines.push("");
  lines.push("## Actions");
  lines.push(`- [Attack](cmd:attack ${escapeMarkdownLinkDest(npc.id)})`);
  lines.push(`- [Flee](cmd:flee)`);
  lines.push(":::");

  send(ws, {
    v: 1, id: randomUUID(), type: "combat",
    timestamp: new Date().toISOString(), muddown: lines.join("\n"),
  });
}

function handleFlee(ws: WebSocket, session: PlayerSession): void {
  if (!session.combat) {
    send(ws, systemMessage("You're not in combat."));
    return;
  }

  const npc = world.npcDefs.get(session.combat.npcId);
  const npcStats = npc?.combat;

  // NPC gets a free attack as you flee
  if (npc && npcStats) {
    const playerAc = getPlayerAc(session.baseAc, session.equipped.armor, session.equipped.accessory, world.itemDefs);
    const result = resolveAttack(npcStats.attackBonus, npcStats.damage, playerAc);
    if (result.hit) {
      session.hp = Math.max(0, session.hp - result.damage);
    }

    const lines: string[] = [];
    lines.push(`:::combat{round=${session.combat.round} initiative="npc:${npc.id}"}`);
    lines.push(`**@${session.name}** attempts to flee!`);
    lines.push("");
    lines.push(formatAttackLine(npc.name, `@${session.name}`, undefined, result, session.hp, session.maxHp));
    lines.push(":::");

    send(ws, {
      v: 1, id: randomUUID(), type: "combat",
      timestamp: new Date().toISOString(), muddown: lines.join("\n"),
    });

    if (session.hp <= 0) {
      handlePlayerDefeat(ws, session);
      return;
    }
  } else {
    console.error(`Flee: NPC "${session.combat.npcId}" not found or has no combat stats — skipping retaliation`);
  }

  session.combat = null;

  // Move to a random valid exit
  const exits = world.connections.get(session.currentRoom);
  if (exits) {
    const validDirections = Object.keys(exits).filter(
      (dir) => exits[dir] && world.rooms.has(exits[dir]),
    );
    if (validDirections.length > 0) {
      const dir = validDirections[Math.floor(Math.random() * validDirections.length)];
      const targetRoom = exits[dir];
      broadcastToRoom(session.currentRoom, session, `*${session.name} flees ${dir}!*`);
      session.currentRoom = targetRoom;
      broadcastToRoom(session.currentRoom, session, `*${session.name} arrives in a panic.*`);
      send(ws, systemMessage("You flee from combat!"));
      sendRoom(ws, session.currentRoom);
      return;
    }
  }
  // Fallback: stay in room — no exits to flee through
  send(ws, systemMessage("You scramble to escape but find no way out!"));
  sendRoom(ws, session.currentRoom);
}

function handlePlayerDefeat(ws: WebSocket, session: PlayerSession): void {
  if (!world.rooms.has(RESPAWN_ROOM)) {
    console.error(`Respawn room "${RESPAWN_ROOM}" not found in world — cannot teleport player`);
    send(ws, systemMessage("Something went wrong. Please reconnect."));
    return;
  }

  resetPlayerAfterDefeat(session, RESPAWN_ROOM);

  send(ws, systemMessage(
    "You were knocked unconscious... You awaken back in **Town Square**, fully healed.",
  ));
  broadcastToRoom(RESPAWN_ROOM, session, `*${session.name} stumbles in, looking dazed.*`);
  sendRoom(ws, session.currentRoom);
}

// ─── Item Commands ───────────────────────────────────────────────────────────

function handleGet(ws: WebSocket, session: PlayerSession, arg: string): void {
  if (!arg) {
    send(ws, systemMessage("Get what? Usage: `get <item>`"));
    return;
  }

  const roomItemIds = world.roomItems.get(session.currentRoom) ?? [];
  const def = findItemByName(arg, roomItemIds, world.itemDefs);
  if (!def) {
    send(ws, systemMessage(`You don't see **${arg}** here.`));
    return;
  }

  if (def.fixed) {
    send(ws, systemMessage(`The **${def.name}** can't be picked up.`));
    return;
  }

  // Remove from room, add to inventory
  const idx = roomItemIds.indexOf(def.id);
  if (idx !== -1) roomItemIds.splice(idx, 1);
  world.roomItems.set(session.currentRoom, roomItemIds);
  session.inventory.push(def.id);

  send(ws, systemMessage(`You pick up the **${def.name}**.`));
  broadcastToRoom(session.currentRoom, session, `*${session.name} picks up a ${def.name}.*`);
}

function handleDrop(ws: WebSocket, session: PlayerSession, arg: string): void {
  if (!arg) {
    send(ws, systemMessage("Drop what? Usage: `drop <item>`"));
    return;
  }

  const def = findItemByName(arg, session.inventory, world.itemDefs);
  if (!def) {
    send(ws, systemMessage(`You don't have **${arg}**.`));
    return;
  }

  // Check not equipped
  for (const [slot, eqId] of Object.entries(session.equipped)) {
    if (eqId === def.id) {
      send(ws, systemMessage(`You need to \`unequip ${slot}\` first.`));
      return;
    }
  }

  // Remove from inventory, add to room
  const idx = session.inventory.indexOf(def.id);
  if (idx !== -1) session.inventory.splice(idx, 1);
  const roomItemIds = world.roomItems.get(session.currentRoom) ?? [];
  roomItemIds.push(def.id);
  world.roomItems.set(session.currentRoom, roomItemIds);

  send(ws, systemMessage(`You drop the **${def.name}**.`));
  broadcastToRoom(session.currentRoom, session, `*${session.name} drops a ${def.name}.*`);
}

function sendInventory(ws: WebSocket, session: PlayerSession): void {
  const items: string[] = [];
  for (const id of session.inventory) {
    const def = world.itemDefs.get(id);
    if (!def) {
      console.warn(`Unknown item ID "${id}" in inventory [player=${session.id}]`);
      continue;
    }
    items.push(`- [${def.name}](item:${def.id})`);
  }

  const equippedLines: string[] = [];
  for (const [slot, id] of Object.entries(session.equipped)) {
    const def = id ? world.itemDefs.get(id) : null;
    equippedLines.push(`- **${slot}**: ${def ? `[${def.name}](item:${def.id})` : "*empty*"}`);
  }

  send(ws, {
    v: 1,
    id: randomUUID(),
    type: "system",
    timestamp: new Date().toISOString(),
    muddown: `:::system{type="inventory"}
# Inventory

${items.length > 0 ? items.join("\n") : "*Your inventory is empty.*"}

## Equipment

${equippedLines.join("\n")}
:::`,
  });
}

function handleEquip(ws: WebSocket, session: PlayerSession, arg: string): void {
  if (!arg) {
    send(ws, systemMessage("Equip what? Usage: `equip <item>`"));
    return;
  }

  const def = findItemByName(arg, session.inventory, world.itemDefs);
  if (!def) {
    send(ws, systemMessage(`You don't have **${arg}**.`));
    return;
  }

  if (!def.equippable || !def.slot) {
    send(ws, systemMessage(`The **${def.name}** can't be equipped.`));
    return;
  }

  // Unequip current item in that slot
  const currentId = session.equipped[def.slot];
  if (currentId === def.id) {
    send(ws, systemMessage(`The **${def.name}** is already equipped.`));
    return;
  }
  if (currentId) {
    const currentDef = world.itemDefs.get(currentId);
    send(ws, systemMessage(`You unequip the **${currentDef?.name ?? currentId}** and equip the **${def.name}**.`));
  } else {
    send(ws, systemMessage(`You equip the **${def.name}**.`));
  }

  session.equipped[def.slot] = def.id;
}

function handleUnequip(ws: WebSocket, session: PlayerSession, arg: string): void {
  if (!arg) {
    send(ws, systemMessage("Unequip what? Usage: `unequip <slot>` (weapon, armor, accessory)"));
    return;
  }

  const validSlots: EquipSlot[] = ["weapon", "armor", "accessory"];
  const lowered = arg.toLowerCase();
  const slot = validSlots.find((s) => s === lowered);
  if (!slot) {
    // Try to find by item name
    for (const [s, id] of Object.entries(session.equipped)) {
      if (!id) continue;
      const def = world.itemDefs.get(id);
      if (def && (def.id === lowered || def.name.toLowerCase() === lowered)) {
        session.equipped[s as EquipSlot] = null;
        send(ws, systemMessage(`You unequip the **${def.name}**.`));
        return;
      }
    }
    send(ws, systemMessage(`Invalid slot. Use: \`unequip weapon\`, \`unequip armor\`, or \`unequip accessory\`.`));
    return;
  }

  const currentId = session.equipped[slot];
  if (!currentId) {
    send(ws, systemMessage(`Nothing is equipped in the **${slot}** slot.`));
    return;
  }
  const def = world.itemDefs.get(currentId);
  session.equipped[slot] = null;
  send(ws, systemMessage(`You unequip the **${def?.name ?? currentId}**.`));
}

function handleUse(ws: WebSocket, session: PlayerSession, arg: string): void {
  if (!arg) {
    send(ws, systemMessage("Use what? Usage: `use <item>`"));
    return;
  }

  // Check inventory first, then room (for fixed usable items)
  const allItems = [...session.inventory, ...(world.roomItems.get(session.currentRoom) ?? [])];
  const def = findItemByName(arg, allItems, world.itemDefs);
  if (!def) {
    send(ws, systemMessage(`You don't see **${arg}** here and don't have it.`));
    return;
  }

  if (!def.usable) {
    send(ws, systemMessage(`You can't figure out how to use the **${def.name}**.`));
    return;
  }

  const effect = def.useEffect ?? "use";
  const messages: Record<string, string> = {
    eat: `You eat the **${def.name}**. Refreshing!`,
    light: `You light the **${def.name}**. It casts a warm glow.`,
    read: `You read the **${def.name}**. The words swim before your eyes...`,
    bless: `You use the **${def.name}**. A sense of peace washes over you.`,
    "look-through": `You look through the **${def.name}**. The view is breathtaking!`,
    fish: `You cast with the **${def.name}**. The line bobs gently in the water.`,
    use: `You use the **${def.name}**.`,
  };

  send(ws, {
    v: 1,
    id: randomUUID(),
    type: "narrative",
    timestamp: new Date().toISOString(),
    muddown: messages[effect] ?? messages["use"],
  });

  // Consumable items are removed after use
  const consumable = ["eat", "bless", "light"];
  if (consumable.includes(effect)) {
    const invIdx = session.inventory.indexOf(def.id);
    if (invIdx !== -1) {
      session.inventory.splice(invIdx, 1);
      send(ws, systemMessage(`The **${def.name}** is consumed.`));
    } else {
      const roomItems = world.roomItems.get(session.currentRoom);
      if (roomItems) {
        const roomIdx = roomItems.indexOf(def.id);
        if (roomIdx !== -1) {
          roomItems.splice(roomIdx, 1);
          send(ws, systemMessage(`The **${def.name}** is consumed.`));
        } else {
          console.error(`Consumable item ${def.id} not found in inventory or room ${session.currentRoom}`);
        }
      } else {
        console.error(`Consumable item ${def.id} not found in inventory or room ${session.currentRoom}`);
      }
    }
  }
}

function handleCombine(ws: WebSocket, session: PlayerSession, arg: string): void {
  // Expected format: "item1 with item2"
  const parts = arg.split(/\s+with\s+/i);
  if (parts.length !== 2) {
    send(ws, systemMessage("Usage: `combine <item> with <item>`"));
    return;
  }

  const [name1, name2] = parts.map((p) => p.trim());
  const allItems = [...session.inventory, ...(world.roomItems.get(session.currentRoom) ?? [])];
  const def1 = findItemByName(name1, allItems, world.itemDefs);
  const def2 = findItemByName(name2, allItems, world.itemDefs);

  if (!def1) {
    send(ws, systemMessage(`You don't see **${name1}** here and don't have it.`));
    return;
  }
  if (!def2) {
    send(ws, systemMessage(`You don't see **${name2}** here and don't have it.`));
    return;
  }

  // Find matching recipe
  const recipe = world.recipes.find(
    (r) =>
      (r.item1 === def1.id && r.item2 === def2.id) ||
      (r.item1 === def2.id && r.item2 === def1.id)
  );

  if (!recipe) {
    send(ws, systemMessage(`You can't figure out how to combine the **${def1.name}** with the **${def2.name}**.`));
    return;
  }

  const resultDef = world.itemDefs.get(recipe.result);
  if (!resultDef) {
    console.error(`Combine recipe result "${recipe.result}" not found in itemDefs (recipe: ${recipe.item1} + ${recipe.item2})`);
    send(ws, systemMessage("Something went wrong with that combination."));
    return;
  }

  // Pre-check: locate both ingredients before mutating any state
  const removalPlan: Array<{ id: string; source: "inventory"; index: number } | { id: string; source: "room"; array: string[]; index: number }> = [];
  const claimedInvIndices = new Set<number>();
  const claimedRoomIndices = new Set<number>();
  for (const ingredient of [def1.id, def2.id]) {
    const invIdx = findUnclaimedIndex(session.inventory, ingredient, claimedInvIndices);
    if (invIdx !== -1) {
      claimedInvIndices.add(invIdx);
      removalPlan.push({ id: ingredient, source: "inventory", index: invIdx });
    } else {
      const roomItems = world.roomItems.get(session.currentRoom);
      const roomIdx = roomItems ? findUnclaimedIndex(roomItems, ingredient, claimedRoomIndices) : -1;
      if (roomItems && roomIdx !== -1) {
        claimedRoomIndices.add(roomIdx);
        removalPlan.push({ id: ingredient, source: "room", array: roomItems, index: roomIdx });
      } else {
        console.error(`Combine ingredient "${ingredient}" not found in inventory or room ${session.currentRoom} [player=${session.id}]`);
        send(ws, systemMessage("Something went wrong removing an ingredient."));
        return;
      }
    }
  }

  // Both ingredients verified — remove in reverse index order to keep indices stable
  for (const entry of [...removalPlan].sort((a, b) => b.index - a.index)) {
    if (entry.source === "inventory") {
      session.inventory.splice(entry.index, 1);
    } else {
      entry.array.splice(entry.index, 1);
    }
  }

  // Add result to inventory
  session.inventory.push(resultDef.id);

  send(ws, {
    v: 1,
    id: randomUUID(),
    type: "narrative",
    timestamp: new Date().toISOString(),
    muddown: `${recipe.description}\n\nYou now have: **${resultDef.name}**`,
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

// ─── Persistence Helpers ─────────────────────────────────────────────────────

function saveCharacterSession(session: PlayerSession): void {
  if (!session.characterId) return;
  try {
    db.saveCharacterState(session.characterId, {
      currentRoom: session.currentRoom,
      inventory: session.inventory,
      equipped: session.equipped,
      hp: session.hp,
      maxHp: session.maxHp,
      xp: session.xp,
    });
  } catch (err) {
    console.error(
      `Failed to save character state [character=${session.characterId}] [name=${session.name}] [room=${session.currentRoom}] [inventory=${JSON.stringify(session.inventory)}]:`,
      err,
    );
  }
}

function saveAllState(): void {
  // Save all authenticated character sessions
  for (const [, session] of sessions) {
    saveCharacterSession(session);
  }
  // Save world state (independent try/catch so one failure doesn't block the other)
  try {
    db.saveAllRoomItems(world.roomItems);
  } catch (err) {
    console.error("Failed to save room items:", err);
  }
  try {
    db.saveAllNpcHp(npcHpMap);
  } catch (err) {
    console.error("Failed to save NPC HP:", err);
  }
}

// Auto-save timer
const saveTimer = setInterval(saveAllState, SAVE_INTERVAL_MS);

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function shutdown(): void {
  console.log("Shutting down — saving all state...");
  clearInterval(respawnTimer);
  clearInterval(saveTimer);
  saveAllState();
  db.cleanExpiredSessions();

  // Force exit if shutdown hangs (e.g., lingering connections)
  const forceExitTimer = setTimeout(() => {
    console.warn("Forced shutdown after timeout.");
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();

  // Close all WebSocket connections first
  for (const ws of wss.clients) {
    try {
      ws.close(1001, "Server shutting down");
    } catch (err) {
      console.warn("Error closing WebSocket during shutdown:", err);
    }
  }

  wss.close(() => {
    console.log("WebSocket server closed.");
    server.close(() => {
      console.log("HTTP server closed.");
      db.close();
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
