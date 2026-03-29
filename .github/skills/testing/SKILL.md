---
name: testing
description: Write and maintain tests for MUDdown packages. Covers vitest for the server and parser, fixture helpers, world integrity tests, and testing conventions.
---

# Testing Skill

You are writing or maintaining tests for the MUDdown project. Both the server and parser use vitest.

## Test Frameworks

| Package | Framework | Command |
|---------|-----------|---------|
| `packages/server` | vitest | `cd packages/server && npm test` |
| `packages/parser` | vitest | `cd packages/parser && npm test` |
| All | Turborepo | `npx turbo run test` |

## Server Test Organization

Tests live in `packages/server/tests/` with one file per concern:

| File | Tests |
|------|-------|
| `dir-aliases.test.ts` | Direction alias mapping |
| `find-item.test.ts` | `findItemByName` helper (exact, partial, precedence) |
| `find-npc.test.ts` | `findNpcInRoom` helper (exact, partial, precedence) |
| `find-unclaimed-index.test.ts` | `findUnclaimedIndex` helper |
| `load-rooms.test.ts` | Room loader (parsing, regions, nested dirs) |
| `load-items.test.ts` | Item loader (equippable, usable, fixed, validation) |
| `load-npcs.test.ts` | NPC loader (dialogue, location grouping) |
| `load-recipes.test.ts` | Recipe loader (validation, cross-references) |
| `world-integrity.test.ts` | Production world validation (counts, exits, cross-refs) |
| `db.test.ts` | Database abstraction (player CRUD, room items, defeated NPCs, NPC HP, auth sessions) |
| `hooks.test.ts` | Entity lifecycle hooks (`registerHook`, `fireHook`, greeting hooks) |
| `combat.test.ts` | Combat helpers (dice rolls, attack resolution, stat bonuses) |

## Fixture Helpers

Shared helpers in `packages/server/tests/fixtures.ts`:

```typescript
import { createFixtureDir, cleanupFixtureDir, writeRoom, writeItem, writeNpc, writeRecipes } from "./fixtures.js";

// Create temp dir with items/ and npcs/ subdirectories
const dir = createFixtureDir();

// Write test data
writeRoom(dir, "region", "room.md", markdownContent);
writeItem(dir, "sword.json", { id: "sword", name: "Sword", ... });
writeNpc(dir, "guard.json", { id: "guard", name: "Guard", ... });
writeRecipes(dir, [{ item1: "a", item2: "b", result: "c", description: "..." }]);

// Clean up after
cleanupFixtureDir(dir);
```

## Test Patterns

### Loader Tests

Use temporary fixture directories so tests don't depend on production data:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadWorld } from "../src/world.js";
import { createFixtureDir, cleanupFixtureDir, writeRoom, writeItem } from "./fixtures.js";

describe("feature", () => {
  let dir: string;

  beforeAll(() => {
    dir = createFixtureDir();
    writeRoom(dir, "test", "room.md", `---
id: test-room
region: test
lighting: bright
connections:
  north: other-room
---
:::room{id="test-room" region="test" lighting="bright"}
# Test Room
:::`);
  });

  afterAll(() => cleanupFixtureDir(dir));

  it("loads the room", () => {
    const world = loadWorld(dir);
    expect(world.rooms.has("test-room")).toBe(true);
  });
});
```

### Helper Tests

Pure function tests don't need fixtures:

```typescript
import { describe, it, expect } from "vitest";
import { findItemByName } from "../src/helpers.js";

describe("findItemByName", () => {
  const defs = new Map([["sword", { id: "sword", name: "Iron Sword", ... }]]);

  it("finds by exact ID", () => {
    expect(findItemByName("sword", ["sword"], defs)?.id).toBe("sword");
  });
});
```

### Database Tests

Use a temp directory with a real SQLite file. Close the DB and remove the dir in teardown:

```typescript
import { beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteDatabase } from "../src/db/sqlite.js";
import type { GameDatabase } from "../src/db/types.js";

let db: GameDatabase;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "muddown-db-test-"));
  db = new SqliteDatabase(join(tmpDir, "test.sqlite"));
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});
```

### Hook Tests

Call `clearHooks()` (and `resetGreetings()` if testing greeting hooks) in `beforeEach` to isolate tests:

```typescript
import { beforeEach } from "vitest";
import { clearHooks, resetGreetings } from "../src/hooks.js";

beforeEach(() => {
  clearHooks();
  resetGreetings();
});
```

### World Integrity Tests

The `world-integrity.test.ts` file validates production data. It uses `beforeAll` to load the world once:

```typescript
let world: WorldMap;

beforeAll(() => {
  world = loadWorld();
});
```

## Key Conventions

1. **New helpers go in `helpers.ts`** — exported pure functions that are easy to unit test.
2. **One concern per test file** — don't mix loader tests with helper tests.
3. **Use `toBeDefined()` before `!` assertions** — guard against undefined before accessing properties.
4. **JSON fixtures use pretty-print** — `JSON.stringify(obj, null, 2)` in fixture helpers.
5. **Import with `.js` extensions** — TypeScript resolves `.ts` → `.js`.
6. **All tests must pass before committing** — run `npx turbo run test`.

## Adding Tests for New Features

1. Create a new test file in `packages/server/tests/` if the concern doesn't fit existing files.
2. Import from `vitest` (`describe`, `it`, `expect`, `beforeAll`, `afterAll`).
3. Use fixture helpers for any test that needs world data.
4. If testing a pure function, add it to `helpers.ts` and test directly.
5. Update `world-integrity.test.ts` if adding new world data types or cross-reference requirements.

## Common Pitfalls

1. **Depending on production world data** — loader tests should use temp fixtures, not real rooms.
2. **Not cleaning up temp dirs** — always call `cleanupFixtureDir` in `afterAll`.
3. **Duplicate `loadWorld()` calls** — use `beforeAll` to load once per describe block.
4. **Missing assertions** — every `it` block should have at least one `expect`.
5. **Build vs test** — `npm test` runs vitest against TypeScript sources directly and does not require a prior `tsc` build. `npx turbo run test` may trigger builds first via Turbo task dependencies.
