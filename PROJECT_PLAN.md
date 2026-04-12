# MUDdown Project Plan

**Domain**: muddown.com  
**Repository**: https://github.com/MUDdown/MUDdown  
**License**: MIT  
**Started**: 2026-03-27

---

## Vision

MUDdown reimagines Multi-User Dungeons for the modern era by replacing ANSI escape codes and raw telnet with an extended Markdown format — **MUDdown** — that is human-readable, machine-parseable, AI-friendly, and natively accessible.

### Core Principles

- **Text is the truth**: Markdown source is the canonical representation
- **Progressive enhancement**: Plain Markdown renderers are valid clients; richer clients add interactivity
- **Semantic over decorative**: Structure conveys meaning, not visual styling
- **AI-legible**: All game constructs are structured data that LLMs can parse and act on
- **Accessible by design**: Screenreader-first; ARIA-mapped container blocks

---

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | Widest multi-platform reach; first-class AI SDK ecosystem |
| Monorepo | Turborepo + npm workspaces | Shared types, independent packages, parallel builds |
| Transport | WebSocket (JSON envelopes) | Browser-native, bidirectional, replaces telnet |
| Game markup | MUDdown (Markdown superset) | Readable raw, interactive when rendered, AI-parseable |
| Website | Astro (static site) | Fast, deploys on Debian via nginx, embeds React islands |
| Server | Node.js + ws | Lightweight, same language as client, easy to extend |
| License | MIT | Maximally permissive, widely understood |
| Hosting target | Debian Linux | nginx for static site, systemd for game server |

---

## What's Been Built

### Monorepo Structure
```
MUDdown/
├── packages/
│   ├── spec/           ✅ MUDdown Specification v0.1.0 (draft)
│   ├── shared/         ✅ TypeScript types for protocol, blocks, links, wire messages
│   ├── parser/         ✅ MUDdown parser (blocks, attributes, sections, links, frontmatter)
│   ├── server/         ✅ WebSocket game server with demo world
│   ├── client/         ✅ Framework-agnostic client library (renderer, connection, history, links, hints, inventory)
│   └── bridge/         📁 Directory created (empty — telnet bridge future)
├── apps/
│   ├── website/        ✅ Astro site: landing page, spec docs, playable web client
│   └── mobile/         ✅ Expo React Native app for iOS/Android
│   └── desktop/        ✅ Tauri v2 desktop app (macOS, Windows, Linux)
├── turbo.json          ✅ Build orchestration
├── package.json        ✅ Workspace root
├── tsconfig.json       ✅ Shared TypeScript config
├── .gitignore          ✅
├── LICENSE             ✅ MIT
└── README.md           ✅
```

### Specification (packages/spec/SPECIFICATION.md)
The v0.1.0 draft covers:
- **Container blocks**: `:::room`, `:::npc`, `:::item`, `:::combat`, `:::dialogue`, `:::system`, `:::map`, plus `x-` extensions
- **Interactive link schemes**: `cmd:`, `go:`, `item:`, `npc:`, `player:`, `help:`, `url:`
- **Player mentions**: `[@Name](player:id)` syntax
- **YAML frontmatter**: Metadata for message type, server info, timestamps
- **Wire protocol**: JSON envelopes over WebSocket with typed message types (room, combat, dialogue, system, narrative, command, input, ping/pong)
- **AI integration hooks**: Tool-calling schema, MCP resource URIs (`muddown://room/current`, etc.), context window serialization format
- **Accessibility**: ARIA role mappings for container blocks
- **Conformance levels**: Text, Interactive, Full

### Shared Types (packages/shared)
- Block types, link schemes, container attributes (Room, NPC, Item, Combat, Dialogue)
- Wire protocol types (ServerMessage, ClientMessage)
- MCP resource URI types
- Conformance level enum
- Item definitions with discriminated unions (equippable/usable variants)
- Combine recipe and NPC combat stats types
- Character classes and stat definitions

### Parser (packages/parser)
- `parseBlocks()` — Extracts container blocks with attributes from MUDdown text
- `parseAttributes()` — Parses key=value pairs (string, number, boolean)
- `extractLinks()` — Finds all game links with scheme/target/displayText
- `parseSections()` — Splits block content by H2 headings
- `parse()` — Full document parser (frontmatter + blocks)

