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

### Phase 9 — Discord Integration

Two independent workstreams that surface MUDdown inside the existing MUDdown Discord server without depending on the Discord Social SDK (a closed C++/Unity/Unreal SDK aimed at packaged native games — not a fit for our web/RN/Tauri/Node clients). "Sign in with Discord" is already shipped via the standard OAuth provider; the work below is additive.

#### 9a. Discord-as-client bridge (`packages/discord-bridge`)

A new workspace parallel to `packages/bridge` (telnet) that lets a Discord user play MUDdown from inside the MUDdown Discord server. Same architectural shape as the telnet bridge — a stateless proxy that holds one WebSocket connection to the production game server per Discord player and translates between Discord messages and the MUDdown wire envelope. **No ANSI**, no OSC 8 — Discord components (embeds + buttons) replace clickable telnet links.

Channel model: a dedicated `#play` (or `#game`) channel on the MUDdown Discord server is the public hub for slash commands, but the primary play surface is **the bot's DM with each player** (one DM thread per Discord user, one WebSocket session behind it). Public-channel slash commands are convenience entry points that funnel the player into their DM session.

**Discord activity overlap (bridge DM + desktop Rich Presence).** A player can show two Discord-facing signals at the same time: (1) active gameplay via the bridge DM session and (2) desktop Rich Presence from the `discord_rich_presence` setting. This is valid and expected. User guidance should recommend either disabling `discord_rich_presence` while actively playing through Discord DM for a single activity signal, or leaving both enabled if the user wants both surfaces visible.

Mapping (the design choices that need fixing now, not later):

| MUDdown side | Discord side | Notes |
|---|---|---|
| Player connection | One Discord user ↔ one WebSocket session, keyed by Discord user ID linked to a MUDdown account via the existing Discord OAuth identity link in the auth tables | Unauthenticated/unlinked users get a "link your account first" reply with a deep link |
| Player input | Plain DM text → raw command line (same as telnet); slash commands (`/play`, `/who`, `/quit`, `/switch`) for convenience and discoverability | DMs are the primary channel |
| Server output | One Discord **embed per envelope** (room / system / narrative / combat / dialogue), title = block kind, description = MUDdown body run through a Discord-flavored Markdown renderer in `packages/discord-bridge/src/render.ts` (reuses the `parser` AST) | |
| Interactive links (`go:`, `cmd:`, `item:`, `npc:`) | Discord **buttons** under the embed (5 per row × 5 rows = 25 max); overflow collapses into a select menu. Button `custom_id` encodes the link URI; the bridge re-injects it as a command on click | |
| Container blocks | Embed `color` per type (room=blue, system=red, combat=orange, dialogue=green, narrative=neutral) | Mirrors ARIA role intent visually |
| Long output | Discord's 4096-char embed-description limit → split across multiple embeds in one message; paginated if >10 | |
| Frontmatter / hidden meta | Stripped before render | |
| Rate limits | Per-channel debounce + Discord's own 5/5s limits — coalesce redundant `room` re-renders | |

**Multi-character support.** MUDdown already has multiple characters per account (`CharacterRecord`, `getCharacterById`), so the bridge needs an explicit character-selection step:

- On first DM, the bridge replies with a list of the linked account's characters as buttons (`Pick a character` embed). Clicking one opens the WebSocket and starts play.
- `/switch` slash command (or `quit` then re-DM) tears down the session, returns to the picker, and starts a new session under the chosen character.
- The bridge stores `lastCharacterId` persistently in `GameDatabase` on the Discord identity link row (`identity_links.last_character_id`) so a fresh DM auto-resumes the most recent character with a "Switch?" button visible at the top of the first room embed.
- Only one active character per Discord user at a time (matches the WebSocket "one session per connection" invariant).

Out of scope (deliberately, like the telnet bridge): voice, lobbies, account creation, world editing.

