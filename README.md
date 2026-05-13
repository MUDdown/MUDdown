# MUDdown

**A modern MUD platform using Markdown as the universal game markup language.**

[Website](https://muddown.com) · [Play](https://muddown.com/play) · [Download](https://muddown.com/download) · [Spec](https://muddown.com/spec) · [Wiki](https://github.com/MUDdown/MUDdown/wiki) · [Discord](https://discord.gg/mDFcMT3egK)

MUDdown reimagines Multi-User Dungeons for the modern era. Instead of ANSI escape codes and raw telnet, the server speaks an extended Markdown format — readable as plain text, beautifully rendered in browsers, natively accessible to screenreaders, and structured enough for AI agents to play.

## Try it now

Connect to the public server at `muddown.com` from any of these clients:

| Client | How |
|--------|-----|
| **Web** | Visit [muddown.com/play](https://muddown.com/play) and sign in with Discord, GitHub, Google, or Microsoft |
| **Desktop** | [Download](https://muddown.com/download) the signed Tauri app for macOS, Windows, or Linux |
| **Mobile** | Run the Expo app locally (see [apps/mobile](apps/mobile/)) — store builds coming soon |
| **Terminal** | `npx @muddown/terminal` for an ink-based CLI client |
| **Telnet** | `telnet muddown.com 2323` (TLS-only; works with Mudlet, MUSHclient, tintin++) |
| **Discord** | Join the [MUDdown Discord](https://discord.gg/mDFcMT3egK) and run `/play` |
| **AI / MCP** | Add the [MCP server](packages/mcp/) to Claude Desktop, Cursor, or any MCP-compatible client |

## What's in the box

A 24-room demo world ("Northkeep") across 5 regions, 31 items, 16 NPCs with branching dialogue, turn-based combat, 4 character classes, OAuth login, persistent state, LLM-powered NPC conversations, AI hints, vector-search lore queries, and a Model Context Protocol surface for agents.

## Vision

- **Markdown-native** — Rooms, combat, dialogue, and UI are structured Markdown with game-specific extensions
- **Multi-platform** — Web, desktop, mobile, terminal, telnet, and Discord — one protocol, every surface
- **AI-first** — Structured schemas compatible with LLM tool-calling and MCP
- **Federated** — Servers can link realms together, letting players walk between worlds
- **Accessible by design** — Screenreader-first architecture; semantic markup over visual decoration

## Repository Structure

Turborepo monorepo with npm workspaces.

```
MUDdown/
├── packages/
│   ├── spec/           — The MUDdown specification (Markdown)
│   ├── parser/         — TypeScript parser for the MUDdown format
│   ├── shared/         — Shared types: wire protocol, blocks, items
│   ├── server/         — Game server (Node.js + WebSocket, port 3300)
│   ├── client/         — Framework-agnostic client library
│   ├── bridge/         — Telnet → WebSocket bridge (TLS, port 2323)
│   ├── discord-bridge/ — Discord → WebSocket bridge (DM gameplay)
│   └── mcp/            — Model Context Protocol server
├── apps/
│   ├── website/        — muddown.com (Astro, spec docs, web client)
│   ├── desktop/        — Tauri v2 desktop app (macOS / Windows / Linux)
│   ├── mobile/         — Expo React Native app (iOS / Android)
│   └── terminal/       — Node.js CLI client (ink)
├── deploy/             — systemd units and nginx configs
├── turbo.json
└── package.json
```

## Quick Start

```bash
# Prerequisites: Node.js >= 20
git clone https://github.com/MUDdown/MUDdown.git
cd MUDdown
npm install
npx turbo run build

# Run the game server (port 3300)
cd packages/server && npm start

# In another terminal, run the website (port 4321)
cd apps/website && npm run dev
```

Then open <http://localhost:4321/play>. Tests for any package run with `npm test` inside that package, or `npx turbo run test` from the root.

## The MUDdown Format

MUDdown extends standard Markdown with game-specific container blocks and link schemes:

```markdown
:::room{id="iron-gate" region="northkeep"}
# The Iron Gate

A massive portcullis of blackened iron bars the passage north.
The mechanism is **rusted**, but you notice [fresh oil on the gears](cmd:examine gears).

## Exits
- [North](go:north) *(blocked)*
- [South](go:south) — Courtyard

## Present
- [@Tharion](player:tharion) is here, studying the mechanism.
- A [sleeping guard](npc:guard-7) slumps against the wall.
:::
```

The full specification lives at [packages/spec/SPECIFICATION.md](packages/spec/SPECIFICATION.md).

## Development & Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md) — branching, DCO, squash-merge workflow
- [AGENTS.md](AGENTS.md) — conventions for human and AI contributors
- [DCO](DCO) — all commits must be signed off (`git commit -s`)
- [Wiki](https://github.com/MUDdown/MUDdown/wiki) — player guides, architecture, deployment, OAuth setup
- Discord: [discord.gg/mDFcMT3egK](https://discord.gg/mDFcMT3egK)

## License

[MIT](LICENSE)
