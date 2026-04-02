# MUDdown Specification

**Version**: 0.1.0-draft  
**Status**: Draft  
**Date**: 2026-03-28

## 1. Introduction

MUDdown is an extended Markdown format for describing interactive text-based game worlds. It is designed to be:

1. **Human-readable** as plain text
2. **Machine-parseable** for game clients and AI agents
3. **Backward-compatible** with CommonMark Markdown
4. **Accessible** to screenreaders without transformation

A MUDdown document is valid Markdown. Any standard Markdown renderer will produce a reasonable output. MUDdown-aware clients unlock interactive features: clickable commands, structured game state, and semantic understanding of rooms, NPCs, items, and events.

## 2. Design Principles

- **Text is the truth**: The Markdown source is the canonical representation. Visual rendering is a presentation layer.
- **Progressive enhancement**: A terminal that renders plain Markdown is a valid MUDdown client. Richer clients add interactivity.
- **Semantic over decorative**: Use structure (headings, lists, attributes) rather than visual styling to convey meaning.
- **AI-legible**: All game constructs are expressible as structured data that LLMs and tool-calling agents can parse and act on.

## 3. Container Blocks

MUDdown uses fenced container blocks (inspired by markdown-it-container and GFM admonitions) to denote game constructs. A container block starts with `:::type{attributes}` and ends with `:::`.

### 3.1 Room Block

```markdown
:::room{id="iron-gate" region="northkeep" lighting="dim" visited=true}
# The Iron Gate

A massive portcullis of blackened iron bars the passage north.
The mechanism is **rusted**, but [fresh oil glistens on the gears](cmd:examine gears).

## Exits
- [North](go:north) *(blocked)*
- [South](go:south) — Courtyard
- [Up](go:up) — Guard tower

## Present
- [@Tharion](player:tharion) is here, studying the mechanism.
- A [sleeping guard](npc:guard-7) slumps against the wall.

## Items
- A [rusty key](item:rusty-key) lies in the dust.
:::
```

**Required attributes**: `id`  
**Optional attributes**: `region`, `lighting`, `visited`, `terrain`, `tags`

**Conventional sections** (H2 headings inside the block):
| Section | Purpose |
|---------|---------|
| Exits | Available movement directions |
| Present | Players and NPCs in the room |
| Items | Objects that can be interacted with |

### 3.2 NPC Block

```markdown
:::npc{id="guard-7" name="Town Guard" disposition="neutral" hp=30 max-hp=30}
A stocky dwarf in dented chainmail. He appears to be sleeping off last night's ale.

## Dialogue
- [Ask about the gate](cmd:ask guard about gate)
- [Wake him up](cmd:wake guard)

## Inventory
- Iron shortsword
- 3 copper coins
:::
```

### 3.3 Item Block

```markdown
:::item{id="rusty-key" name="Rusty Key" weight=0.1 rarity="common"}
A small iron key, orange with rust. It might still turn a lock.

## Properties
- **Type**: Key
- **Condition**: Poor
- **Fits**: [Iron Gate lock](item:iron-gate-lock)
:::
```

### 3.4 Combat Block

```markdown
:::combat{round=3 initiative="player:tharion,npc:guard-7"}
## Round 3

**@Tharion** swings a longsword at the **Town Guard**...
*Roll: 14 + 3 = 17 vs AC 15* — **Hit!**
Damage: 8 slashing → Guard HP: 22/30

The **Town Guard** retaliates with an iron shortsword...
*Roll: 7 + 2 = 9 vs AC 16* — **Miss!**
:::
```

### 3.5 Dialogue Block

```markdown
:::dialogue{npc="guard-7" mood="groggy"}
> "Wha—? Who goes there?"

The guard blinks and reaches for his sword.

## Responses
- ["I'm a friend."](cmd:say I'm a friend) — *Persuasion DC 12*
- ["None of your business."](cmd:say None of your business) — *Intimidation DC 15*
- [Attack](cmd:attack guard)
:::
```

### 3.6 System Block

```markdown
:::system{type="notification"}
**Server**: Welcome to *Northkeep*. Type `help` for a list of commands.
:::
```

### 3.7 Map Block

````markdown
:::map{region="northkeep" format="ascii"}
```
     [Guard Tower]
          |
    [Courtyard] -- [Stables]
          |
   >[Iron Gate]<
          |
     [North Road]
```
:::
````

## 4. Interactive Links

MUDdown extends Markdown link syntax to encode game commands. The URL scheme determines the action type.

