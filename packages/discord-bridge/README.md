# @muddown/discord-bridge

Discord bridge for MUDdown — lets a Discord user play the production MUDdown
server from inside the MUDdown Discord guild. Architecturally parallel to
[`@muddown/bridge`](../bridge) (the telnet/TLS bridge): a stateless proxy
holding one WebSocket session per linked Discord user.

## Status

**Scaffold.** The package layout, build, tests, and renderer skeleton are
in place; the `discord.js` client wiring, slash-command registration, and
character-picker flow are tracked under PROJECT_PLAN.md Phase 9a and will
land in follow-up commits on this branch.

## Design summary

| MUDdown side | Discord side |
|---|---|
| Player connection | One Discord user ↔ one WebSocket session, keyed on the existing Discord OAuth identity link |
| Player input | Plain DM text → raw command line; `/play`, `/who`, `/switch`, `/quit` slash commands as entry points |
| Server output | One embed per `ServerMessage` envelope, color-keyed by block type |
| Interactive links (`go:`, `cmd:`, `item:`, `npc:`) | Discord buttons (5×5 max) or a select-menu overflow; `custom_id` encodes the link URI |
| Multi-character | Picker on first DM, `/switch` mid-session, `lastCharacterId` resume |

No ANSI, no OSC 8 — Discord components replace clickable telnet links.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `MUDDOWN_DISCORD_BOT_TOKEN` | yes | Bot token from the Discord developer portal |
| `MUDDOWN_SERVER_URL` | yes | WebSocket URL of the production game server (e.g. `wss://muddown.com/ws`) |
| `MUDDOWN_DISCORD_GUILD_ID` | optional | Guild for guild-scoped slash command registration during development |

## Deployment

A systemd unit (`deploy/muddown-discord-bridge.service`) parallel to
`muddown-bridge.service` will be added when the bot wiring lands.

## Out of scope

Voice, lobbies, account creation, world editing — same exclusions as the
telnet bridge.
