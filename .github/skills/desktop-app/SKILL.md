---
name: desktop-app
description: Build and maintain the Tauri v2 desktop app. Covers scaffolding, Turborepo wiring, CI build matrix, auto-updater with Ed25519 signature verification, and native OS integrations (menu, tray, notifications, window-state).
---

# Desktop App Skill

You are working on the MUDdown Tauri v2 desktop app (`apps/desktop`). This skill covers the scaffolding layout, workspace wiring, CI/CD build matrix, auto-updater signature verification, and native OS integrations.

## Scaffold Layout

```
apps/desktop/
├── src/
│   ├── main.ts              # Game client (auth, characters, WebSocket, rendering)
│   ├── index.html           # Single-page app shell
│   └── styles.css           # Dark terminal theme (CSS custom properties)
├── src-tauri/
│   ├── src/lib.rs           # Rust backend (menu, tray, Tauri commands)
│   ├── Cargo.toml           # Rust dependencies
│   ├── tauri.conf.json      # App config, CSP, updater settings
│   ├── build.rs             # Tauri build script
│   └── icons/               # App icons (PNG, ICO, ICNS for each platform)
├── vite.config.ts           # Vite bundler (port 1420, strictPort)
├── package.json             # @muddown/desktop
├── tsconfig.json            # TypeScript (noEmit: true)
└── UPDATER_KEYS.md          # Ed25519 key rotation procedure
```

## Turborepo Wiring

The desktop app is a workspace package at `apps/desktop`. Add it to the root `package.json` workspaces array if not present.

### Workspace Dependencies

In `apps/desktop/package.json`:
```json
{
  "dependencies": {
    "@muddown/client": "*",
    "@muddown/shared": "*",
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-dialog": "^2.0.0",
    "@tauri-apps/plugin-notification": "^2.0.0",
    "@tauri-apps/plugin-store": "^2.0.0",
    "@tauri-apps/plugin-updater": "^2.0.0"
  }
}
```

### Vite Aliases

In `vite.config.ts`, resolve workspace packages to their source directories:
```ts
resolve: {
  alias: {
    "@muddown/client": path.resolve(__dirname, "../../packages/client/src"),
    "@muddown/shared": path.resolve(__dirname, "../../packages/shared/src"),
  },
}
```

### Build Order

Build workspace deps before the Tauri app:
```bash
npx turbo run build --filter=@muddown/client... --filter=@muddown/shared...
```

## Rust Backend (`src-tauri/src/lib.rs`)

### Tauri Commands

Expose custom commands to the JS frontend with `#[tauri::command]`:

| Command | Purpose | Error handling |
|---------|---------|----------------|
| `set_window_title` | Update native title bar | `if let Err(e)` → `eprintln!` |
| `send_notification` | Send OS notification | Best-effort `let _` (permission denial expected) |

Register commands in the builder:
```rust
.invoke_handler(tauri::generate_handler![set_window_title, send_notification])
```

### Tauri Plugins

Register plugins in `tauri::Builder::default()`:
```rust
.plugin(tauri_plugin_dialog::init())
.plugin(tauri_plugin_notification::init())
.plugin(tauri_plugin_window_state::Builder::default().build())
.plugin(tauri_plugin_store::Builder::default().build())
.plugin(tauri_plugin_updater::Builder::default().build())
```

### Cargo Dependencies

