# MUDdown

**A modern MUD platform using Markdown as the universal game markup language.**

[Discord](https://discord.gg/mDFcMT3egK) · [Website](https://muddown.com) · [Play](https://muddown.com/play)

MUDdown reimagines Multi-User Dungeons for the modern era. Instead of ANSI escape codes and raw telnet, MUDdown uses an extended Markdown format to describe game worlds — making them readable as plain text, beautifully rendered in browsers, and natively accessible to screenreaders and AI agents alike.

## Vision

- **Markdown-native**: Room descriptions, combat logs, dialogue, and UI are all structured Markdown with game-specific extensions
- **Multi-platform**: Play in a browser, on your phone, or in a terminal — one protocol, every surface
- **AI-first**: Game state exposed via structured schemas compatible with LLM tool-calling and Model Context Protocol (MCP)
- **Federated**: Servers can link realms together, letting players walk between worlds
- **Accessible by design**: Screenreader-first architecture; semantic markup over visual decoration

## Repository Structure

```
MUDdown/
├── packages/
│   ├── spec/       — The MUDdown Markdown specification
│   ├── parser/     — TypeScript parser for MUDdown format
│   ├── shared/     — Shared types and constants
│   ├── server/     — Game server (Node.js + WebSocket)
│   ├── client/     — Web/mobile client (React)
│   └── bridge/     — Telnet-to-WebSocket bridge (future)
├── apps/
│   └── website/    — muddown.com (spec docs + playable demo)
├── turbo.json
└── package.json
```

## Quick Start

```bash
# Prerequisites: Node.js >= 20
npm install
npm run build
npm run dev
```

## The MUDdown Format

MUDdown extends standard Markdown with game-specific container blocks:

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

See [packages/spec/](packages/spec/) for the full specification.

## License

[MIT](LICENSE)

## Links

- **Website**: [muddown.com](https://muddown.com)
