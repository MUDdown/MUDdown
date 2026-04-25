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
| `packages/client` | Framework-agnostic client library (renderer, connection, history, links, hints, inventory) |
| `packages/bridge` | Telnet bridge — TLS proxy to WebSocket game server (port 2323) |
| `apps/website` | Astro site: landing page, spec docs, playable web client |
| `apps/mobile` | Expo React Native app for iOS/Android |
| `apps/desktop` | Tauri v2 desktop app (macOS, Windows, Linux) |
| `apps/terminal` | Terminal/CLI client (Node.js, ink) |

Dependency graph: `server` → `shared`; `parser` → `shared`; `client` → `shared`; `bridge` → `client`, `shared`; `mobile` → `client`, `shared`; `desktop` → `client`, `shared`; `terminal` → `client`, `shared`; `website` → `spec` (reads Markdown at build time).

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

## Commits & DCO

All commits **must** include a `Signed-off-by` line (Developer Certificate of Origin). Always use the `-s` flag when committing:

```bash
git commit -s -m "feat: add new feature"
```

See [DCO](DCO) and [CONTRIBUTING.md](CONTRIBUTING.md) for details. A CI check enforces this on all pull requests.

## Build & Test Commands

```bash
npm install                                          # Install all dependencies
npx turbo run build                                  # Build everything
npx turbo run build --filter=@muddown/server...      # Build server + deps only
npx turbo run test                                   # Run all tests
cd packages/server && npm start                      # Start game server (port 3300, loads .env)
cd apps/website && npm run dev                       # Start Astro dev server (port 4321)
cd apps/mobile && npm start                          # Start Expo dev server (mobile app)
```

Parser tests: `cd packages/parser && npm test` (56 tests via vitest).
Server tests: `cd packages/server && npm test` (566 tests via vitest).
Client tests: `cd packages/client && npm test` (155 tests via vitest).
MCP tests: `cd packages/mcp && npm test` (24 tests via vitest).
Bridge tests: `cd packages/bridge && npm test` (163 tests via vitest).

## Testing

Both `packages/parser` and `packages/server` have unit test suites. Both use **vitest**.

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
- `dialogue` → `role="group"` with `aria-label="NPC dialogue"`

The web client applies these roles in `apps/website/src/pages/play.astro`. Do not remove them.

## Skills

Detailed how-to guides live in `.github/skills/<name>/SKILL.md` (canonical) with symlinks at `.claude/skills/<name>/SKILL.md` for Claude Code. Each skill is a Markdown file with YAML frontmatter (`name`, `description`) in a kebab-case directory.

| Skill | Purpose |
|-------|---------|
| `room-creation` | Create MUDdown room files (frontmatter, exits, sections) |
| `item-creation` | Create item definition JSON files (equippable, usable, fixed, recipes) |
| `npc-creation` | Create NPC definitions with dialogue trees |
| `muddown-format` | MUDdown markup format (container blocks, link schemes, wire protocol) |
| `persistence` | Database abstraction, SQLite adapter, player/world save/load lifecycle, auth sessions |
| `testing` | Testing conventions (vitest, fixtures, world integrity) |
| `privacy` | Privacy compliance auditing (data collection, cookies, localStorage, policy alignment) |
| `oauth-provider` | Add a new OAuth/OIDC identity provider (shared types, auth switches, server config, login button, env vars, tests) |
| `mobile-testing` | Test the Expo React Native app on physical devices via Expo Go or iOS Simulator (LAN config, SDK alignment, entry point, simulators, OAuth) |
| `desktop-app` | Build and maintain the Tauri v2 desktop app (scaffolding, Turborepo wiring, CI matrix, auto-updater signature verification, native integrations) |
| `osc8-bridge` | Add or modify OSC 8 hyperlink capabilities in the telnet bridge — NEW-ENVIRON negotiation, Mudlet `send:`/`prompt:` URIs, tooltip/menu `?config=` metadata, word-wrap envelope invariant |

### Maintaining Skills

When a milestone feature lands (new system, new content type, new workflow), evaluate whether it warrants a new skill or an update to an existing one. Guidelines:

- **New skill**: The feature introduces a repeatable pattern that an agent will need to follow again (e.g., a new entity type, a new file format, a new integration). Create `.github/skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`) and a symlink at `.claude/skills/<name>/SKILL.md`.
- **Update existing skill**: The feature changes conventions already covered by a skill (e.g., new test patterns → update `testing`, new link scheme → update `muddown-format`). Edit the existing `SKILL.md` in place.
- **No skill needed**: One-off changes, bug fixes, or refactors that don't establish a new repeatable pattern.
- **Update the table above** and the skills table in CLAUDE.md so the new skill is discoverable in both files.

### Maintaining the Features Page