### Game Server (packages/server)
- WebSocket server on port 3300
- Player session management (auto-generated names)
- Demo world "Northkeep" with 24 rooms across 5 regions, all fully interconnected with bidirectional exits:
  - **northkeep** (6 rooms) — Town Square hub, Iron Gate, Guard Tower, Bakery Lane, Docks District, Temple of the Silver Moon
  - **market** (4 rooms) — Market Entrance, Market Square, Jeweler's Shop, Blacksmith's Forge
  - **harbor** (4 rooms) — Warehouse, Pier, Lighthouse, Smuggler's Cove
  - **northroad** (7 rooms) — North Road, Crossroads, Old Farm, Forest Edge, Deep Forest, Ruins Entrance, Ruins Hall
  - **catacombs** (3 rooms) — Catacombs Entrance, Ossuary, Sealed Chamber
- Commands: `go`, `look`, `examine`, `say`, `who`, `help`, directional shortcuts, `get`/`take`, `drop`, `inventory`, `equip`/`unequip`, `use`, `combine`, `talk`, `attack`, `flee`
- Item system: 31 item definitions across 22 rooms, with pickup/drop, equip slots (weapon/armor/accessory), usable effects, and 2 combine recipes
- NPC dialogue system: 16 NPCs with branching dialogue trees, `:::dialogue` block output, `talk` command with name matching
- Combat system: turn-based NPC combat using `:::combat` blocks, shared NPC HP across players, defeat tracking
- GitHub OAuth2 authentication with session management
- Database abstraction layer (`GameDatabase` interface) with SQLite adapter (`better-sqlite3`)
- Player persistence: room, inventory, equipment, HP saved and restored across sessions
- World state persistence: room items, NPC HP, defeated NPC tracking
- NPC respawn system (20-minute timer, restore to home room with full HP)
- Entity lifecycle hooks (`onCreate`, `onReset`, `onContact` — e.g., NPC greets player on room entry)
- Character creation: name, class (Warrior/Mage/Rogue/Cleric), starting stats
- Multi-player: players see each other, broadcast chat per room, arrival/departure messages
- All output is MUDdown format

### Website (apps/website)
- **Landing page** (`/`): Hero section, feature grid (6 cards), MUDdown code example
- **Specification** (`/spec`): Renders SPECIFICATION.md via `marked`
- **Login** (`/login`): GitHub OAuth2 login flow
- **Play** (`/play`): Full web MUD client with:
  - WebSocket connection to game server (auto-reconnect)
  - MUDdown-to-HTML renderer (headings, bold, italic, code, lists, tables, blockquotes, game links)
  - Clickable game links (go:, cmd:, examine on npc:/item:)
  - Command input with history (up/down arrows)
  - Character creation and selection panel (gated behind auth)
  - Inventory and equipment panel (sidebar, overlay, or off — persisted in localStorage)
  - Settings dropdown with inventory display mode
  - Dark theme with monospace terminal aesthetic
- **Shared layout**: Header nav with auth state and settings, footer, Google Fonts (Inter + JetBrains Mono)

---

## Big Ideas (from design discussions)

These are the visionary features discussed during planning. Each is a potential milestone or community contribution area.

### 1. LLM as Dungeon Master
Humans build rules, lore, and constraints (knowledge graph). An LLM generates all prose dynamically — room descriptions shift with weather, time, character mood, and history. No two players read the same description.

### 2. Ambient AI NPCs with Memory
NPCs that remember players across sessions. Conversational AI with RAG over each NPC's "life history" stored in a vector database. The blacksmith recalls you stiffed him; the guard mentions rumors you started.

### 3. Collaborative Worldbuilding as Gameplay
Players propose room descriptions, lore, and quest hooks as Markdown PRs. Community votes; accepted contributions become canon. The MUD is a living wiki you walk through. Git-based version control for the world.

### 4. Spatial Audio + Text Hybrid
Procedural spatial audio layered over text. Hear the waterfall before reading about it. Combat has sound cues. Distance-based footsteps for other players. Text for precision, audio for atmosphere.

### 5. Code is Magic
Spell-casting is literally programming. The game provides an API; magic is writing functions against it. TypeScript as the arcane language. Bugs in your spell cause backfire. Merges MUDs with creative coding education.