| Scheme | Purpose | Example |
|--------|---------|---------|
| `cmd:` | Execute arbitrary command | `[open chest](cmd:open chest)` |
| `go:` | Move in a direction | `[North](go:north)` |
| `item:` | Reference an item | `[Rusty Key](item:rusty-key)` |
| `npc:` | Reference an NPC | `[sleeping guard](npc:guard-7)` |
| `player:` | Reference a player | `[@Tharion](player:tharion)` |
| `help:` | Open help topic | `[combat basics](help:combat)` |
| `url:` | External hyperlink | `[wiki](url:https://muddown.com/wiki)` |

Links without a recognized scheme are treated as standard Markdown links.

### 4.1 Player Mentions

Players are referenced with the `@` prefix in display text: `[@Username](player:username)`. Clients SHOULD highlight mentions of the current player.

## 5. Metadata Block

A YAML frontmatter block at the top of a MUDdown document provides machine-readable metadata:

```markdown
---
muddown: 0.1.0
server: Northkeep
region: northkeep
timestamp: 2026-03-27T10:30:00Z
message-type: room-enter
---
```

## 6. Wire Protocol

MUDdown messages are transmitted over WebSocket as JSON envelopes containing MUDdown content:

```json
{
  "v": 1,
  "id": "msg-uuid",
  "type": "room",
  "timestamp": "2026-03-27T10:30:00Z",
  "muddown": ":::room{id=\"iron-gate\"}\n# The Iron Gate\n...\n:::",
  "meta": {
    "room_id": "iron-gate",
    "region": "northkeep"
  }
}
```

### 6.1 Client-to-Server Messages

```json
{
  "v": 1,
  "id": "cmd-uuid",
  "type": "command",
  "timestamp": "2026-03-27T10:30:01Z",
  "command": "go north",
  "args": ["north"]
}
```

### 6.2 Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `room` | S→C | Room description |
| `combat` | S→C | Combat round update |
| `dialogue` | S→C | NPC dialogue |
| `system` | S→C | Server notifications |
| `narrative` | S→C | Freeform story text |
| `command` | C→S | Player command |
| `input` | C→S | Dialogue/prompt response |
| `ping`/`pong` | Both | Keepalive |

## 7. AI Integration Hooks

### 7.1 Tool-Calling Schema

Every interactive link in a MUDdown document maps to a callable tool:

```json
{
  "name": "game_command",
  "description": "Execute a game command",
  "parameters": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "The command to execute" }
    },
    "required": ["command"]
  }
}
```

### 7.2 MCP Resource Exposure

Game state is exposed as MCP resources:

- `muddown://room/current` — Current room as MUDdown
- `muddown://player/inventory` — Player inventory
- `muddown://player/stats` — Player statistics
- `muddown://world/map` — Known map graph
- `muddown://help/{topic}` — Help documentation

### 7.3 Context Window Format

For AI agents, the current game state can be serialized as a single MUDdown document:

```markdown
---
muddown: 0.1.0
context: player-state
player: Tharion
---

:::room{id="iron-gate"}
# The Iron Gate
...
:::

:::player{id="tharion" hp=45 max-hp=50 class="fighter" level=5}
## Inventory
- Longsword (equipped)
- 12 gold coins
- Rusty Key

## Active Effects
- **Torch light** (3 hours remaining)
:::
```

## 8. Accessibility

- Container block types map to ARIA landmarks/roles
- Room blocks → `role="main"`
- Dialogue blocks → `role="group"` with `aria-label="NPC dialogue"`
- Combat blocks → `role="log"` with `aria-live="polite"`
- System blocks → `role="alert"`
- Interactive links include descriptive text suitable for screenreaders
- Clients MUST NOT rely solely on color or visual formatting to convey game information

## 9. Extensibility

Custom container blocks are permitted using the `x-` prefix:

```markdown
:::x-crafting{station="forge" skill="blacksmithing"}
...
:::
```

Unknown block types MUST be rendered as blockquote-styled containers by conforming clients, preserving their inner Markdown content.

## 10. Conformance Levels

| Level | Requirements |
|-------|-------------|
| **MUDdown Text** | Renders all content as valid Markdown. Ignores container attributes and link schemes. |
| **MUDdown Interactive** | Parses container blocks and interactive links. Executes `cmd:` and `go:` links as game commands. |
| **MUDdown Full** | Supports wire protocol, AI hooks, accessibility roles, and federation. |

---

*This specification is a living document. Contributions welcome via pull request.*
