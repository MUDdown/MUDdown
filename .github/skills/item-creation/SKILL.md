---
name: item-creation
description: Create and modify item definitions for MUDdown. Covers the JSON format, equippable slots, usable effects, fixed items, combine recipes, and frontmatter references.
---

# Item Creation Skill

You are creating item definitions for the MUDdown game server. Items are JSON files that define objects players can interact with.

## File Location

- Individual items: `packages/server/world/items/<item-id>.json`
- Combine recipes: `packages/server/world/recipes.json`

The `item-id` in the filename must match the `id` field inside the JSON.

## Item JSON Schema

Every item has these base fields:

```json
{
  "id": "string",
  "name": "Display Name",
  "description": "Text shown when player examines the item.",
  "weight": 0.5,
  "rarity": "common",
  "fixed": false,
  "equippable": false,
  "usable": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier, matches filename |
| `name` | string | Yes | Display name shown to players |
| `description` | string | Yes | Examination text |
| `weight` | number | Yes | Weight in arbitrary units |
| `rarity` | string | Yes | `"common"`, `"uncommon"`, `"rare"`, or `"legendary"` |
| `fixed` | boolean | Yes | If `true`, item cannot be picked up |
| `equippable` | boolean | Yes | If `true`, item can be equipped |
| `usable` | boolean | Yes | If `true`, item can be used |

## Equippable Items

When `"equippable": true`, add:

```json
{
  "equippable": true,
  "slot": "weapon"
}
```

Valid slots: `"weapon"`, `"armor"`, `"accessory"`

**Example — Shortsword:**
```json
{
  "id": "shortsword",
  "name": "Dull Shortsword",
  "description": "A short blade with a nicked edge. It needs sharpening, but it's still steel.",
  "weight": 1.5,
  "rarity": "common",
  "fixed": false,
  "equippable": true,
  "slot": "weapon",
  "usable": false
}
```

## Usable Items

When `"usable": true`, add:

```json
{
  "usable": true,
  "useEffect": "eat"
}
```

Valid effects: `"eat"`, `"light"`, `"read"`, `"bless"`, `"fish"`, `"look-through"`

**Example — Bread:**
```json
{
  "id": "bread",
  "name": "Loaf of Bread",
  "description": "A warm loaf of crusty bread, fresh from the oven. It smells wonderful.",
  "weight": 0.5,
  "rarity": "common",
  "fixed": false,
  "equippable": false,
  "usable": true,
  "useEffect": "eat"
}
```

## Fixed Items

Fixed items cannot be picked up. They are scenery that players can examine and sometimes use.

**Example — Notice Board:**
```json
{
  "id": "notice-board",
  "name": "Notice Board",
  "description": "A large wooden board covered in pinned parchments — job postings, wanted notices, and town decrees.",
  "weight": 50.0,
  "rarity": "common",
  "fixed": true,
  "equippable": false,
  "usable": true,
  "useEffect": "read"
}
```

## Combine Recipes

Recipes live in `packages/server/world/recipes.json` as an array:

```json
[
  {
    "item1": "crowbar",
    "item2": "locked-chest",
    "result": "gold-ring",
    "description": "You wedge the crowbar under the chest lid and heave. The lock snaps and the lid flies open, revealing a **gold ring** nestled in rotting velvet."
  }
]
```

| Field | Description |
|-------|-------------|
| `item1` | First ingredient item ID |
| `item2` | Second ingredient item ID |
| `result` | Item ID produced by the combination |
| `description` | MUDdown narrative text shown to the player |

All three item IDs (`item1`, `item2`, `result`) must have corresponding JSON files in `world/items/`.

## Placing Items in Rooms

To place an item in a room, add its ID to the room file's YAML frontmatter:

```yaml
items:
  - shortsword
  - tongs
```

Then add a corresponding entry in the room's `## Items` section:

```markdown
## Items
- A [dull shortsword](item:shortsword) leans against the wall.
- A pair of [tongs](item:tongs) rests on the workbench.
```

## TypeScript Type System

Items use discriminated unions in `@muddown/shared`:

- `EquippableItem` vs `NonEquippableItem` (discriminated on `equippable`)
- `UsableItem` vs `NonUsableItem` (discriminated on `usable`)
- `ItemDefinition = (EquippableItem | NonEquippableItem) & (UsableItem | NonUsableItem)`

The world loader validates that equippable items have a valid `slot` and usable items have a valid `useEffect`.

## Common Pitfalls

1. **Filename/ID mismatch** — `shortsword.json` must contain `"id": "shortsword"`.
2. **Missing `slot` on equippable** — equippable items without a `slot` field are rejected by the loader.
3. **Missing `useEffect` on usable** — usable items without a `useEffect` are rejected.
4. **Recipe references nonexistent items** — all three IDs in a recipe must have JSON files.
5. **Duplicate IDs** — the loader warns if two files share the same `id`.
6. **Not referencing in room frontmatter** — items exist as definitions but only appear in rooms if listed in the room's `items:` frontmatter.