### 6. Federated MUD Protocol (ActivityPub for Dungeons)
Each server hosts a "realm." Portals between realms are federation links. Character identity travels across servers (like Mastodon handles). Each realm has its own rules and theme but shares the protocol.

### 7. Persistent Ecology Simulation
The world simulates ecosystems offline. Over-hunt wolves → deer overpopulate → famine. Players' aggregate actions reshape the world over weeks/months. AI summarizes what happened while you were away.

### 8. Screenreader-First Design
Lean into MUDs' accidental accessibility *intentionally*. Semantic Markdown + ARIA metadata. Design for screenreaders first, visual rendering second. A strength, not a constraint.

### 9. Branching Narrative via CRDT
Multiple players in the "same" room experience divergent realities based on choices. CRDTs track parallel narrative branches that collapse when players interact. Quantum-state storytelling.

### 10. Physical World Overlay
Tie MUD rooms to GPS coordinates. Walk through your real neighborhood described as a haunted forest. Other nearby players appear as NPCs/allies. AR text adventure without a camera — just MUDdown on your phone.

---

## Roadmap

### Phase 1 — Foundations (Current)
- [x] Monorepo scaffold (Turborepo + npm workspaces)
- [x] MUDdown specification v0.1.0 draft
- [x] Shared TypeScript types
- [x] MUDdown parser
- [x] WebSocket game server with demo world
- [x] Astro website with landing page, spec docs, playable client
- [x] MIT license, README, git init
- [x] Push to GitHub (create repo, initial commit)
- [x] Parser unit tests (validate spec compliance)
- [x] Fix any build/runtime issues found during testing

### Phase 2 — Playable Game
- [x] Expand Northkeep: 20+ rooms across multiple regions
- [x] Item system: pick up, drop, use, combine, equip
- [x] NPC dialogue trees (MUDdown `:::dialogue` blocks)
- [x] Basic combat system (MUDdown `:::combat` blocks)
- [x] GitHub OAuth2 authentication (stable player identity)
- [x] Database abstraction layer (interface + SQLite adapter via `better-sqlite3`)
- [x] Player persistence (save/load room, inventory, equipment, HP)
- [x] World state persistence (room items, NPC HP, defeated NPC tracking)
- [x] NPC respawn system (20-minute timer, restore to home room with full HP)
- [x] Entity lifecycle hooks (onCreate, onReset, onContact — e.g., NPC greets player on room entry)
- [x] Character creation (name, class, starting stats)
- [x] Inventory and equipment UI in the web client
- [x] OIDC login providers (Microsoft, Google, Discord) — extend OAuth2 foundation

### Phase 3 — Deployment & Infrastructure
- [x] Debian server setup (nginx + systemd)
- [x] DNS: point muddown.com to server
- [x] TLS via Let's Encrypt
- [x] nginx config: static site + WebSocket proxy to game server
- [x] CI/CD: GitHub Actions for build/test/deploy
- [x] Environment-based configuration (.env)
- [x] WebSocket rate limiting (token-bucket per session)
- [x] Privacy policy page and automated compliance tests
- [x] Security hardening (CSP directives, nginx header cleanup)
- [x] Dependabot for automated dependency updates
- [x] Branding: favicon, logo mark, PWA manifest, app icons
- [x] Landing page refresh (MUD/Markdown explainers, rendered example)
- [x] Features page showcasing implemented functionality
- [x] Licenses page (third-party dependency attribution)
- [x] Games directory with certification tiers and compliance checking
- [x] Discord community integration (widget, nav links)

### Phase 4 — AI Integration
- [x] MCP server: expose game state as MCP resources
- [x] LLM-powered NPC conversations (RAG over NPC backstories)
- [x] Improved in-game help system (detailed per-command usage, examples, LLM-aware `talk` tips)
- [x] AI game assistant: context-aware help, command suggestions
- [x] Tool-calling integration: AI agents can play the game
- [x] Dynamic room descriptions via LLM (based on player state)
- [x] Vector store for game lore/help (RAG for player questions)