In `apps/desktop/src-tauri/Cargo.toml`:
```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "image-png"] }
tauri-plugin-dialog = "2"
tauri-plugin-notification = "2"
tauri-plugin-window-state = "2"
tauri-plugin-updater = "2"
tauri-plugin-store = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### Error Handling Conventions

- Tauri commands: use `if let Err(e) = ... { eprintln!("[context] message: {e}"); }` for recoverable errors.
- Menu event emitting: check `Err` and log with `eprintln!`.
- Tray show/focus: check `Err` on `w.show()` and `w.set_focus()` and log.
- Notifications: `let _` is acceptable (permission denial is expected, not an error).
- App startup: use `.unwrap_or_else(|e| panic!("...: {}", e))` on `.run()` to preserve the error message.

## Native OS Integrations

### Menu Bar

Build menus in the `.setup()` closure using `SubmenuBuilder` and `MenuItemBuilder`:
- **File**: Connect, Disconnect, Quit
- **View**: Clear Output (Cmd/Ctrl+L), Focus Input (Cmd/Ctrl+K), Toggle Inventory, Toggle Hints
- **Help**: Game Commands, About MUDdown

Forward menu actions to JS via `handle.emit("menu-action", id)`. In JS, listen with `listen("menu-action", ...)`.

### System Tray

Use `TrayIconBuilder` with a PNG icon and a context menu:
- **Show MUDdown** — `w.show()` + `w.set_focus()`
- **Quit** — `handle.exit(0)`

Update the tray tooltip from JS to reflect connection status (e.g., "MUDdown — Connected" / "MUDdown — Disconnected").

### Notifications

Use `tauri-plugin-notification` via the Rust `NotificationExt` trait or the JS `@tauri-apps/plugin-notification` API. Trigger notifications for:
- Player mentions (another player mentions you in chat)
- Combat events (damage, defeats)
- NPC contact (lifecycle `onContact` triggers)

### Window State

The `tauri-plugin-window-state` plugin automatically persists and restores window size/position. No custom code needed — just register the plugin.

### Keyboard Shortcuts

Define accelerators on menu items:
- `CmdOrCtrl+L` → Clear Output
- `CmdOrCtrl+K` → Focus Input

Handle via the menu-action event flow (Rust emits → JS listens).

## ARIA Accessibility

Apply ARIA roles per the MUDdown spec (§8) when rendering messages:

| Block type | ARIA attributes |
|------------|-----------------|
| `room` | `role="main"` |
| `system` | `role="alert"` |
| `combat` | `role="log"` `aria-live="polite"` |
| `dialogue` | `role="group"` `aria-label="NPC dialogue"` |

## CSP Configuration

In `tauri.conf.json` → `app.security.csp`:
- `connect-src`: Allow WebSocket to game server (`ws://localhost:3300`, `wss://muddown.com`) and HTTPS for OAuth
- `style-src`: `'self' 'unsafe-inline'` + Google Fonts
- `font-src`: Google Fonts CDN
- `img-src`: `'self' data:`

The `unsafe-inline` for styles is required by the Tauri webview. This is a desktop app, not a web page, so the risk profile is different from a public website.

## CI Build Matrix

The GitHub Actions workflow lives at `.github/workflows/desktop-build.yml`.

### Triggers

- Push to `main` touching `apps/desktop/**`, `packages/client/**`, `packages/shared/**`, or the workflow file
- PRs to `main` with the same path filters
- Manual dispatch (`workflow_dispatch`)

### Build Matrix

| Platform | Target | Artifact |
|----------|--------|----------|
| `macos-latest` | `aarch64-apple-darwin` | `.dmg` |
| `macos-latest` | `x86_64-apple-darwin` | `.dmg` |
| `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | `.AppImage`, `.deb` |
| `windows-latest` | `x86_64-pc-windows-msvc` | `.msi` |

### Key Steps

1. Checkout, setup Node 22, install Rust stable with target
2. Cache Rust deps with `Swatinem/rust-cache@v2` (key by target, workspaces: `apps/desktop/src-tauri`)
3. Install Linux system deps (webkit2gtk, appindicator, rsvg, patchelf) — Ubuntu only
4. `npm ci` → `npx turbo run build --filter=@muddown/client... --filter=@muddown/shared...`
5. `tauri-apps/tauri-action@v0` with signing secrets and Apple notarization secrets
6. Upload artifacts via `actions/upload-artifact@v4`

### Code Signing Secrets

| Secret | Platform | Purpose |
|--------|----------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | All | Ed25519 key for update signing |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | All | Optional password for the signing key |
| `APPLE_CERTIFICATE` | macOS | Apple Developer certificate (base64) |
| `APPLE_CERTIFICATE_PASSWORD` | macOS | Certificate password |
| `APPLE_SIGNING_IDENTITY` | macOS | Signing identity string |
| `APPLE_ID` | macOS | Apple ID email |
| `APPLE_PASSWORD` | macOS | App-specific password |
| `APPLE_TEAM_ID` | macOS | Apple team identifier |

## Auto-Updater & Signature Verification

### Configuration (`tauri.conf.json`)

```json
{
  "plugins": {
    "updater": {
      "active": true,
      "pubkey": "<Ed25519 public key>",
      "endpoints": [
        "https://github.com/MUDdown/MUDdown/releases/latest/download/latest.json"
      ]
    }
  }
}
```

- The endpoint points to the `latest.json` manifest published with each GitHub Release.

### Runtime Validation Points

1. **Rust layer** (`tauri-plugin-updater`): Automatically validates every downloaded artifact against `pubkey` before applying. Built into the plugin — no custom Rust code needed.
2. **JS layer** (`@tauri-apps/plugin-updater`): The `check()` and `downloadAndInstall()` APIs surface the plugin's result. Use them to show update prompts and handle validation failures.

If a signature does not match (tampering, forged release, key mismatch), the update is **rejected** and the app stays on its current version.

### Key Generation

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/muddown.key
```