Tasks:
- [x] Scaffold `packages/discord-bridge` (depends on `client`, `shared`, `parser`; runtime dep on `discord.js`) — shipped in `11c13c7`
- [x] Discord bot application registration + invite flow + `MUDDOWN_DISCORD_BOT_TOKEN` env var (deploy-side) — documented in `MUDdown.wiki/Discord-Setup.md`
- [x] Connection manager: Discord user ID → WebSocket session, with idle eviction matching the telnet bridge — shipped in [#106](https://github.com/MUDdown/MUDdown/pull/106) (idle eviction, reconnect DMs, `/who` status)
- [x] MUDdown → Discord renderer: AST → embeds + components, with the constraints above — shipped in `11c13c7`
- [x] Slash commands (`/play`, `/who`, `/switch`, `/quit`) registered globally for the MUDdown guild — shipped in `11c13c7`
- [x] DM intake: route plain text from a player's DM to their session as a command line — shipped in `11c13c7`
- [x] Button/select handlers: re-inject link URIs as commands; character-picker buttons — shipped in `11c13c7`
- [x] Account linking: leverage existing Discord OAuth; persist Discord user ID ↔ account mapping in `GameDatabase` by extending `IdentityLinkRecord` for Discord links (`provider = "discord"`, `providerId = discord_user_id`) and persisting `lastCharacterId` on the same record (`last_character_id` column)
- [x] Multi-character flow: picker on first DM, `/switch` mid-session, resume from persisted `IdentityLinkRecord.lastCharacterId`
- [x] DB migration (mandatory for Discord bridge persistence):
  - [x] Add nullable `last_character_id` to `identity_links` (`ALTER TABLE identity_links ADD COLUMN last_character_id TEXT NULL REFERENCES characters(id) ON DELETE SET NULL`)
  - [x] Backfill existing rows: keep `last_character_id = NULL` for all existing links (including existing Discord links)
  - [x] Update `GameDatabase` + SQLite adapter reads/writes so Discord link lookups expose `providerId` as `discord_user_id` and persist/load `lastCharacterId` via `last_character_id`
- [x] Tests (`vitest`): renderer fixtures (envelope → expected embed/components shape), connection-manager unit tests, account-linking round trip, character-switch flow — 183 tests across 10 files
- [x] Systemd unit (`deploy/muddown-discord-bridge.service`) parallel to `muddown-bridge.service` — shipped in [#107](https://github.com/MUDdown/MUDdown/pull/107) (env-tunable config + `setup.sh` wiring)
- [x] Wiki: new `Discord-Bridge.md` page (sibling to `Telnet-Bridge.md`); link from `_Sidebar.md` and `Home.md`
- [ ] Skill: new `.github/skills/discord-bridge/SKILL.md` covering renderer invariants, button-id encoding, the no-auto-message rule, and the multi-character picker flow
- [ ] Plugin: add `discord-bridge` to the `muddown-operator` plugin (`.github/plugins/muddown-operator/skills/discord-bridge/` directory symlink + README table + AGENTS.md skills table)

##### Public feed channel (`scope="world"` broadcasts)

A dedicated Discord channel that mirrors broadcast-eligible server announcements (boot, scheduled reboot, shutdown, public events) into a single shared channel — separate from the per-user DM gameplay flow. Spec, server emitter, and bridge-side scaffolding land in [#108](https://github.com/MUDdown/MUDdown/pull/108); the bridge-side publisher itself is a follow-up.

- [x] Spec: `:::system{scope="player"|"world"}` attribute in `packages/spec/SPECIFICATION.md` §3.6, with multi-user-transport rule and `player` fallback (PR #108)
- [x] Shared type: `SystemAttributes` in `@muddown/shared` (PR #108)
- [x] Bridge config knob: `MUDDOWN_DISCORD_FEED_CHANNEL_ID` (snowflake-validated, fails fast on invalid input) (PR #108)
- [x] Bridge scope detector: `isWorldScopeEnvelope()` in `packages/discord-bridge/src/feed.ts` — defense-in-depth filter that rejects everything except `:::system{scope="world"}` envelopes (PR #108)
- [x] Server-side emitter: `buildWorldBroadcastBlock()` helper + `broadcastWorld()` in `packages/server`; first lifecycle event is the `SIGTERM`/`SIGINT` shutdown notice (PR #108)
- [x] Wiki: `MUDdown-Format.md`, `Wire-Protocol.md`, `Discord-Bridge.md` (Public Feed Channel section), `Discord-Setup.md`, `Deployment-Guide.md` updated (PR #108 / wiki `ae654fb`)
- [ ] **Slice 3b — bridge feed publisher** (deferred follow-up PR): unauthenticated read-only `/feed` WebSocket endpoint on the game server + bridge subscriber that posts world-scope envelopes to the configured Discord channel.
  - [x] Server: second WS route at `/feed` keyed by `req.url`; a server-level `feedSubscribers: Set<WebSocket>` tracks all open feed-subscriber connections, kept separate from the gameplay `sessions: Map<WebSocket, PlayerSession>` so feed clients never get a `PlayerSession` or a command handler. Inbound messages on `/feed` are dropped or closed with code 1003 to enforce read-only by construction.
  - [x] Server: refactor `broadcastWorld()` to also iterate `feedSubscribers` so the same payload reaches both gameplay sessions and feed subscribers — the **only** path that writes to feed subscribers is `broadcastWorld()`, which guarantees `scope="player"` traffic can never reach them.
  - [x] Server: per-IP cap (4 concurrent) + global cap (100) to prevent trivial socket-exhaustion DoS, since there's no auth gate. Tunable via `FEED_CAP_PER_IP` / `FEED_CAP_TOTAL`. `FEED_TRUST_PROXY=1` opts into reading the rightmost `X-Forwarded-For` for per-IP accounting when behind a reverse proxy.
  - [x] Server: 30s ping/pong keepalive matching the gameplay socket. Tunable via `FEED_PING_MS`.
  - [x] Bridge: new `feed-subscriber.ts` opens a dedicated WS to `${MUDDOWN_SERVER_URL}` with the path overwritten to `/feed`, exponential-backoff reconnect (1s → 30s with full jitter); only activates when `feedChannelId !== undefined`.
  - [x] Bridge: run incoming envelopes through the existing `isWorldScopeEnvelope()` as defense-in-depth, render via the existing system-block embed renderer with interactive-scheme links stripped (visible text retained, `components` discarded — no per-user session in a public channel), post to `feedChannelId`.
  - [x] Bridge: tests for subscriber lifecycle, reconnect/backoff, `scope="player"` rejection (defense-in-depth even if the server ever ships a bug), and embed shape.
  - [x] Spec: documented the unauthenticated `/feed` endpoint in `packages/spec/SPECIFICATION.md` §6.3 with the read-only contract, close-code, cap, and keepalive guidance.
  - [x] Wiki: remove the "deferred publisher" note from `Discord-Bridge.md`; document `FEED_CAP_PER_IP`, `FEED_CAP_TOTAL`, `FEED_PING_MS`, `FEED_TRUST_PROXY` in `Deployment-Guide.md`; cross-link the new spec §6.3 from `Wire-Protocol.md`.
  - [x] Resolved: same-port path-routed (`/ws` gameplay, `/feed` read-only) sharing the existing nginx TLS termination.

#### 9b. Discord Rich Presence (opt-in, desktop only)

[Discord Rich Presence](https://discord.com/developers/docs/rich-presence/overview) over the local IPC socket from the Tauri desktop app — no SDK, no extra runtime. The Discord client speaks RPC over a Unix domain socket (`$XDG_RUNTIME_DIR/discord-ipc-N`) on Linux/macOS and a named pipe (`\\.\pipe\discord-ipc-N`) on Windows; the desktop app talks to it directly from Rust.

**Hard requirement: defaulted off, opt-in, one-click toggle, fully local.** No data leaves the user's machine via MUDdown's servers; the desktop client speaks directly to the local Discord client. If Discord isn't running, it's a silent no-op.

Surface design (uses every Rich Presence field productively, since they only display when someone clicks into the profile — a low-cost place to be informative):

| RPC field | Value | Visible where |
|---|---|---|
| Activity name | `MUDdown` | Activity header — renders as **"Playing MUDdown"** on the profile and friends list |
| `details` (line 1) | `Exploring <region-name>` (e.g. "Exploring Greenhaven") | Profile expanded view |
| `state` (line 2) | `<room title>` (e.g. "Town Square") | Profile expanded view |
| `start` timestamp | Session start time | Renders as `00:14:32 elapsed` — gives the playing-time field for free |
| `large_image` | MUDdown logo asset (uploaded to the Discord developer portal) | Profile expanded view |
| `large_text` | `MUDdown — open Markdown MUD platform` | Tooltip on logo hover |
| `small_image` | Lighting/region icon (`bright`, `dim`, `dark`, `magical`) keyed off the room's `lighting` frontmatter | Profile expanded view, badge on logo |
| `small_text` | `<region> · <lighting>` (e.g. "Greenhaven · bright") | Tooltip on small icon |
| `buttons` (max 2) | `[Play in browser → muddown.com/play]`, `[Get MUDdown → muddown.com]` | Profile expanded view, click-through |
| `party.size` | `[1, 1]` for solo, `[N, room.capacity]` if/when parties land | Profile expanded view |

Things to **deliberately not** include: character name (privacy — character names can be RP-sensitive and a player may not want their Discord friends to know their alt's name), inventory, combat status, raw coordinates.

Investigation tasks (worth confirming before locking the design):
- [ ] Confirm Discord's current RPC update rate limit (documented as "max 1 update per 15 seconds" historically; verify in 2026 docs and treat as a debounce floor)
- [ ] Confirm `buttons` URLs don't require domain verification in the developer portal (some apps have hit a verification gate)
- [ ] Test behaviour when the user has multiple Discord accounts logged into the desktop client (RPC connects to whichever instance opens its socket first — document the implication)
- [ ] Decide whether `small_image` lighting icons require uploading 4+ assets to the dev portal or whether one neutral asset is sufficient for v1

Implementation tasks:
- [ ] Add `discord_rich_presence` setting to the desktop preferences store, default `false`
- [ ] Settings UI: toggle in the existing preferences pane with copy explaining exactly what is shared (region, room title, session elapsed time, lighting icon) and that it goes only to the local Discord client, never to MUDdown's servers
- [ ] Tauri-side IPC client (Rust crate, e.g. `discord-rich-presence`, or a hand-rolled minimal client — evaluate during scaffolding) gated behind the setting
- [ ] Wire the renderer's "current room" signal to the presence updater; debounce to ≥15 s per Discord's RPC limit
- [ ] Graceful no-op when Discord isn't running locally (don't error, don't retry-spam)
- [ ] Toggle off → immediate `ClearActivity` so nothing lingers on the profile
- [ ] Tests: setting persistence, IPC payload shape, debounce behaviour, no-Discord fallback, clear-on-off
- [ ] Privacy: add a row in the privacy policy listing Rich Presence as off-by-default and listing exactly what it shares when enabled — coordinate with the [`privacy` skill](.github/skills/privacy/SKILL.md)
- [ ] Wiki: extend `Desktop-App.md` with a "Discord Rich Presence" section documenting the opt-in and field map
- [ ] Features page: add an "Optional Discord Rich Presence (opt-in)" entry under the Desktop section
- [ ] Skill: extend `.github/skills/desktop-app/SKILL.md` with the RPC integration pattern (or a new `discord-rich-presence` skill if it grows large enough)

#### 9c. Cross-cutting

- [ ] Update `AGENTS.md` "What NOT to Do" with: "Don't enable Rich Presence by default" and "Don't auto-send Discord messages without explicit user action" (mirrors Discord's policy and ours)
- [ ] Add `Discord-Bridge.md` and the `Desktop-App.md` Rich Presence section to the `wiki-sync` subagent's awareness so future doc-impact mapping covers them
- [ ] Document the dual-activity edge case in `Discord-Bridge.md` and `Desktop-App.md` (cross-reference both pages; mention `discord_rich_presence` and DM-session flow) and keep this guidance in `wiki-sync` subagent awareness
- [ ] World-validator and spec-compliance subagents are unaffected — neither workstream changes the wire protocol or world tree

---

## Agent Development Kit Adoption

The repo already uses two of the five "ADK" layers (CLAUDE.md/AGENTS.md memory, and Skills). This section tracks adoption of the remaining layers to make the agent-driven workflow deterministic rather than discipline-based. See `.github/hooks/` and `.github/agents/` (both canonical, with per-file symlinks under `.claude/hooks/` and `.claude/agents/` for Claude Code) for the implementation.

> Naming note: this repo also has *game-engine hooks* in `packages/server/src/hooks.ts` (NPC/item/room events). The "agent hooks" referenced here are Claude Code tool-use hooks; their canonical home is `.github/hooks/`, with per-file symlinks under `.claude/hooks/` for Claude Code.

### Layer 3 — Agent Hooks (guardrails)

Deterministic enforcement of rules currently stated in [AGENTS.md](AGENTS.md).

- [x] `check-dco.sh` (PreToolUse / Bash) — block `git commit` without `Signed-off-by:` trailer
- [x] `check-dco.sh` — block commits containing forbidden AI-attribution trailers (`Co-Authored-By: Claude|Copilot|ChatGPT`, "Generated with Claude Code", etc.)
- [x] `block-dangerous.sh` (PreToolUse / Bash) — block `git push --force`, `git reset --hard`, `git commit --no-verify`, `git clean -f` (any `-f` bundle), `git restore .` / `git checkout .` / `git checkout -- …`, `git branch -D`, `npm publish`, and unsafe `rm -rf`
- [x] `validate-world.sh` (PostToolUse / Write|Edit) — when a file under `packages/server/world/**` is modified, run the world-integrity vitest suite and surface failures
- [x] All three hooks fail-closed on malformed JSON (jq parse failure → exit 2 / 1 instead of silent pass-through), with `set -uo pipefail` and a non-greedy sed fallback when jq is unavailable
- [ ] *(future)* PostToolUse `tsc --noEmit` on the touched workspace
- [ ] *(future)* Stop hook — remind to update test count on `apps/website/src/pages/features.astro` if vitest counts changed

### Layer 4 — Specialized Subagents (delegation)

Beyond the existing `Explore` agent. Each runs in its own context window so the main thread stays focused.

- [x] `world-validator` — read-only walk of `packages/server/world/`: bidirectional exits, dangling item/npc IDs, frontmatter↔container ID match, recipe references
- [x] `spec-compliance` — given a server change, verify output stays compliant with `packages/spec/SPECIFICATION.md` (envelope shape, container blocks, link schemes, ARIA mapping)
- [x] `wiki-sync` — given a diff, report which pages in `MUDdown.wiki/` need updates per the rules in AGENTS.md "Maintaining the Wiki"

### Layer 5 — Plugin Packaging (distribution)

Lower priority but aligns with the project's positioning as an open MUDdown spec/platform. Plugins live under [`.github/plugins/`](.github/plugins/) and follow the [Claude Code plugin spec](https://code.claude.com/docs/en/plugins-reference#plugin-directory-structure) (`.claude-plugin/plugin.json` + `skills/<name>/` → directory symlinks into `.github/skills/<name>/`); this keeps the canonical skill files as the single source of truth.

- [x] Bundle `room-creation` + `item-creation` + `npc-creation` + `muddown-format` skills as a **"MUDdown Content Authoring"** plugin so third-party MUDdown servers can install the authoring workflow without forking
- [x] Bundle `osc8-bridge` + `oauth-provider` skills as a **"MUDdown Operator"** plugin for ops-focused contributors

### Layer 1 — Memory split (tidy-up)

- [x] Universal preferences (DCO sign-off, no AI co-author trailers, "don't add docstrings to code you didn't change", squash-merge / fork-only push hygiene) live in `~/.claude/CLAUDE.md` so every project session inherits them. The project [CLAUDE.md](CLAUDE.md) keeps its own copy of the DCO and AI-attribution rules — those are project policy and must apply to any contributor regardless of their personal user-global memory — but is otherwise free to focus on MUDdown-specific guidance.

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
