---
name: persistence
description: Work with the database abstraction layer and player/world persistence. Covers the GameDatabase interface, SQLite adapter, PlayerRecord, save/load lifecycle, auth sessions, and testing patterns.
---

# Persistence Skill

You are working with the MUDdown persistence layer — the database abstraction and save/load patterns that keep player and world state across server restarts.

## Architecture

```
packages/server/src/db/
├── types.ts      # GameDatabase interface + supporting types
└── sqlite.ts     # SqliteDatabase implementation (better-sqlite3)
```

The game server talks exclusively to the `GameDatabase` interface. The only concrete implementation today is `SqliteDatabase` (better-sqlite3, synchronous, WAL mode). The interface is designed so a Postgres or other backend can be swapped in later without touching game logic.

## GameDatabase Interface

Defined in `packages/server/src/db/types.ts`:

| Group | Methods |
|-------|---------|
| Lifecycle | `close()` |
| Players | `getPlayerByGithubId()`, `getPlayerById()`, `upsertPlayer()`, `savePlayerState()` |
| Room Items | `getRoomItems()`, `setRoomItems()`, `getAllRoomItems()`, `saveAllRoomItems()` |
| Defeated NPCs | `getDefeatedNpcs()`, `addDefeatedNpc()`, `removeDefeatedNpc()` |
| NPC HP | `getNpcHp()`, `setNpcHp()`, `removeNpcHp()`, `getAllNpcHp()`, `saveAllNpcHp()` |
| Auth Sessions | `getSession()`, `createSession()`, `deleteSession()`, `cleanExpiredSessions()` |

### Supporting Types

- **`PlayerStateUpdate`** — partial update for `savePlayerState()` (currentRoom, inventory, equipped, hp, maxHp, xp).
- **`AuthSession`** — token, playerId, expiresAt (ISO 8601).
- **`PlayerRecord`** — from `@muddown/shared`: full player model with `id`, `githubId`, `username`, `displayName`, `currentRoom`, `inventory`, `equipped`, `hp`, `maxHp`, `xp`, `createdAt`, `updatedAt`.

## SQLite Implementation Patterns

### Constructor & Migration

```typescript
constructor(filepath: string) {
  this.db = new Database(filepath);
  this.db.pragma("journal_mode = WAL");
  this.db.pragma("foreign_keys = ON");
  this.migrate();
}
```

- WAL mode for concurrent reads during writes.
- Foreign keys enforced (e.g., `auth_sessions.player_id` → `players.id`).
- `migrate()` uses `CREATE TABLE IF NOT EXISTS` — idempotent, safe to re-run.

### ISO 8601 Timestamps

- **Application code**: Use `new Date().toISOString()` and pass as a named parameter.
- **DDL defaults**: Use `strftime('%Y-%m-%dT%H:%M:%fZ','now')` — SQLite's `datetime('now')` produces `YYYY-MM-DD HH:MM:SS`, which is not ISO 8601.

```typescript
// ✅ Correct — app code
savePlayerState(id, state) {
  // ... build SET clauses ...
  stmt.run({ ...params, updatedAt: new Date().toISOString() });
}

// ✅ Correct — DDL
CREATE TABLE IF NOT EXISTS players (
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

// ❌ Wrong — produces non-ISO format
DEFAULT (datetime('now'))
```

### JSON Columns

`inventory` (a `string[]`) and `equipped` (a `Record<EquipSlot, string | null>` with keys `weapon`, `armor`, `accessory`) are stored as JSON text in the `players` table. The `rowToPlayer()` function in `sqlite.ts` deserializes them when reading a `PlayerRow` into a `PlayerRecord`.

Always guard `JSON.parse` with try/catch and log the failure:

```typescript
function rowToPlayer(row: PlayerRow): PlayerRecord {
  let inventory: string[];
  try {
    inventory = JSON.parse(row.inventory) as string[];
  } catch {
    console.error(`Corrupt inventory JSON for player ${row.id}, resetting to []`);
    inventory = [];
  }

  let equipped: Record<EquipSlot, string | null>;
  try {
    equipped = JSON.parse(row.equipped) as Record<EquipSlot, string | null>;
  } catch {
    console.error(`Corrupt equipped JSON for player ${row.id}, resetting to defaults`);
    equipped = { weapon: null, armor: null, accessory: null };
  }

  return { id: row.id, githubId: row.github_id, /* ... */ inventory, equipped };
}
```

**Why silent fallbacks are acceptable:** A corrupt `inventory` or `equipped` value means the player loses items/equipment — inconvenient but not security-critical. Crashing the login flow would lock the player out entirely, which is worse. The safe defaults (`[]` and all-null slots) let the player continue playing.

**When corruption can occur:** Manual DB edits, interrupted writes during an OS crash, or future schema migrations that alter the JSON shape without a data migration step.

**Observability:** Parse failures are logged to `console.error` with the player ID. In production, pipe server output to a log aggregator and alert on `Corrupt inventory JSON` or `Corrupt equipped JSON` so corrupted records can be investigated and repaired manually (e.g., `UPDATE players SET inventory = '[]' WHERE id = '...'`).

### Named Parameters

Prefer `@`-prefixed named parameters in SQLite statements (the codebase also uses positional `?` placeholders in some queries):

```typescript
const stmt = this.db.prepare(`
  UPDATE players SET current_room = @currentRoom WHERE id = @id
`);
stmt.run({ id, currentRoom: "town-square" });
```

## Save/Load Lifecycle

1. **Server startup**: Open DB, then use `getAllRoomItems()` to restore room inventories, `getAllNpcHp()` to restore damaged NPC HP, and `getDefeatedNpcs()` to rebuild the defeated set.
2. **Player login**: `getPlayerByGithubId()` to find existing player or `upsertPlayer()` to create.
3. **During play**: `savePlayerState()` on meaningful changes (room change, inventory change, combat).
4. **Periodic auto-save**: Timer saves all connected players' state plus `saveAllRoomItems()` and `saveAllNpcHp()`.
5. **Server shutdown**: Save all connected players → save room items → save NPC HP → close WS clients → close WSS → close HTTP → `db.close()` (DB closes **last**).

### Shutdown Ordering

The DB must close **after** all network connections to avoid errors from late-arriving messages:

```
1. Close all WebSocket clients (code 1001)
2. Close WebSocket server
3. Close HTTP server
4. db.close()  ← last
```

## Testing Persistence

Tests live in `packages/server/tests/db.test.ts`. Key patterns:

### In-Memory-Like Setup

Use a temp directory with a real SQLite file. Note: better-sqlite3 *does* support in-memory databases via `:memory:` (each connection gets its own isolated DB) and shared in-memory databases via `file::memory:?cache=shared`. We use a temp file instead so the DB can be inspected on disk after a failed test run and to mirror the production file-based code path:

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

### Test Categories

- **Player CRUD**: upsert, retrieve by ID, retrieve by GitHub ID, update partial state.
- **Room items**: set/get per room, bulk save/load.
- **Defeated NPCs**: add, list, remove, respawn tracking.
- **NPC HP**: set/get/remove individual, bulk save/load.
- **Auth sessions**: create, retrieve, delete, expiration cleanup.

### Key Assertions

- After `upsertPlayer`, verify `getPlayerById` and `getPlayerByGithubId` both return the record.
- JSON columns (`inventory`, `equipped`) round-trip correctly as arrays/objects, not strings.
- `savePlayerState` partial updates don't overwrite unrelated fields.
- `cleanExpiredSessions` removes only expired rows.

## When to Use This Skill

- Adding new persistent data (new table, new column, new method on `GameDatabase`).
- Modifying save/load logic or the server startup/shutdown sequence.
- Writing or updating `db.test.ts`.
- Extending the `PlayerRecord` type or `PlayerStateUpdate` type.
- Debugging timestamp or JSON serialization issues.
