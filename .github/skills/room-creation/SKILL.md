---
name: room-creation
description: Create and modify MUDdown room files. Covers the Markdown+YAML structure, frontmatter fields, container blocks, bidirectional exits, item/NPC references, lighting, and region organization.
---

# Room Creation Skill

You are creating room files for the MUDdown game server. Room files are Markdown documents with YAML frontmatter that define world locations.

## File Location

Room files live in `packages/server/world/<region>/<room-id>.md`. Regions are subdirectories (can be nested). The loader walks the directory tree recursively, skipping `items/`, `npcs/`, and files not ending in `.md`.

## Room File Structure

Every room file has two parts: YAML frontmatter and a `:::room` container block.

```markdown
---
id: room-id
region: region-name
lighting: bright
connections:
  north: target-room-id
  south: other-room-id
items:
  - item-id-1
  - item-id-2
---
:::room{id="room-id" region="region-name" lighting="bright"}
# Room Title

Narrative description of the room.

## Exits
- [North](go:north) — Description of destination
- [South](go:south) — Description of destination

## Present
- A [town crier](npc:crier) stands near the fountain.

## Items
- A [rusty key](item:rusty-key) lies in the dust.
:::
```

## Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique room identifier. Must match the `id` in `:::room{id=...}` |
| `region` | Yes | Region name (matches the subdirectory name or a logical grouping) |
| `lighting` | Optional | Freeform string. Conventional values: `bright`, `dim`, `dark`, `fiery`, `warm`, `overcast`, `ethereal` |
| `connections` | Optional | Map of direction → target room ID |
| `items` | Optional | Array of item IDs to place in this room at load time |

## Bidirectional Exit Rule

**All exits must be bidirectional.** If room A connects north to room B, then room B must connect south to room A. The `world-integrity.test.ts` suite enforces this across all production room files.

Direction opposites:
- north ↔ south
- east ↔ west
- up ↔ down
- northeast ↔ southwest
- northwest ↔ southeast

## Container Block Attributes

The `:::room{...}` opening fence must include:
- `id` — must match frontmatter `id`
- `region` — must match frontmatter `region`
- `lighting` — must match frontmatter `lighting` (omit both if the room has no lighting value)

## Section Conventions

| Section | Purpose |
|---------|---------|
| `# Room Title` | H1 heading is the room's display name |
| (paragraph) | Narrative description, plain prose |
| `## Exits` | List of `[Direction](go:direction) — Description` links |
| `## Present` | NPCs in the room, using `[Name](npc:id)` links |
| `## Items` | Static template of items; dynamically replaced at runtime |

## Link Schemes

- `go:north` — Movement links (used in Exits section)
- `npc:id` — NPC reference links (used in Present section)
- `item:id` — Item reference links (used in Items section)
- `cmd:command` — Arbitrary command links (e.g., `cmd:examine anvil`)

## Region Organization

Current regions in `packages/server/world/northkeep/`:

| Region | Subdirectory | Rooms |
|--------|-------------|-------|
| northkeep | `northkeep/` (root) | town-square, iron-gate, guard-tower, bakery, docks, temple |
| market | `northkeep/market/` | market-entrance, market-square, jeweler, blacksmith |
| harbor | `northkeep/harbor/` | warehouse, pier, lighthouse, smugglers-cove |
| northroad | `northkeep/northroad/` | north-road, crossroads, old-farm, forest-edge, deep-forest, ruins-entrance, ruins-hall |
| catacombs | `northkeep/catacombs/` | catacombs-entrance, ossuary, sealed-chamber |

## Complete Example

```markdown
---
id: blacksmith
region: market
lighting: fiery
connections:
  north: market-square
items:
  - shortsword
  - tongs
---
:::room{id="blacksmith" region="market" lighting="fiery"}
# Blacksmith's Forge

Waves of heat roll from the open forge. An enormous bellows creaks
rhythmically, feeding the coals to a white-hot glow. Racks of horseshoes,
nails, and blades line the soot-stained walls.

## Exits
- [North](go:north) — Market Square

## Present
- [Gorath](npc:gorath), the blacksmith, hammers a glowing blade.

## Items
- A [dull shortsword](item:shortsword) leans against the wall.
- A pair of [tongs](item:tongs) rests on the workbench.
:::
```

## Common Pitfalls

1. **Mismatched IDs** — frontmatter `id` and `:::room{id=...}` must be identical.
2. **Missing opposite exit** — every connection must have a reciprocal entry in the target room.
3. **Items not in items/ directory** — frontmatter `items:` references IDs that must have matching JSON files in `world/items/`.
4. **NPCs without definitions** — NPC IDs in `## Present` should have matching JSON files in `world/npcs/` with `location` set to this room's ID.
5. **Forgetting the closing `:::`** — container blocks must close with `:::` on its own line.
