---
name: npc-creation
description: Create and modify NPCs with branching dialogue trees for MUDdown. Covers the JSON format, dialogue node structure, location binding, mood/narrative fields, and the talk command flow.
---

# NPC Creation Skill

You are creating NPC definitions with dialogue trees for the MUDdown game server. NPCs are JSON files that define characters players can interact with via the `talk` command.

## File Location

NPC definitions: `packages/server/world/npcs/<npc-id>.json`

The `npc-id` in the filename must match the `id` field inside the JSON.

## NPC JSON Schema

```json
{
  "id": "npc-id",
  "name": "Display Name",
  "description": "Text shown when player examines the NPC.",
  "location": "room-id",
  "dialogue": {
    "start": {
      "text": "Greeting text when player talks to the NPC.",
      "mood": "friendly",
      "narrative": "Action description in third person.",
      "responses": [
        { "text": "Player choice text", "next": "node-id" },
        { "text": "Goodbye", "next": null }
      ]
    }
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier, matches filename |
| `name` | string | Yes | Display name shown to players |
| `description` | string | Yes | Examination text |
| `location` | string | Yes | Room ID where this NPC appears |
| `dialogue` | object | Yes | Map of node IDs to dialogue nodes |

## Dialogue Node Structure

Each dialogue node has:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | What the NPC says |
| `mood` | string | No | Emotional tone (e.g., `"friendly"`, `"worried"`, `"conspiratorial"`) |
| `narrative` | string | No | Third-person action description; supports Markdown (use `*...*` for italics) |
| `responses` | array | Yes | Player response choices |

Each response has:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Text shown as a clickable choice |
| `next` | string \| null | Yes | Next dialogue node ID, or `null` to end conversation |

## Required: The "start" Node

Every NPC **must** have a `"start"` dialogue node. The loader validates this and skips NPCs without one. The `talk` command begins at the `"start"` node.

## MUDdown Output

When a player talks to an NPC, the server emits a `:::dialogue` block:

```markdown
:::dialogue{npc="crier" mood="enthusiastic"}
> "Hear ye, hear ye! Welcome to Northkeep, traveller! What news do you seek?"

*The town crier straightens his cap and peers at you expectantly.*

## Responses
- ["What's happening in town?"](cmd:talk crier news)
- ["Where should I go?"](cmd:talk crier directions)
- ["Never mind."](cmd:talk crier end)
:::
```

Response links use `cmd:talk <npc-id> <next-node>` or `cmd:talk <npc-id> end` when `next` is `null`.

## Referencing NPCs in Rooms

Add the NPC to the room's `## Present` section:

```markdown
## Present
- A [town crier](npc:crier) stands near the fountain, ringing a bell.
```

The NPC's `location` field must match the room's `id`. The `world-integrity.test.ts` suite validates this cross-reference.

## Name Matching

The `talk` command uses fuzzy matching (via `findNpcInRoom` in `helpers.ts`):

1. **Exact match** — ID or full name matches query exactly
2. **Partial match** — ID or name contains the query as a substring

All comparisons are case-insensitive.

## Complete Example

```json
{
  "id": "crier",
  "name": "Town Crier",
  "description": "A stout man in a feathered cap, clutching a brass bell and a scroll of announcements.",
  "location": "town-square",
  "dialogue": {
    "start": {
      "text": "Hear ye, hear ye! Welcome to Northkeep, traveller! What news do you seek?",
      "mood": "enthusiastic",
      "narrative": "The town crier straightens his cap and peers at you expectantly.",
      "responses": [
        { "text": "What's happening in town?", "next": "news" },
        { "text": "Where should I go?", "next": "directions" },
        { "text": "Never mind.", "next": null }
      ]
    },
    "news": {
      "text": "Strange lights have been seen near the old ruins to the north!",
      "mood": "conspiratorial",
      "narrative": "He leans in and lowers his voice.",
      "responses": [
        { "text": "Tell me more.", "next": "ruins" },
        { "text": "Thanks for the news.", "next": null }
      ]
    },
    "ruins": {
      "text": "Old Eltharan ruins, they are. The priestess at the temple knows more.",
      "mood": "worried",
      "narrative": "The crier glances nervously northward.",
      "responses": [
        { "text": "I'll look into it.", "next": null }
      ]
    },
    "directions": {
      "text": "The market lies to the east. South leads to the docks. North to the Iron Gate.",
      "mood": "helpful",
      "narrative": "He gestures grandly in each direction.",
      "responses": [
        { "text": "Thanks for the directions.", "next": null }
      ]
    }
  }
}
```

## Dialogue Tree Design Tips

- Keep trees **shallow** (2-3 levels deep) to avoid player frustration.
- Always provide a "goodbye" or "never mind" option with `"next": null`.
- Use `mood` to convey tone — the client can style dialogue differently based on mood.
- Use `narrative` for action descriptions — these are italicized in the output.
- Cross-reference other NPCs/locations in dialogue `text` to build world connections.
- Node IDs should be short, descriptive kebab-case: `"news"`, `"smugglers"`, `"ask-about-ruins"`.

## Validation

The world loader checks:
1. `id`, `name`, `description`, `location` are all strings.
2. `dialogue` is an object with at least a `"start"` node.
3. Each node has `text` (string) and `responses` (array).
4. Each response has `text` (string) and `next` (string or null).
5. The `location` room exists in the loaded world.

NPCs that fail validation are skipped with a console warning.

## Common Pitfalls

1. **Missing `"start"` node** — the NPC will be skipped with a console warning.
2. **`location` points to nonexistent room** — the NPC still loads at runtime, but `world-integrity.test.ts` will catch this as a failing test. Fix before merging.
3. **Dangling `next` references** — a response pointing to `"foo"` but no `"foo"` node exists causes a runtime warning when the player selects it.
4. **Filename/ID mismatch** — `crier.json` must contain `"id": "crier"`.
5. **Forgetting to add NPC to room's `## Present`** — the NPC exists but won't appear in room descriptions.