### Phase 5 — Multi-Platform Client
- [x] Extract web client into standalone `packages/client`
- [x] React Native wrapper for iOS/Android
- [x] Tauri desktop app (lightweight native shell)
  - [x] Scaffold `apps/desktop` with Tauri v2 (`npm create tauri-app`)
  - [x] Add to Turborepo workspace config and wire `shared`/`client` dependencies
  - [x] Webview frontend consuming `@muddown/client` (renderer, connection, inventory)
  - [x] Character selection and creation screen
  - [x] Dark terminal aesthetic matching web client theme
  - [x] Native menu bar (File, View, Help) via Tauri menu API
  - [x] System tray icon with connection status indicator
  - [x] Native OS notifications (mentions, combat events, NPC contact)
  - [x] Window title reflecting current room name
  - [x] Keyboard shortcuts (Ctrl+L clear, Ctrl+K focus input)
  - [x] Persistent window size/position via Tauri `window-state` plugin
  - [x] GitHub Actions build matrix (macOS `.dmg`, Windows `.msi`, Linux `.AppImage`/`.deb`)
  - [x] Tauri auto-updater with signed GitHub Releases
    - [x] Enable signature verification in `tauri.conf.json` `updater` section — only accept signed releases; store the project's Ed25519 public key in `updater.pubkey` and document rotation procedure in `apps/desktop/UPDATER_KEYS.md`
    - [x] Validate update signatures against the public key in the auto-update handler (`tauri::updater` / JS `@tauri-apps/plugin-updater`) before applying any update
    - [x] Add integration test: upload a properly signed release and a forged (re-signed or tampered) release; verify the updater accepts the valid signature and rejects the invalid one
  - [ ] Apple notarization for macOS distribution
  - [ ] Windows Authenticode signing via SignPath (free open-source tier)
- [ ] Terminal client (renders MUDdown as styled terminal output)
- [ ] Telnet bridge (`packages/bridge`): legacy client support (plain telnet + TELNETS/TLS)

### Phase 6 — Mobile App Store Submission
- [ ] EAS Build setup (`eas.json` for development, preview, production profiles)
- [ ] Final app icons, splash screen, and adaptive icon artwork
- [ ] Apple Developer Program enrollment ($99/yr)
- [ ] Google Play Console enrollment ($25 one-time)
- [ ] Content moderation system (chat filtering, report/block)
- [ ] Offline / server-unreachable error states and graceful degradation
- [ ] iOS privacy manifest and `Info.plist` usage descriptions
- [ ] App Store metadata (description, keywords, screenshots, category)
- [ ] Google Play metadata (listing, feature graphic, screenshots, content rating)
- [ ] TestFlight beta distribution and internal testing
- [ ] Google Play internal/closed testing track
- [ ] App Store and Google Play submission

### Phase 7 — Federation & Social
- [ ] Federation protocol design (realm discovery, portal linking)
- [ ] Cross-server character identity
- [ ] Player profiles and persistence across federated servers
- [ ] Collaborative worldbuilding PRs (propose/vote/merge rooms)
- [ ] World event system (server-wide narrative arcs)

### Phase 8 — Advanced Features
- [ ] Persistent ecology simulation
- [ ] Spatial audio engine
- [ ] Code-as-magic scripting API
- [ ] Branching narrative CRDT system
- [ ] GPS/physical world overlay mode
- [ ] Accessibility audit and WCAG 2.2 compliance

---

## Technical Stack Summary

| Component | Technology |
|-----------|-----------|
| Language | TypeScript 5.5+ |
| Runtime | Node.js 20+ |
| Build | Turborepo |
| Server transport | ws (WebSocket) |
| Website | Astro 4 |
| Markdown rendering | marked |
| Mobile client | React Native / Expo |
| Desktop client | Tauri v2 (Rust shell + webview) |
| AI | Vercel AI SDK + @ai-sdk/anthropic (NPC dialogue, hints, room descriptions, lore RAG) |
| Database | SQLite via better-sqlite3 (player state, world state, auth sessions) |
| Vector store | In-memory TF-IDF with cosine similarity (lore/help RAG) |
| Deployment | Debian, nginx, systemd, Let's Encrypt |

---

## Development Commands

```bash
# Install all dependencies
npm install

# Build everything
npm run build

# Start game server (port 3300)
cd packages/server && npm start

# Start website dev server (port 4321)
cd apps/website && npm run dev

# Run tests
npm test
```

---

*This plan is a living document. Update as the project evolves.*
