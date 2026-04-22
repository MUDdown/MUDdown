---
name: muddown-format
description: Understand the MUDdown markup format — the extended Markdown syntax used for all game output. Covers container blocks, interactive link schemes, wire protocol envelopes, ARIA roles, and conformance levels.
---

# MUDdown Format Skill

You are working with MUDdown, the extended Markdown format used as the universal game markup language. All server output must comply with the MUDdown specification at `packages/spec/SPECIFICATION.md`.

## Container Blocks

Container blocks wrap content in fenced directives:

```markdown
:::type{attr="value" attr2="value2"}
Content goes here.
:::
```

### Block Types

| Type | Purpose | ARIA Role |
|------|---------|-----------|
| `room` | Room descriptions | `role="main"` |
| `system` | System messages | `role="alert"` |
| `combat` | Combat output | `role="log"` + `aria-live="polite"` |
| `dialogue` | NPC dialogue | `role="group"` + `aria-label="NPC dialogue"` |
| `item` | Item descriptions | — |
| `npc` | NPC descriptions | — |
| `map` | Map display | — |

### Room Block Attributes

```markdown
:::room{id="town-square" region="northkeep" lighting="bright"}
```

### System Block Attributes

```markdown
:::system{type="notification"}
You picked up the **rusty key**.
:::
```

System types: `"welcome"`, `"notification"`, `"help"`, `"who"`, `"inventory"`

### Dialogue Block Attributes

```markdown
:::dialogue{npc="crier" mood="enthusiastic"}
```

## Interactive Link Schemes

MUDdown extends standard Markdown links with game-specific URI schemes:

| Scheme | Purpose | Example |
|--------|---------|---------|
| `go:` | Movement | `[North](go:north)` |
| `cmd:` | Execute command | `[Look around](cmd:look)` |
| `item:` | Item reference | `[rusty key](item:rusty-key)` |
| `npc:` | NPC reference | `[town crier](npc:crier)` |
| `player:` | Player mention | `[@Alice](player:alice)` |
| `help:` | Help topic | `[commands](help:commands)` |
| `url:` | External URL | `[website](url:https://example.com)` |

The web client in `apps/website/src/pages/play.astro` handles these links:
- `go:` → sends `go <direction>` command
- `cmd:` → sends the command directly
- `item:` → sends `examine <target>` command
- `npc:` → sends `talk <target>` command
- `help:` → sends `help <topic>` command

### Mapping to OSC 8 for Legacy MUD Clients

The telnet bridge can translate these link schemes into OSC 8 hyperlinks that MUD clients implementing the Mudlet OSC 8 extensions (Mudlet, Fado, MudForge, …) render as native clickable links. The client must advertise the capability via NEW-ENVIRON USERVAR; the bridge then emits:

```
ESC]8;;send:<command>[?config=<percent-encoded-JSON>]ESC\<display text>ESC]8;;ESC\
```

- **`send:`** is Mudlet's URI scheme meaning "execute this command on click". Spaces inside the command are preserved literally (the renderer's word-wrap treats the whole envelope as atomic, so a raw space does not become a wrap point).
- **`prompt:`** is the companion scheme meaning "insert this text into the input line but don't send". Used for `player:` menu entries (e.g. `prompt:tell Alice ` — the trailing space is intentional so the user can finish typing).
- **`?config=<JSON>`** carries optional `tooltip` (string) and `menu` (array of `{ Label: "scheme:cmd" }` with `"-"` as separator). Per-scheme defaults live in `buildLinkMetadata` in `packages/client/src/terminal-renderer.ts`.

When adding or modifying this mapping, follow the `osc8-bridge` skill — the pipeline spans telnet negotiation, renderer output, and word-wrap correctness, and every config string must be run through `sanitizeConfigString` (C0/C1 strip + 200 code-point cap) to stay inside Mudlet's 4096-byte URL limit and never emit an ESC inside the envelope.

## Wire Protocol

All server→client messages are JSON envelopes:

```json
{
  "v": 1,
  "id": "uuid",
  "type": "room",
  "timestamp": "2026-03-28T12:00:00.000Z",
  "muddown": ":::room{id=\"town-square\"}\n# Town Square\n..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `v` | number | Protocol version (always `1`) |
| `id` | string | UUID for this message |
| `type` | string | Message type: `room`, `system`, `narrative`, `combat`, `dialogue` |
| `timestamp` | string | ISO 8601 timestamp |
| `muddown` | string | MUDdown markup content |

Client→server messages:

```json
{
  "v": 1,
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "command",
  "timestamp": "2026-03-28T12:00:00.000Z",
  "command": "go north"
}
```

## Markdown Formatting in MUDdown

Standard Markdown formatting works inside container blocks:

- `**bold**` for emphasis
- `*italic*` for narrative/mood text
- `` `code` `` for commands or game terms
- `# H1` for block titles and `## H2` for sections (the parser splits on H2 headings)
- `- item` for unordered lists (exits, items, NPCs)
- `> blockquote` for quoted text
- `| table |` for tabular data

## Accessibility

The spec requires ARIA role mapping. The web client applies these roles to rendered HTML. When creating new container block types or modifying rendering, maintain these mappings:

- `room` → `role="main"`
- `system` → `role="alert"`
- `combat` → `role="log"` with `aria-live="polite"`
- `dialogue` → `role="group"` with `aria-label="NPC dialogue"`

## Common Pitfalls

1. **Unclosed container blocks** — every `:::type{...}` must have a matching `:::` close.
2. **Invalid link schemes** — only the seven defined schemes are valid.
3. **Missing `muddown` field** — every server envelope must include the `muddown` string.
4. **Raw HTML in MUDdown** — do not include HTML; the client renders from Markdown.
5. **Escaping in links** — use `escapeMarkdownLinkLabel()` and `escapeMarkdownLinkDest()` from `packages/server/src/helpers.ts` when interpolating dynamic content into links.
