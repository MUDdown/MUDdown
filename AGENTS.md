# MUDdown — Agent Instructions

## Project Overview

MUDdown is a modern MUD (Multi-User Dungeon) platform that uses an extended Markdown format as the universal game markup language. The canonical format specification lives in [packages/spec/SPECIFICATION.md](packages/spec/SPECIFICATION.md). All server output **must** comply with this spec.

## Architecture

Turborepo monorepo with npm workspaces:

| Package | Purpose |
|---------|---------|
| `packages/spec` | MUDdown specification (Markdown, no build) |
| `packages/shared` | TypeScript types: wire protocol, blocks, links, items |
| `packages/parser` | MUDdown parser (blocks, attributes, sections, links, frontmatter) |
| `packages/server` | WebSocket game server (Node.js + `ws`, port 3300) |
| `packages/client` | Future standalone client (empty) |
| `packages/bridge` | Future telnet bridge (empty) |
| `apps/website` | Astro site: landing page, spec docs, playable web client |

Dependency graph: `server` → `shared`; `parser` → `shared`; `website` → `spec` (reads Markdown at build time).

## TypeScript Conventions

- **Target**: ES2022, **Module**: ESNext, **Module resolution**: bundler
- **Strict mode** enabled; no `any` unless unavoidable
- Use `type` imports (`import type { ... }`) for type-only imports
- Node.js built-ins use `node:` prefix (`import { randomUUID } from "node:crypto"`)
- File extensions in imports: `.js` (TypeScript resolves `.ts` → `.js`)
- Discriminated unions preferred over optional fields for variant types (see `ItemDefinition` in shared)

## MUDdown Format Rules

Room files live in `packages/server/world/<region>/<room-id>.md` and follow this structure:

```markdown
---
id: room-id
region: region-name
lighting: bright|dim|dark
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
- [North](go:north) — Description
- [South](go:south) — Description

## Present
- A [town crier](npc:crier) stands near the fountain.

## Items
- A [rusty key](item:rusty-key) lies in the dust.
:::
```

**Key rules:**
- YAML frontmatter `items:` lists item IDs for the runtime loader. The `## Items` section in the body is the static template displayed to players (dynamically replaced at runtime).
- `id` in frontmatter and `id` in `:::room{id=...}` must match.
- All exits must be bidirectional — if room A connects north to room B, room B must connect south to room A.
- Interactive links use spec schemes: `go:`, `cmd:`, `item:`, `npc:`, `player:`, `help:`
- Container blocks (`:::room`, `:::system`, `:::item`, etc.) must open and close with `:::`

## Item Definitions

Each item is a separate JSON file in `packages/server/world/items/<item-id>.json`:

```json
{
  "id": "string",
  "name": "Display Name",
  "description": "Examination text",
  "weight": 0.1,
  "rarity": "common|uncommon|rare|legendary",
  "fixed": false,
  "equippable": false,
  "usable": false
}
```

Equippable items add `"slot": "weapon|armor|accessory"`. Usable items add `"useEffect": "eat|light|read|bless|fish|look-through"`.

Combine recipes live in `packages/server/world/recipes.json`.

NPC definitions are per-file in `packages/server/world/npcs/<npc-id>.json`.

## Wire Protocol

All server→client messages are JSON envelopes:

```json
{ "v": 1, "id": "uuid", "type": "room|system|narrative|combat|dialogue", "timestamp": "ISO8601", "muddown": "..." }
```

The `muddown` field contains valid MUDdown markup. System messages wrap content in `:::system{type="..."}...:::`.

## Build & Test Commands

```bash
npm install                                          # Install all dependencies
npx turbo run build                                  # Build everything
npx turbo run build --filter=@muddown/server...      # Build server + deps only
npx turbo run test                                   # Run all tests
cd packages/server && node dist/index.js             # Start game server (port 3300)
cd apps/website && npm run dev                       # Start Astro dev server (port 4321)
```

Parser tests: `cd packages/parser && npm test` (56 tests via Node.js test runner).
Server tests: `cd packages/server && npm test` (70 tests via vitest).

## Testing

Both `packages/parser` and `packages/server` have unit test suites. Tests use **vitest** (server) and the Node.js test runner (parser).

- **When adding a new feature**, add or update tests in the relevant package. New server helpers belong in `packages/server/src/helpers.ts` (exported, pure functions) so they can be unit tested without WebSocket mocking.
- **When modifying existing behavior**, update any tests that cover the changed code path. Run `npx turbo run test` before considering work complete.
- **Test file organization**: Each test file covers a single concern. Server tests live in `packages/server/tests/` with one file per topic (e.g., `load-rooms.test.ts`, `find-item.test.ts`). Shared fixture helpers live in `packages/server/tests/fixtures.ts`.
- **World loader tests** use temporary fixture directories (via `mkdtempSync`) so they don't depend on production world data. The `world-integrity.test.ts` file validates production data (counts, bidirectional exits, cross-references).
- **Pure helpers** (`findItemByName`, `findNpcInRoom`, `findUnclaimedIndex`, `dirAliases`) are in `packages/server/src/helpers.ts` — keep new game-logic helpers here so they stay testable.
- All tests must pass (`npx turbo run test`) before committing.

## Accessibility

The spec (§8) requires ARIA role mapping for container blocks:
- `room` → `role="main"`
- `system` → `role="alert"`
- `combat` → `role="log"` with `aria-live="polite"`
- `dialogue` → `role="dialog"`

The web client applies these roles in `apps/website/src/pages/play.astro`. Do not remove them.

## What NOT to Do

- Don't add `copilot-instructions.md` — this file (`AGENTS.md`) replaces it
- Don't duplicate the full spec here — link to `packages/spec/SPECIFICATION.md`
- Don't use `as` type assertions when a type guard or discriminated union works
- Don't add optional fields where a discriminated union is clearer
- Don't break bidirectional exit symmetry in room files