Produces:
- `~/.tauri/muddown.key` — private key (store as `TAURI_SIGNING_PRIVATE_KEY` secret)
- `~/.tauri/muddown.key.pub` — public key (put in `tauri.conf.json` → `plugins.updater.pubkey`)

### Key Rotation Procedure

Full procedure in `apps/desktop/UPDATER_KEYS.md`:

1. Generate a new Ed25519 key pair.
2. Update `tauri.conf.json` → `plugins.updater.pubkey`.
3. Update `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret.
4. Update `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if password-protected.
5. Create a new signed release. Clients running the new version will reject old-key artifacts.

> **Note:** The CI signature verification step reads the public key dynamically from `tauri.conf.json`, so no workflow file update is needed during rotation.

### Integration Test Plan

The CI workflow includes a signature verification test (`apps/desktop/tests/verify-signature.sh`) that:
1. Locates all `.sig` files produced by `tauri build`.
2. Verifies each signature against the project's public key using `minisign`.
3. Tampers with each artifact and verifies the updater **rejects** the invalid signature.

The test runs on macOS and Linux CI targets after the build step. It is skipped when `TAURI_SIGNING_PRIVATE_KEY` is not configured (e.g., on forks).

## Icons

- Must be **8-bit/channel RGBA** PNG (Tauri crashes on 16-bit/channel).
- Convert with ImageMagick if needed: `magick icon.png -depth 8 icon.png`
- Required formats: `icon.png` (512×512), `icon.ico` (Windows), `icon.icns` (macOS)
- Store in `apps/desktop/src-tauri/icons/`

## Acceptance Criteria

Before considering desktop app work complete:

- [ ] `npm run dev` in `apps/desktop` launches the Tauri dev window
- [ ] `npm run tauri build` produces platform-appropriate artifacts
- [ ] TypeScript compiles clean: `cd apps/desktop && npx tsc --noEmit`
- [ ] All workspace tests pass: `npx turbo run test`
- [ ] ARIA roles match the spec (room=main, system=alert, combat=log, dialogue=group)
- [ ] Menu bar actions work (File, View, Help submenus)
- [ ] System tray shows/hides the window
- [ ] Keyboard shortcuts (Cmd/Ctrl+L, Cmd/Ctrl+K) work
- [ ] Window position persists across restarts
- [ ] Notifications fire for mentions, combat, NPC contact
- [ ] CSP allows WebSocket to game server and OAuth endpoints
- [ ] CI workflow builds all 4 targets without errors
- [ ] `tauri.conf.json` updater has `pubkey` populated (when active)
- [ ] CI signature verification test passes (valid accepted, tampered rejected)
- [ ] `UPDATER_KEYS.md` documents key rotation

## Traceability

This skill covers the Phase 5 Tauri desktop app checklist in `PROJECT_PLAN.md` (lines ~225–243). See that document for the full roadmap context and remaining items.
