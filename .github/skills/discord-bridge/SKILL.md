---
name: discord-bridge
description: Work on the Discord-as-client bridge (`packages/discord-bridge`) — the WebSocket-proxy bot that lets a Discord user play MUDdown from their DM thread. Covers the renderer invariants (envelope → embed + components), button `custom_id` encoding, the no-auto-message rule, the multi-character picker flow, and the public `/feed` subscriber.
---

# Discord Bridge Skill

You are working on `packages/discord-bridge`, a stateless proxy that holds **one WebSocket session per Discord user** and translates between Discord messages and MUDdown wire envelopes. It is parallel in shape to `packages/bridge` (telnet) but speaks Discord embeds + components instead of ANSI/OSC 8.

The primary play surface is the bot's **DM with each player**. Public-channel slash commands (`/play`, `/who`, `/switch`, `/quit`) are convenience entry points that funnel the player into their DM session. A second, optional surface is the **public feed channel** — a one-way mirror of `:::system{scope="world"}` envelopes posted by `feed-subscriber.ts`.

## Files at a glance

| File | Responsibility |
|------|----------------|
| `src/bridge.ts` | Discord client lifecycle, interaction handlers, DM intake, slash commands, `feedSubscriber` wiring |
| `src/render.ts` | Pure `ServerMessage` → `RenderedMessage` (embeds + components). No discord.js coupling — exercised in unit tests by inspecting the returned shape |
| `src/sessions.ts` | Discord user ID ↔ MUDdownConnection map, idle eviction |
| `src/commands.ts` | Slash-command registration (`/play`, `/who`, `/switch`, `/quit`) |
| `src/feed.ts` | `isWorldScopeEnvelope()` defense-in-depth filter and `stripInteractiveLinks()` |
| `src/feed-subscriber.ts` | Read-only WS client to `/feed`, full-jitter backoff, posts world-scope envelopes to `feedChannelId` |
| `src/config.ts` | Env parsing, snowflake validation, `feedChannelId` opt-in |

## Renderer invariants

`render.ts` is the single source of truth for envelope → Discord shape. Keep it pure (no discord.js client, no I/O) so tests assert on the returned object directly.

- **One embed per envelope**, except long bodies split across multiple embeds in the same message.
- **Embed color by block type**, mirroring the spec's ARIA-role intent:
  - `room` → blue `0x3b82f6`
  - `system` → red `0xef4444`
  - `combat` → orange `0xf97316`
  - `dialogue` → green `0x22c55e`
  - `narrative` → neutral gray `0x9ca3af`
