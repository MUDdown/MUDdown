# MUDdown Specification

**Version**: 0.1.0-draft  
**Status**: Draft  
**Date**: 2026-05-09

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

A world-scope broadcast (visible to every connected session and any subscribed external feed):

```markdown
:::system{type="notification" scope="world"}
**Server**: rebooting in 5 minutes.
:::
```

**Optional attributes**: `type`, `scope`

The `scope` attribute identifies the audience of the message and lets transports route it independently of its envelope `type`. The two are orthogonal: envelope `type` identifies the message category (`system` here, vs. `room`/`combat`/`dialogue`/`narrative`), while the container block's `scope` attribute controls audience routing within that category.

| Value | Audience | Examples |
|-------|----------|----------|
| `player` (default) | The single recipient session | `welcome`, `inventory`, `who`, `help`, `hint`, command output, error notifications |
| `world` | Every connected session, plus any subscribed external feed (Discord channel, IRC bridge, web feed) | Server boot/reboot, scheduled downtime, public quest completions, world-state announcements |

A system block with `scope="world"` MUST contain only information that is safe to share publicly; private gameplay (combat results, room narrative, OOC tells) MUST NOT use `scope="world"`. Ambiguous categories — login/logout notices, achievement announcements, level-up banners, death notices — sit between the two and are not normatively classified here; implementers SHOULD decide per-game policy and document it, then mark the resulting envelopes accordingly.

Transports that bridge to multi-user channels (e.g. a Discord server-wide feed channel) MUST publish only `scope="world"` envelopes to shared channels and MUST NOT publish `scope="player"` content to a shared channel without explicit per-channel opt-in. Clients that have no concept of a shared channel MAY render `scope="world"` and `scope="player"` identically; clients that do distinguish them SHOULD render `scope="world"` messages with a visible broadcast indicator (icon, badge, color, or prefix) so users can tell a global announcement from a per-player notification at a glance.

Unknown `scope` values MUST be treated as `player` so a forward-compatible client never accidentally broadcasts.

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
| `system` | S→C | Server notifications. The block's `scope` attribute (see §3.6) determines the audience: `player` (default, single recipient) or `world` (broadcast-eligible). |
| `narrative` | S→C | Freeform story text |
| `command` | C→S | Player command |
| `input` | C→S | Dialogue/prompt response |
| `ping`/`pong` | Both | Keepalive |

### 6.3 Endpoints

A MUDdown server MAY expose the following WebSocket endpoints on its
HTTP listener:

| Path | Direction | Auth | Description |
|------|-----------|------|-------------|
| `/` (or `/?ticket=…`) | Both | Required (single-use ticket) | Authenticated gameplay channel. The full envelope set in §6.2 flows here. |
| `/feed` | S→C only | None (read-only) | Optional public feed. The server MUST emit only `:::system{scope="world"}` envelopes (§3.6) on this endpoint. Inbound data frames from a `/feed` client are a protocol violation; the server SHOULD close such connections with WebSocket close code `1003` (Unsupported Data). |

Servers exposing `/feed` SHOULD apply per-IP and global concurrent-connection
caps and a periodic ping/pong keepalive, since the endpoint is unauthenticated
and otherwise vulnerable to socket-exhaustion DoS. Multi-user transports that
subscribe to `/feed` (Discord bridge, IRC bridge, etc.) MUST re-validate
`scope="world"` on every received envelope rather than trust the endpoint
contract alone.

#### Transport Security

Production servers MUST expose both endpoints over TLS (`wss://`). Plain `ws://`
is permitted for local development only and MUST NOT be used in production:
the gameplay endpoint carries authentication tickets and command input, and
`/feed` carries unsigned world events that downstream bridges may republish.

#### 6.3.1 Single-Use Ticket Authentication

The gameplay endpoint authenticates each WebSocket upgrade with a single-use
ticket because browsers cannot attach `Authorization` headers to the upgrade
request. The flow is:

1. **Acquire.** The client first establishes an authenticated HTTPS session
   (cookie or bearer token) via the server's normal auth flow, then issues
   `GET /auth/ws-ticket`. The server SHOULD rate-limit this endpoint per
   account.
2. **Format.** A ticket is an opaque server-generated string with at least 122
   bits of entropy (e.g. a UUIDv4 or equivalent CSPRNG token). Clients MUST
   treat it as opaque.
3. **Expiry.** Tickets MUST expire within a short window (RECOMMENDED 60
   seconds) and the server MUST reject expired tickets.
4. **Single use.** The server MUST consume the ticket atomically on the
   WebSocket upgrade — successful or not — so it cannot be replayed. Reuse
   MUST be rejected.
5. **Validation.** On the upgrade request the server reads the ticket from
   the `?ticket=…` query parameter, verifies it exists, has not expired, and
   matches the character bound at issuance. Invalid, expired, missing, or
   already-consumed tickets MUST cause the upgrade to fail (HTTP 401) or, if
   the upgrade has already completed, the WebSocket to close with code
   `4401` (or `1008` Policy Violation).
6. **Post-consumption.** Once consumed, the WebSocket connection is the
   authenticated session — no per-frame re-auth is required for its
   lifetime. Closing the WebSocket ends the gameplay session; reconnecting
   requires a fresh ticket.

`/feed` is exempt from this scheme: it is unauthenticated read-only and any
inbound data frame from a `/feed` client is a protocol violation that the
server MUST close with WebSocket close code `1003` (Unsupported Data) as
specified in the table above.

**Anonymous guest session.** A session whose ticket binds the connection to
no *persistent character ID*. The ticket MAY carry an ephemeral session
identifier (used for rate-limiting and journal correlation) but that
identifier is scoped to a single WebSocket lifetime and is discarded when
the connection closes. Servers MUST distinguish at ticket-issuance time
between (a) a persistent character ID — a stable handle that survives
disconnects and identifies the same player across sessions — and (b) an
ephemeral guest session ID. Guest sessions do not participate in the
concurrent-session policy of §6.3.3: they MUST NOT displace any other
session and MUST NOT receive close code `4002`. Subsequent sections refer
to this definition when they say "anonymous guest session" or "guest".

#### 6.3.2 DoS Mitigations

Both endpoints SHOULD implement defense-in-depth controls. The values below
are interoperable defaults — implementations MAY tune them but SHOULD stay
within the same order of magnitude so clients written against one server
behave reasonably on another.

**`/feed` (unauthenticated):**

- *Per-IP concurrent-connection cap:* RECOMMENDED 8. Reject excess upgrades
  with WebSocket close code `1013` (Try Again Later).
- *Global concurrent-connection cap:* RECOMMENDED 100 (tune for capacity).
  Reject excess upgrades with `1013`.
- *Cap value `0` or negative:* SHOULD be interpreted as "no limit" so an
  accidental misconfiguration does not deny all traffic.
- *Server→client ping interval:* RECOMMENDED 30 s (range 30–60 s).
- *Client pong timeout:* RECOMMENDED 90 s (3× ping interval). After 2
  consecutive missed pongs the server SHOULD close with `1011` and reclaim
  the slot.
- *Inbound data frame:* protocol violation; close with `1003` per §6.3.

**`/` (authenticated gameplay):**

- *Per-session command throughput:* RECOMMENDED token-bucket of **burst 20,
  refill 5 commands/s**. Excess `command` and `input` envelopes SHOULD be
  dropped with a `:::system{type="warning"}` envelope rather than closing
  the connection — a player smashing keys should not be disconnected.
- *Backpressure:* if the outbound buffer for a session exceeds an
  implementation-defined high-water mark, the server SHOULD pause command
  processing for that session until the buffer drains, and MAY close with
  `1009` (Message Too Big) or `1011` if the client never reads.
