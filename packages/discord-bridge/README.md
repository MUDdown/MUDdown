# @muddown/discord-bridge

Discord bridge for MUDdown — lets a Discord user play the production MUDdown
server from inside the MUDdown Discord guild. Architecturally parallel to
[`@muddown/bridge`](../bridge) (the telnet/TLS bridge): a stateless proxy
holding one WebSocket session per linked Discord user.

## Status

**Runtime in place.** The package starts a real `discord.js` client, logs in,
registers slash commands, runs the full Discord-OAuth `/play` link flow with
character selection, and proxies a live `MUDdownConnection` gameplay session
(DM text → upstream commands; server envelopes → embeds with button/select
components). Idle eviction (30 min), reconnect-cycle DMs, the `/who` status
line, and graceful shutdown are all wired up. See PROJECT_PLAN.md Phase 9a for
follow-up polish work.

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

A systemd unit now lives at `deploy/muddown-discord-bridge.service`, parallel to
`muddown-bridge.service`.

### Shutdown behavior (operators)

The bridge entrypoint handles `SIGTERM` and `SIGINT` with a two-stage shutdown flow:

- First signal: logs a graceful-shutdown message and calls the bridge `shutdown()` export (wired through the entrypoint's shutdown bridge hook) before exiting.
- Second signal during shutdown: logs a force-exit message and exits immediately with a non-zero status.

This matches container/system supervisors that send one termination signal and escalate if the process does not exit before timeout.

### Orchestration guidance

- Send a single termination signal first (`SIGTERM` preferred).
- Configure stop/termination grace periods long enough for bridge cleanup (Discord gateway close, upstream WebSocket close, pending message flush once wiring lands).
- Use escalation (`SIGKILL` or equivalent) only after the graceful timeout expires.
- Prefer lifecycle hooks (`preStop`, systemd `ExecStop`) that trigger one graceful signal rather than repeated signals in quick succession.
- Health checks should expect the process to exit during shutdown/restart windows; treat transient restart periods as expected behavior.

## Out of scope

Voice, lobbies, account creation, world editing — same exclusions as the
telnet bridge.