- **Hard limits** (from Discord's API; codified in `DISCORD_LIMITS`):
  - Embed description: 4096 chars (chunk via `chunkDescription`, prefer paragraph breaks then whitespace)
  - Buttons per action row: 5
  - Action rows per message: 5 (25 buttons total; overflow → select menu)
  - Button `custom_id`: ≤ 100 chars
- **Frontmatter and outer `:::` fences are stripped** (`stripContainerScaffolding`). Anchors are start-/end-of-string, not line, so an inner `:::` fence isn't matched as the outer close.
- **Interactive links become components**, not embedded URLs. External URLs (http(s)) stay inline as Markdown links. Game schemes (`go:`, `cmd:`, `item:`, `npc:`, `player:`, `help:`) are pulled out and re-emitted as buttons via `resolveGameLink`.
- **De-duplicate** same-label/same-target buttons (`label|customId` key) so a list of exits doesn't render the same button twice.

## Button `custom_id` encoding

The wire format for an interactive-link button:

```
muddown-link:<percent-encoded command line>
```

Encode with `encodeLinkCustomId(command)` and decode with `decodeLinkCustomId(customId)`. The encoder rejects results longer than `DISCORD_LIMITS.customIdLength` (100) by returning `undefined` — callers must skip those links rather than truncate.

The character picker uses a separate, non-collision-prone literal: `muddown-character-select`. Don't reuse `muddown-link:` for non-game-link interactions.

When more than 25 game links would render in one envelope, the renderer collapses **all** of them into a single string-select component with `customId = "muddown-link-select"` and the same `muddown-link:<…>` value per option. The bridge interaction handler in `bridge.ts` resolves both shapes via `resolveGameplayInteractionCommand`.

## No-auto-message rule

The bridge never sends a DM the user did not ask for.

- A new player gets their first DM only after invoking `/play` in the public hub channel — never as a side effect of joining the server, posting elsewhere, etc.
- Reconnect / idle-eviction notices go to the user **only when there is an active session that the user opened**.
- Slash commands answer in the channel they were invoked in (or as an ephemeral reply); the bot doesn't follow up by DM unless the command's contract says so.
- The public feed channel is the only surface that posts without a per-user trigger, and it never @-mentions or pings.

This is a hard constraint, not a courtesy. Discord aggressively rate-limits and eventually disables bots that DM unprompted.

## Multi-character picker flow

The bridge supports the same multi-character account model as the rest of MUDdown (`CharacterRecord`, `getCharacterById`).

- **First DM**: bridge sends a `Pick a character` embed with one button per character on the linked account. Picking one opens the WebSocket session.
- **`/switch`** (or sending `quit` then re-DMing): tears down the active session, returns to the picker, and starts a new session under the chosen character.
- **Resume**: `lastCharacterId` is persisted on the Discord identity-link row (`identity_links.last_character_id`). A fresh DM auto-resumes the most recent character with a "Switch?" button visible at the top of the first room embed.
- **Single-active invariant**: only one active character per Discord user at a time, matching the WebSocket "one session per connection" rule on the server.

The picker uses the `muddown-character-select` `custom_id` (see above). Character IDs travel as the option `value`, not encoded into the `custom_id`, because Discord's 100-char `custom_id` limit is too tight for multi-character UUIDs.

## Public feed channel

`feed-subscriber.ts` opens a dedicated WS to `${MUDDOWN_SERVER_URL}` with the path overwritten to `/feed`. It only activates when `config.feedChannelId !== undefined`.

- **Read-only by construction**: the server never delivers `scope="player"` traffic to `/feed`, but the subscriber **also** runs every envelope through `isWorldScopeEnvelope()` as defense-in-depth. Anything else is dropped.
- **Interactive links are stripped** by `stripInteractiveLinks()` before the embed is built — the public channel has no per-user session, so buttons would resolve to nothing. Visible link text is retained; the `components` array is discarded.
- **Backoff**: exponential 1s → 30s with full jitter. The client never spams reconnects.
- **URL hygiene**: `deriveFeedUrl()` clears `search` (prevents `?ticket=…` leakage to the unauthenticated endpoint per spec §6.3.1) and `hash`, and rewrites pathname to `/feed`.
- **Lifecycle race guard**: in `bridge.ts`, after `await client.channels.fetch(config.feedChannelId)`, verify `this.client !== client` is **false** before assigning `this.feedSubscriber`. If a `shutdown()` or `reset()` ran during the fetch, bail out — otherwise the subscriber is orphaned and posts forever.

## Testing

Vitest. 230+ tests across 11 files at last count.

- `tests/render.test.ts` — fixture-driven envelope → expected embed/components shape
- `tests/sessions.test.ts` — connection manager, idle eviction
- `tests/feed.test.ts` — `isWorldScopeEnvelope` and `stripInteractiveLinks` (covers `scope="player"` rejection, mixed link cases, case-sensitive scheme matching)
- `tests/feed-subscriber.test.ts` — reconnect/backoff, URL hygiene, lifecycle

Run from the repo root:

```bash
npx turbo run test --filter=@muddown/discord-bridge
```

Renderer fixtures should compare the **structural shape**, not stringified discord.js builders. The renderer never imports a discord.js builder for this reason.

## What NOT to do

- Don't import discord.js into `render.ts`. The renderer stays pure.
- Don't auto-DM users who haven't opened a session.
- Don't widen `isWorldScopeEnvelope` to accept `scope="player"`. The defense-in-depth check is the second wall; relaxing it is the bug.
- Don't reuse `muddown-link:` for non-game-link interactions. Pick a new literal.
- Don't truncate a too-long `custom_id` — return `undefined` and skip the button.
- Don't ship changes to bridge DM-session behaviour or `discord_rich_presence` without updating `MUDdown.wiki/Discord-Bridge.md` and `MUDdown.wiki/Desktop-App.md` (per AGENTS.md).