- *Circuit breaker for downstream services* (LLM hint generation, database,
  external APIs): on repeated failure the server SHOULD short-circuit to a
  static fallback rather than queue requests indefinitely.
- *Ticket-issuance rate limit:* `GET /auth/ws-ticket` SHOULD be rate-limited
  per account (RECOMMENDED 5 tickets / 60 s).

These defaults match a single-server deployment of a few hundred concurrent
players. Servers operating at larger scale or behind an L7 load balancer
SHOULD enforce caps at both layers.

#### 6.3.3 Session Lifecycle Close Codes

In addition to the standard WebSocket close codes referenced above, MUDdown
defines the following close codes in the application range (4000–4999) for
gameplay-session lifecycle events on the `/` endpoint. Conformant clients
MUST recognize these codes on `WebSocket.onclose` and behave as specified.

| Code | Name | Direction | Client behavior |
|------|------|-----------|------------------|
| `4001` | `WS_CLOSE_QUIT` | S→C | Player explicitly quit (`quit` command). Client MUST NOT auto-reconnect. |
| `4002` | `WS_CLOSE_DISPLACED` | S→C | The server bound the player's character to a *different* connection (see concurrent-session policy below). Client MUST NOT automatically attempt to reconnect; any subsequent reconnect MUST obtain a fresh ws-ticket per §6.3.1. Client SHOULD display the accompanying notice as a persistent, user-dismissible message (shown until the user acknowledges or navigates away) rather than a transient toast, so the player understands why the session ended. Client MAY re-issue `connect()` with a fresh ticket if the user explicitly chooses to reclaim. |

**Concurrent-session policy.** A character (identified by its persistent
character ID) MUST be bound to at most one active WebSocket on a given
server. When a new connection authenticates with a character ID that is
already bound to an existing connection, the server:

1. SHOULD persist the existing session's mutable state (current room,
   inventory, HP, etc.) before evicting it.
2. MUST send the existing connection a final
   `:::system{type="notification" scope="player"}` envelope explaining the
   displacement before closing the WebSocket, so the player sees a reason
   rather than a silent drop. The send is best-effort: if the transport
   has already failed (the underlying socket is no longer writable) the
   server MAY skip step 2 and proceed directly to step 3, but it MUST NOT
   omit the notice for any other reason.
3. MUST close the existing connection with code `4002`
   (`WS_CLOSE_DISPLACED`).
4. MUST bind the character to the new connection.

Servers MAY instead reject the *new* connection (e.g. with `4002` to the
new connection and a notice to the existing one) if their policy is
"first-in wins" rather than "last-in wins"; the displacement code carries
the same semantics in either direction. The "last-in wins" pattern is
RECOMMENDED because it lets a player recover from a stuck client (e.g. a
crashed terminal that the server still sees as connected) by simply
logging in again.

**Client guidance for `4002`.** Because the same code is sent under both
policies, the client cannot tell from the close code alone whether *its*
session was the displaced one or whether it was rejected at login. The
distinguishing signal is which connection lifecycle phase the close
arrives in:

- *Close arrives on a previously-open session* (i.e. after `onOpen` has
  fired): the server is "last-in wins" and another client just took the
  character. Surface a notice such as "Your character was claimed by
  another connection" and do **not** auto-reconnect — auto-reconnecting
  would race the new client and ping-pong the character. The user MAY
  reclaim the session by an explicit action (e.g. a "Reconnect" button
  that re-issues `connect()` with a fresh ticket).
- *Close arrives during the initial handshake* (before any gameplay
  envelopes are received): the server is "first-in wins" and refused this
  login because the character is already in use elsewhere. Surface a
  notice such as "This character is already logged in from another
  client" and do **not** retry automatically. The user MAY retry after
  ending the other session.

In both cases the client MUST NOT treat `4002` as a transient failure
eligible for the standard reconnect-with-backoff path.

Anonymous guest sessions (as defined in §6.3.1) are exempt — guests
do not displace each other and MUST NOT receive `4002`.

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