The website features page (`apps/website/src/pages/features.astro`) showcases implemented functionality. When a user-facing feature ships, update the features page:

- **New feature**: Add a `<li>` to the appropriate category with a `<strong>` label and brief description.
- **New category**: Add a new `.features-page-category` block with a heading and icon.
- **Removed or replaced feature**: Remove or update the corresponding entry so the page stays accurate.
- **Test count**: The "Comprehensive test suite" entry in the Infrastructure section states the total test count across all packages. After adding or removing tests, run `npx turbo run test` and update the number to match the sum of all passing tests (parser + server + MCP). Do not leave a stale count.
- **When in doubt**: If the change is visible to players or operators (new command, new UI element, new integration), it belongs on the features page. Internal refactors and test-only changes do not.

### Maintaining the Licenses Page

The website licenses page (`apps/website/src/pages/licenses.astro`) lists every third-party open source dependency with its license type. Keep it accurate when dependencies change:

- **New dependency**: When a new runtime or build dependency is added to any `package.json`, add a row to the licenses table with the package name (linked to its homepage or repo), license type, and a one-line description.
- **Removed dependency**: Remove the corresponding row.
- **License or version change**: Update the license column if an upgrade changes the license type (e.g., MIT → Apache-2.0).
- **Audit command**: Run `npm ls --depth=0 --json | jq '((.dependencies // {}) + (.devDependencies // {})) | to_entries[] | {name: .key, version: .value.version}'` at the repo root to list current top-level dependencies. This is a workspaces monorepo, so also check each workspace's `package.json` (under `apps/*` and `packages/*`) for its `dependencies` and `devDependencies`. Look up each package's license in `node_modules/<pkg>/package.json`.
- **What to include**: All direct `dependencies` and `devDependencies` from the root and workspaces that ship runtime code or are essential build tools (Astro, TypeScript, Turborepo, vitest, etc.). Omit `@types/*` packages (all MIT) and internal `@muddown/*` workspace references. Omit transitive dependencies unless they have a non-MIT/Apache-2.0 license that requires attribution.

### Maintaining the Wiki

The project wiki lives in a separate Git repository (`MUDdown/MUDdown.wiki`), typically cloned to `../MUDdown.wiki` relative to the main repo. It contains player-facing and developer-facing documentation as Markdown pages plus a `_Sidebar.md` navigation file. When a feature ships or existing behavior changes, evaluate whether any wiki pages need to be created or updated.

**Wiki structure:**

| Section | Pages | Covers |
|---------|-------|--------|
| Players | Getting-Started, Command-Reference, World-Guide, Item-Catalog, NPC-Directory, Combat-Guide, FAQ | How to play, commands, world content, items, NPCs, combat |
| Developers | Architecture-Overview, Adding-Content, Wire-Protocol, MUDdown-Format, LLM-Integration, Deployment-Guide, Contributing, OAuth-Setup | Codebase internals, content authoring, protocols, integrations, ops |

**When to update:**

- **New command or player-visible feature**: Update the relevant player page (e.g., new command → Command-Reference, new area → World-Guide, new item → Item-Catalog, new NPC → NPC-Directory).
- **New world content** (rooms, items, NPCs, recipes): Update World-Guide, Item-Catalog, or NPC-Directory to reflect the additions.
- **Wire protocol or format change**: Update Wire-Protocol and/or MUDdown-Format.
- **New integration or infrastructure** (e.g., new OAuth provider, new LLM feature, deployment change): Update the corresponding developer page.
- **New content type or major system**: Consider creating a new wiki page. Add it to `_Sidebar.md` under the appropriate section and link it from `Home.md`.
- **Removed or renamed feature**: Remove or update the corresponding wiki content so pages stay accurate.
- **Architecture change**: Update Architecture-Overview if the package structure, dependency graph, or high-level design changes.

**How to update:**

1. Edit the relevant `.md` file(s) in the wiki repo directory.
2. If adding a new page, also add it to `_Sidebar.md` and `Home.md`.
3. Commit with a descriptive message and push: `cd ../MUDdown.wiki && git add -A && git commit -m "docs: update <page> for <change>" && git push`.
4. The wiki repo uses `master` as its default branch (GitHub convention for wiki repos).

**When NOT to update the wiki:**

- Internal refactors with no user-visible or developer-visible behavior change.
- Test-only changes (unless they establish new testing patterns worth documenting in Contributing or Adding-Content).
- Bug fixes that don't change documented behavior.

## What NOT to Do

- Don't add `copilot-instructions.md` — this file (`AGENTS.md`) replaces it
- Don't duplicate the full spec here — link to `packages/spec/SPECIFICATION.md`
- Don't use `as` type assertions when a type guard or discriminated union works
- Don't add optional fields where a discriminated union is clearer
- Don't break bidirectional exit symmetry in room files
