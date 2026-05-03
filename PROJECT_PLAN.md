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
│   └── bridge/         📁 Telnet bridge — TCP/TLS proxy to WebSocket game server
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
  - [x] Apple notarization for macOS distribution
    - [x] Entitlements.plist with hardened runtime permissions (JIT, unsigned executable memory)
    - [x] Tauri `bundle.macOS` config (minimum system version, entitlements, DMG layout)
    - [x] CI notarization verification step (`xcrun stapler validate` on the inner `.app` after mounting the `.dmg` read-only, plus `spctl --assess --type execute` to confirm Gatekeeper acceptance)
    - [x] UPDATER_KEYS.md expanded with full Apple notarization setup guide
    - [x] D-U-N-S number assigned for StickMUD Entertainment LLC
    - [x] Apple Developer Program enrollment ($99/yr, requires D-U-N-S; single enrollment covers macOS and iOS)
    - [x] Provisioning helper script (`scripts/setup-apple-signing.sh`) — consent-gated, idempotent, fork-aware: generates a 2048-bit RSA key + CSR locally, signs an ES256 JWT for App Store Connect, POSTs the CSR to `/v1/certificates` with `certificateType=DEVELOPER_ID_APPLICATION`, bundles the issued cert into a `.p12`, and pushes all six `APPLE_*` secrets to GitHub. Requires a one-time App Store Connect API key (Admin role) and an app-specific password — both are portal-only steps.
    - [x] Developer ID Application certificate generation (manually via Apple's developer portal — `scripts/setup-apple-signing.sh` automates the API path; the manual portal flow used for the first cert is documented in `scripts/README.md`)
    - [x] App-specific password for notarization (manual: `account.apple.com` → Sign-In and Security → App-Specific Passwords)
    - [x] Configure 6 Apple CI secrets in GitHub Actions: `APPLE_CERTIFICATE` (base64-encoded `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID` — pushed via `gh secret set` with `printf '%s'` (no trailing newline; `security import -P` is byte-exact and rejects 33-byte passwords with "MAC verification failed")
    - [x] First successful notarization run on CI: PR #98 / run 25279927676 (2026-05-03) — both `aarch64-apple-darwin` and `x86_64-apple-darwin` legs signed, notarized, stapled, and `spctl`-validated. Workaround: tauri-bundler's env-driven `security import` is broken on `macos-15-arm64` runners, so the workflow imports the `.p12` into a temp build keychain manually (`security import -k $RUNNER_TEMP/build.keychain-db -T /usr/bin/codesign …`) and forwards only `APPLE_SIGNING_IDENTITY` to tauri-action. See `.github/workflows/desktop-build.yml` step "Import Apple cert into build keychain".
    - [ ] Verify minimum entitlements under hardened runtime (test removing `allow-unsigned-executable-memory`)
  - [ ] Windows Authenticode signing via Microsoft Artifact Signing (formerly Trusted Signing / Azure Code Signing)
    - [x] Create Azure account / subscription (Pay-As-You-Go) for StickMUD Entertainment LLC
    - [x] Configure `bundle.windows.signCommand` in `tauri.conf.json` to invoke `signtool` with the Artifact Signing dlib (signs `.exe` inside the `.msi` during bundling)
    - [x] Add `azure/login@v2` (OIDC) and the Artifact Signing Client Tools install (`winget install Microsoft.Azure.ArtifactSigningClientTools`) to the Windows leg of `desktop-build.yml`
    - [x] Author idempotent provisioning scripts (`scripts/setup-signing.sh`, `scripts/setup-signing-post-iv.sh`) — consent-gated, fork-aware, env-overridable
    - [x] Run pre-IV provisioning (`scripts/setup-signing.sh`):
      - [x] Register `Microsoft.CodeSigning` resource provider on the subscription
      - [x] Create resource group `rg-signing` (East US)
      - [x] Create Artifact Signing account `muddown-signing` (Basic SKU, $9.99/mo)
      - [x] Grant `Artifact Signing Identity Verifier` role to the maintainer
      - [x] Create Microsoft Entra app `github-muddown-signing` with a GitHub OIDC federated credential for `refs/heads/main` — no long-lived secrets (tag-triggered FIC deferred until release flow is wired)
      - [x] Configure 6 GitHub Actions variables (non-secret; OIDC handles auth): `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_CODE_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_ACCOUNT_NAME`, `AZURE_CERT_PROFILE_NAME`
    - [x] Submit Public Trust Identity Validation as Organization (StickMUD Entertainment LLC) — 1–20 business days
    - [x] Run post-IV finalization (`scripts/setup-signing-post-iv.sh`):
      - [x] Create Public Trust certificate profile `muddown-public-trust` bound to the validated identity
      - [x] Assign `Artifact Signing Certificate Profile Signer` role to the Entra app, scoped to the cert profile (least privilege)
      - [x] Flip `WINDOWS_SIGNING_ENABLED` GitHub Actions variable to `true` (the workflow gates Azure login, winget install, and `signtool verify` on this variable, and strips `bundle.windows.signCommand` from `tauri.conf.json` when it's not `'true'`)
      - [x] Trigger first signed Windows build via `gh workflow run` (run [25256036052](https://github.com/MUDdown/MUDdown/actions/runs/25256036052) dispatched 2026-05-02; entered the signing path but bundling failed with `program not found` — see verification item below)
    - [x] Verify signed `.msi` with `signtool verify /pa /v` in CI; confirm Authenticode chain on a clean Windows VM. Achieved via the workflow's `Verify Authenticode signature (Windows)` step, which now passes on `main` after the object-form `signCommand` fix (PR #95) — the prior string form was shell-word-split by tauri-bundler, mangling backslashes in Windows paths and producing `os error 123` (`ERROR_INVALID_NAME`). The first signed `MUDdown_0.1.0_x64_en-US.msi` was published to the `desktop-v0.1.0` release on 2026-05-02.
    - [ ] Confirm SmartScreen reputation accrual after first public release (Microsoft uses telemetry on signed binaries to build trust over weeks)
  - [ ] Desktop distribution & downloads (publish signed builds for end users)
    - [x] `tauri-action` wired in `desktop-build.yml`: pushes to `main` that touch `apps/desktop/**`, `packages/client/**`, `packages/shared/**`, or the workflow itself re-publish (or update) the GitHub Release tagged `desktop-v<version>` (where `<version>` is read from `apps/desktop/src-tauri/tauri.conf.json` by the `get-version` job). Each qualifying push uploads platform bundles (`.msi`, `.dmg`, `.AppImage`/`.deb`/`.rpm`), updater `.sig` files, and the `latest.json` updater manifest. PRs and other branches build but do not publish.
    - [ ] **Trigger hardening (follow-up):** even with path filters, the current model means any qualifying change to `main` re-uploads artifacts under the same tag whenever the `tauri.conf.json` `version` hasn't been bumped. Migrate `desktop-build.yml` to one of:
      - **Tag-triggered** (preferred): publish only when a `desktop-v*` git tag is pushed (`on.push.tags: ['desktop-v*']`). Day-to-day pushes to `main` still build and verify, but never publish.
      - **`workflow_dispatch` only** for releases, with a separate CI job for build-only verification on `main`.
      - At minimum, add a guard step that skips the publish step when the tag already exists at the current `tauri.conf.json` version (prevents accidental re-publishes of an unchanged version).
    - [ ] **First public release version:** bump `apps/desktop/src-tauri/tauri.conf.json` `version` to `1.0.0` (the workflow's `get-version` job reads this file; `apps/desktop/package.json` is no longer the source of truth for release tags) only as part of the dedicated release commit. Tag the release commit `desktop-v1.0.0` and (post trigger-hardening) push the tag to fire the release workflow. Until then, leave the version at `0.1.0` so the existing publish-on-push flow keeps producing `desktop-v0.1.0` rolling builds for internal verification — the website's `/download` page and `/download/[platform]` permalinks intentionally filter to `desktop-v[1-9].x` tags so these v0.x builds stay invisible to end users until the 1.0.0 cut.
    - [ ] First successful signed release published to `https://github.com/MUDdown/MUDdown/releases/tag/desktop-v<version>`. Prerequisites: PR #92 merged (done), the post-IV Windows signing flip complete (`WINDOWS_SIGNING_ENABLED=true` and the Public Trust certificate profile bound to the Entra app), and macOS notarization secrets configured (Phase 5 macOS Apple track).
    - [x] Downloads page in `apps/website` (`/download`) — fetches the GitHub Releases API at Astro build time, renders an OS-detected primary button plus per-platform sections with file sizes, SHA256 digests, and a "Verify the signature" expandable section (Authenticode on Windows, notarization staple on macOS); gracefully degrades to a "release pending" notice when no release exists yet
    - [x] `/download/[platform]` Astro redirect pages (`macos`, `macos-arm64`, `macos-x64`, `windows`, `linux`, `linux-appimage`, `linux-deb`, `linux-rpm`) — build-time-resolved URLs with JS `location.replace` so external permalinks always point at the latest signed asset
    - [x] Homepage CTA: "Download Desktop App" button added to the hero next to "Play Now" (links to `/download`, which shows release status until the first signed release lands)
    - [x] Wiki updates: `Desktop-App.md` and `Getting-Started.md` revised to point users at the Downloads page (and the signature-verification steps) instead of build-from-source instructions
    - [x] Features page: "Signed desktop downloads" entry added under the Infrastructure section
    - [ ] **Re-trigger website deploy when desktop release publishes.** Today the website snapshots GitHub Releases at Astro build time, while `desktop-build.yml` publishes the desktop release in a separate workflow. On the same push the website can deploy *before* the release/assets exist and then stay stale on `/download` until another site deploy happens. Fix by adding a `release: { types: [published] }` (or `workflow_run` after `desktop-build.yml`) trigger to the website's deploy workflow, so a fresh static build always runs after a desktop release lands. Alternatively, switch `/download` to a small client-side fetch of the Releases API to remove the build-time dependency entirely.
  - [ ] **Mature CI/CD: tier the build pipeline into PR / nightly / RC / release workflows.** Today `desktop-build.yml` does triple duty (PR validation, internal verification, and release publish) and slows PR feedback by ~30 minutes per macOS leg waiting on Apple's notary queue. Split into four workflows with distinct trust models:
    - [ ] `pr-validate.yml` (trigger: `pull_request` from any source). Build, bundle, and unit-test the four targets. **No signing, no notarization, no publish.** Fork PRs run the same path (no secrets are exposed). Goal: keep PR feedback under 10 minutes. Catches compile errors, packaging regressions (`bundle_dmg.sh` failures, MSI generation), and updater-script test breakage.
    - [ ] `nightly.yml` (trigger: `schedule: cron: 0 7 * * *` UTC + `workflow_dispatch` on `main`). Full sign + notarize + Authenticode pipeline, single rolling tag (`desktop-nightly`), uploads to a GitHub Release that auto-replaces. Notary submissions: 1 build/night × 2 macOS arches × ~30 days = 60/month, well under Apple's per-Apple-ID rate limit. Catches dependency drift, runner-image regressions, and Apple/Microsoft signing-pipeline breakage before a release.
    - [ ] `release-candidate.yml` (trigger: `push` to `release/x.y` branches). Same pipeline as final, but uploads to a **draft** GitHub Release tagged `desktop-vX.Y.Z-rcN`. Manual review gate before a final tag is cut.
    - [ ] `release.yml` (trigger: `push` of tag matching `desktop-v*` *without* an `-rc` suffix). GitHub Actions tag-push triggers don't carry branch context (`github.ref` is `refs/tags/…`), so the "tag must be cut from `release/*`" rule is enforced *inside the job*: the first step calls `git branch -r --contains $GITHUB_SHA` and aborts if no `release/*` branch contains the tagged commith triggers don't carry branch context (`github.ref` is `refs/tags/…`), so the "tag must be cut from `release/*`" rule is enforced *inside the job*: the first step calls `git branch -r --contains $GITHUB_SHA` and aborts if no `release/*` branch contains the tagged commit. Promotes the matching draft to published, generates updater `latest.json`, posts the changelog. Gated by a GitHub Environment named `production` with required reviewers (single-maintainer-aware: see solo-maintainer note below).
    - [ ] **Solo-maintainer environment approval.** GitHub's required-reviewer policy on `production` cannot self-approve, but a single-maintainer setup can use **wait timers** (15-minute delay on the `production` environment) plus a separate `release-approver` GitHub team containing only the maintainer; this still flags every publish in the Actions UI for explicit click-through, which has caught real \"wait, I tagged the wrong commit\" mistakes in similar setups. Document the rationale in `Deployment-Guide.md`.
    - [ ] **Branch protection on `release/*`** matching `main`: PRs only, status checks required, linear history. Patch fixes for a release line happen via cherry-picks from `main` into `release/x.y`, never direct pushes.
    - [ ] **Concurrency groups.** Add `concurrency: { group: desktop-${{ github.ref }}, cancel-in-progress: false }` to nightly and RC workflows to coalesce rapid pushes; release workflow uses `cancel-in-progress: false` to avoid aborting a partially-published release mid-flight.
    - [ ] **Fork PR safety.** Fork builds run the full `pr-validate.yml` pipeline through the bundle step (catches packaging-only flakes that wouldn't surface in `cargo build`), but the `tauri-action` env never sees signing secrets because the workflow is keyed off `pull_request` (not `pull_request_target`). This is best-practice and intentional \u2014 keep `pull_request_target` out of any signing-adjacent workflow.
    - [ ] Retire `desktop-build.yml` after the four-workflow split is verified through one full release cycle.
  - [ ] **Update channels: ship `stable`, `nightly`, `rc` updater feeds.** Tauri's updater plugin supports per-channel update URLs via `tauri.conf.json` `plugins.updater.endpoints` and a runtime `setChannel` API. Wire three feeds:
    - [ ] `latest.json` (stable) \u2014 published by `release.yml` from final `desktop-v*` tags. Default channel for downloads from the website.
    - [ ] `nightly.json` — published by `nightly.yml`. Auto-replaces nightly. Self-identifies version as `<X.Y.Z>-nightly.<YYYYMMDD>+<sha>` where `<X.Y.Z>` is the *upcoming* release version read from `apps/desktop/src-tauri/tauri.conf.json`. Semver orders pre-release identifiers below their base (`1.2.0-nightly.20260503` < `1.2.0`), so a user on the nightly channel sees a clean upgrade path the moment `1.2.0` ships stable.tauri/tauri.conf.json`. Semver orders pre-release identifiers below their base (`1.2.0-nightly.20260503` < `1.2.0`), so a user on the nightly channel sees a clean upgrade path the moment `1.2.0` ships stable.
    - [ ] `rc.json` \u2014 published by `release-candidate.yml` from `release/*` branches. Version like `<X.Y.Z>-rc<N>+<sha>`.
    - [ ] **In-app channel switcher.** Add a Settings → Updates panel to the desktop app: radio buttons for `Stable / Nightly / Release Candidate`, an explanatory paragraph ("Nightly builds may be unstable…"), and a confirmation dialog when switching to a non-stable channel. Persist the selection via `tauri-plugin-store` (the desktop app's general settings store; the existing `window-state` plugin handles only window geometry). On startup the updater checks the active channel's feed.
    - [ ] **Channel preference reset.** Switching channels updates the stored preference and the active feed URL. Because nightly and RC versions are pre-release identifiers under the upcoming stable (e.g. `1.2.0-nightly.…` < `1.2.0`), semver naturally treats stable as an upgrade once it ships, so no force-install path is needed. The Settings panel just needs to (a) write the new channel to the store and (b) trigger an immediate update check against the new feed.te the new channel to the store and (b) trigger an immediate update check against the new feed.
    - [ ] **Tests.** End-to-end test that builds a fake nightly + RC + stable release, points the test app at each feed in turn, and verifies (a) signature verification still works on each channel and (b) channel switching downloads the right artifact.
  - [ ] **Discord-style background update UX.** Today Tauri's default updater prompts the user with a modal on launch. Replace with a Discord/Sparkle-style flow:
    - [ ] **Silent background check** on app launch and every 4 hours while running. No UI unless an update is found.
    - [ ] **Download in background** to a staging directory. Show an unobtrusive \"Update ready \u2014 restart to apply\" pill in the system tray and main-window status bar.
    - [ ] **Apply on quit/restart.** Tauri 2 supports `installAndRelaunch()`; on macOS we additionally swap the `.app` bundle in a `posix_spawn` helper so the running process can replace itself cleanly. Windows and Linux use the existing in-place updater path.
    - [ ] **Forced critical updates.** Allow the release manifest (`latest.json` extension) to mark a version as critical (security fix). The desktop app then refuses to launch the older version after a 7-day grace period, prompting an immediate update.
    - [ ] **Rollout staging.** Optional `rollout` field in the release manifest (e.g. `rollout: 0.25` = 25% of users that day). Client deterministically buckets itself by a hash of `installation-id` (already stored locally for telemetry-opt-in) and only updates if its bucket falls under the rollout fraction. Lets us catch a bad release without recalling it from 100% of installs.
    - [ ] **Updater UI components in `apps/desktop/src/`** \u2014 toast notification, tray menu \"Restart to update\" item, settings panel.
    - [ ] **Progress reporting.** Show download progress in tray tooltip; never block UI on update I/O.
    - [ ] **Failure handling.** On signature-verification failure: log the failed signature, surface a dismissible banner asking the user to reinstall from the website, and *do not* replace the running binary.
- [x] Terminal client (renders MUDdown as styled terminal output)
  - [x] `TerminalTheme` interface in `packages/client` — maps block types to chalk style functions (glamour pattern); plain text = identity functions
  - [x] Add `renderTerminal(muddown, options)` to `packages/client` — pure function returning styled string, never writes to stdout; shared by terminal client and telnet bridge
  - [x] Default dark theme: room titles bold green, combat red, system yellow, dialogue cyan, bold/italic/code inline formatting
  - [x] Width-aware word wrap (accepts column count, defaults to 80)
  - [x] Game link rendering: OSC 8 hyperlinks for modern terminals, `TEXT (command)` fallback (gh-style), numbered shortcut mode
  - [x] Plain text mode (`{ ansi: false }`) — theme with identity functions for basic telnet clients
  - [x] Scaffold `apps/terminal` workspace, wire `client`/`shared` deps, add to Turborepo
  - [x] Node `readline` input loop with `CommandHistory` integration (up/down arrows)
  - [x] `MUDdownConnection` for WebSocket, auto-reconnect status in prompt
  - [x] Auth support (`--token` CLI flag or interactive prompt)
  - [x] `--server` flag for custom WebSocket URL (default `wss://muddown.com`)
  - [x] `--link-mode` flag: `osc8` (default), `numbered`, `plain` — `osc8` is host-terminal mode (real OSC 8 for external URLs, dimmed `TEXT (command)` hint for game links since host terminals can't execute MUD commands). Distinct from the bridge's `osc8-send` mode (see telnet bridge section), which emits OSC 8 `send:<command>` URIs only valid when the client advertises `OSC_HYPERLINKS_SEND`.
  - [x] `--theme` flag for future custom theme support
  - [x] Inventory and hint display using terminal renderer
  - [x] Unit tests for terminal renderer (ANSI output assertions)
  - [x] Interactive startup wizard: fetches games directory, numbered game picker, browser-based OAuth login with token-poll (no copy/paste), provider picker, ws-ticket exchange (bypassed if `--server`/`--token` flags are passed)
- [x] Telnet bridge (`packages/bridge`): legacy client support (TLS-only)
  - [x] Scaffold `packages/bridge` workspace, wire `client`/`shared` deps, add to Turborepo
  - [x] TLS listener (`tls.createServer()`) on port 2323 (configurable via `BRIDGE_PORT`, `TELNET_TLS_CERT`, `TELNET_TLS_KEY`)
  - [x] Telnet protocol negotiation: IAC DO/WILL for NAWS (terminal width), TTYPE (terminal detection), ECHO suppression (password prompts)
  - [x] ANSI capability detection via TTYPE negotiation; fall back to plain text for basic clients
  - [x] Bridge-as-proxy architecture: each telnet session creates a `MUDdownConnection` WebSocket to the game server (configurable via `GAME_SERVER_URL`)
  - [x] MUDdown rendering via `renderTerminal()` — ANSI mode for capable clients, plain text fallback, column-width from NAWS
  - [x] Game link rendering: plain mode default (`North (go north)`), numbered shortcut mode (`North [1]`) togglable via `linkmode` command; `osc8-send` mode (distinct from the terminal client's `osc8` mode) auto-enables when the client advertises `OSC_HYPERLINKS_SEND`, emitting OSC 8 `send:<command>` URIs that clients like Mudlet / Fado / MudForge execute on click
  - [x] Line-buffered input with command echo, backspace handling, and per-session command history
  - [x] Auth flow: `login` command prints browser URL, polls `token-poll` endpoint, exchanges for ws-ticket (reuses terminal client pattern)
  - [x] Guest play: connect without auth for immediate anonymous play
  - [x] Character creation and selection via inline text prompts (name, class picker)
  - [x] Telnet keepalive: periodic NOP to detect dead connections; map to WebSocket ping/pong
  - [x] Graceful shutdown: drain connections on SIGTERM and dispose active sessions
  - [x] Connection banner: MUDdown ASCII art, server name, version, login instructions on connect
  - [x] Local bridge commands: `quit`/`exit`, `login`, `linkmode`, `legend`
  - [x] Rate limiting: inherited from WebSocket session (bridge proxies through game server's `TokenBucket`)
  - [x] Configuration: `.env` support (`BRIDGE_PORT`, `TELNET_TLS_CERT`, `TELNET_TLS_KEY`, `GAME_SERVER_URL`, `PUBLIC_BASE_URL`)
  - [x] Deployment: systemd unit file (`muddown-bridge.service`), firewall rules documentation
  - [x] Unit tests: telnet negotiation, rendering integration, auth flow, connection lifecycle
  - [x] Wiki page: `Telnet-Bridge.md` with connection instructions, supported clients, feature comparison
  - [x] OSC 8 hyperlinks with Mudlet capability detection
    - [x] NEW-ENVIRON (RFC 1572) telnet option negotiation — parse client-advertised USERVARs into session capability set
    - [x] OSC 8 hyperlink wrapping for the login URL when `OSC_HYPERLINKS` is advertised (plain URL fallback for other clients)
    - [x] Auto-enable `osc8-send` link mode and map MUDdown game links to OSC 8 `send:` URIs when `OSC_HYPERLINKS_SEND` is advertised (supported by Mudlet, Fado, MudForge, and other OSC 8-send-aware clients)
    - [x] Tooltip and right-click menu metadata for game links (behind `OSC_HYPERLINKS_TOOLTIP` / `OSC_HYPERLINKS_MENU` capabilities)
- [ ] Homebrew tap (`MUDdown/homebrew-tap`): `brew install MUDdown/tap/muddown`
  - [ ] Single-binary build (e.g., `pkg` or `bun compile`) — no Node.js runtime dependency for users
    - [ ] Multi-architecture builds: separate Intel (`x86_64`) and Apple Silicon (`arm64`) binaries
    - [ ] Universal binary (`lipo`) or per-arch bottles so `brew install` works natively on both
  - [ ] Homebrew formula with versioned GitHub Release download and SHA256 verification
  - [ ] CI automation: GitHub Actions updates formula on new release
    - [ ] Run `brew audit --strict` and `brew test` in CI to catch formula regressions
    - [ ] Automated bottle creation (via `brew bottle`) and upload to GitHub Releases on each tag
  - [ ] Tap README with installation instructions, prerequisites, and troubleshooting (e.g., Gatekeeper, PATH issues)

### Phase 6 — Mobile App Store Submission
- [ ] EAS Build setup (`eas.json` for development, preview, production profiles)
- [ ] Final app icons, splash screen, and adaptive icon artwork
- [ ] Apple Developer Program enrollment (same enrollment as Phase 5 macOS notarization)
- [ ] Google Play Console enrollment ($25 one-time)
- [ ] Content moderation system (chat filtering, report/block)
- [ ] Offline / server-unreachable error states and graceful degradation
- [ ] iOS privacy manifest and `Info.plist` usage descriptions
- [ ] App Store metadata (description, keywords, screenshots, category)
- [ ] Google Play metadata (listing, feature graphic, screenshots, content rating)
- [ ] TestFlight beta distribution and internal testing
- [ ] Google Play internal/closed testing track
- [ ] App Store and Google Play submission
- [ ] **Surface mobile apps on `/download`** once App Store / Play Store listings are live. The desktop machinery (Releases API, digests, `minisign` verify drawer, arch detection) does not apply to store-distributed apps; mobile sections are simpler:
  - [ ] Add `iOS` and `Android` sections to `apps/website/src/pages/download.astro` with hard-coded App Store and Play Store badge links (Apple's marketing-tools-generated SVG badges; Google Play's official badge). Include screenshots and a one-line "installed and verified by the App Store / Play Store" note in place of the digest/verify UI.
  - [ ] Extend the `Resolution` discriminated union in `apps/website/src/pages/download/[platform].astro` with `ios` and `android` cases that return a single store URL, so `/download/ios` and `/download/android` permalinks 302 to the store listings.
  - [ ] Update the OS-detect script in `download.astro` to route `iPhone|iPad|iPod` and `Android` UAs to the matching store CTA instead of the current "use the web client at /play" fallback. Keep the web-client message as the secondary action.
  - [ ] Add optional TestFlight public-link and Play Store internal-track callouts for pre-1.0 builds (gated on a flag/config, not on the Releases API).
  - [ ] Update [apps/website/src/pages/features.astro](apps/website/src/pages/features.astro) to mention App Store / Play Store availability and remove any "coming soon" mobile copy.
  - [ ] Update wiki Mobile-App page with install instructions and store links.

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

## Backlog: Bridge Startup Menu Review (2026-04-26)

Items surfaced during the `feat/bridge-startup-menu` review that were not
landed on that PR. Grouped by area; pick up in follow-up PRs.

### Bridge — login flow

- [ ] **Distinguish transient vs. permanent provider failures.**
  `fetchProviders` shows "No login providers available on this server" for
  any failure including a 503 during a game-server restart. Treat 4xx as
  "genuinely none" and 5xx / network errors as transient with a "try again
  shortly" hint.
- [ ] **Cancel orphaned login nonces server-side.**
  When the bridge gives up on a poll (timeout or user picks `guest`),
  optionally `POST /auth/cancel-login?nonce=…` so the entry is evicted
  before the 10-minute server TTL. Marginal value — sweep already handles
  it — but tightens the audit story.
- [ ] **Align nonce TTLs.** Bridge polls for 2 minutes; server keeps
  completed-login entries for 10 minutes. Pick one window or document the
  asymmetry explicitly.
- [ ] **Countdown / progress hint while polling.** Update the "Waiting for
  login…" line every ~30s so users know the prompt is alive.
- [ ] **Per-provider nonces in the picker.** The picker now races
  `pollForToken` against the prompt so the first clicked OSC 8 link
  short-circuits the choice — this resolves the "click discord, type 2
  for github, get authenticated as discord" footgun in the common
  flow. The deeper fix (server-side `(nonce, provider)` keying of
  `completedLogins`, rejecting mismatches at poll time) is still
  worth doing as defense-in-depth. Original report: Greptile on
  PR #83.

### Bridge — tests

- [ ] **Cover `runStartupMenu`** — choice routing for `[1]`/`[2]`/`[3]`,
  invalid input handling, `loginInProgress` propagation, and the
  guest-fallback path. Will need a small test-hook export (analogous to
  `__resetMsspCacheForTesting`) plus mocked `fetchProviders` /
  `pollForToken`.
- [ ] **Cover `handleLogin`** — zero-providers short-circuit, single-vs-
  multi provider rendering, OSC 8 hyperlink presence when capability is
  set, retry loop including the `guest` escape, `pollForToken` exception
  recovery, and `SessionDisposedError` propagation from inside the loop.
- [ ] **Cover `handleCharacterSelection` / `handleCharacterCreation`
  failure paths** — picker out-of-range, `postSelectCharacter` false,
  `fetchWsTicket` null, `postCreateCharacter` false, and empty character
  name. Each should return false and let the caller fall back to guest.

### General — operator UX

- [ ] **`npm run dev:tls` script for the bridge** that generates a
  self-signed cert + starts the bridge in one step, so contributors can
  smoke-test against Mudlet without hand-rolling `openssl` invocations.

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
