# Updater Key Management

The MUDdown desktop app uses Tauri's built-in [auto-updater](https://v2.tauri.app/plugin/updater/) with **Ed25519 signature verification** to ensure update integrity. See the [Tauri signing docs](https://v2.tauri.app/plugin/updater/#signing-updates) for background on key generation and the update flow.

## Key Pair

| File | Purpose | Location |
|------|---------|----------|
| Public key | Embedded in `tauri.conf.json` → `plugins.updater.pubkey` | Committed in repo |
| Private key | Used by CI to sign release artifacts | GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` |

## Generating a New Key Pair

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/muddown.key
```

This produces:
- `~/.tauri/muddown.key` — the private key (keep secret!)
- `~/.tauri/muddown.key.pub` — the public key

## Rotating Keys

1. Generate a new key pair (see above).
2. Update `tauri.conf.json` → `plugins.updater.pubkey` with the new public key.
3. Update the `TAURI_SIGNING_PRIVATE_KEY` secret in GitHub Actions with the contents of `~/.tauri/muddown.key`.
4. Update the `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret if a password was set.
5. Create a new signed release. Previous releases signed with the old key will no longer be accepted by clients running the new version.

> **Note:** The CI signature verification step reads the public key dynamically from `tauri.conf.json`, so no workflow file update is needed during rotation.

## CI Secrets Required

| Secret | Description |
|--------|-------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Ed25519 private key for signing updates |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the private key (required if password-protected) |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` Developer ID certificate (macOS notarization) |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` certificate |
| `APPLE_SIGNING_IDENTITY` | Signing identity, e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID email used for notarization submission |
| `APPLE_PASSWORD` | App-specific password for notarization (not your Apple ID password) |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |

## Setting Up the CI Secrets

1. Copy the contents of `~/.tauri/muddown.key`:
   ```bash
   cat ~/.tauri/muddown.key
   ```
2. Go to **Settings → Secrets and variables → Actions** in the GitHub repo.
3. Add `TAURI_SIGNING_PRIVATE_KEY` with the full contents of the key file.
4. Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with the password you used during key generation. Skip this step if you did not set a password when running `signer generate`.

> **Security Note:** The private key is sensitive material. Copy it only in secure environments and never paste it into insecure channels, chat apps, or issue trackers.

## Verification

The [updater plugin](https://v2.tauri.app/plugin/updater/) validates every downloaded update against the public key before applying it. If the signature does not match — whether due to tampering, a forged release, or a key mismatch — the update is **rejected** and the app remains on its current version.

## Testing

The CI workflow (`.github/workflows/desktop-build.yml`) includes a signature verification test (`apps/desktop/tests/verify-signature.sh`) that:
1. Locates all `.sig` files produced by `tauri build`.
2. Verifies each signature against the project's public key using `minisign`.
3. Tampers with each artifact (appends a byte) and verifies the updater **rejects** the invalid signature.

The test runs on macOS and Linux CI targets after the Tauri build step. It is skipped when `TAURI_SIGNING_PRIVATE_KEY` is not configured (e.g., on forks without the secret).

---

## Apple Notarization (macOS)

Apple notarization is required for distributing macOS apps outside the App Store. Without it, Gatekeeper blocks the app with "cannot be opened because the developer cannot be verified."

### Prerequisites

1. **Apple Developer Program** membership ($99/yr) — [developer.apple.com/programs](https://developer.apple.com/programs/)
2. A **Developer ID Application** certificate (not an App Store distribution certificate)
3. An **app-specific password** for the Apple ID used for notarization

### Generating the Certificate

1. Open **Xcode → Settings → Accounts** → select your team → **Manage Certificates**.
2. Click **+** → **Developer ID Application**.
3. Export the certificate as a `.p12` file from **Keychain Access** (search for "Developer ID Application", right-click → Export). Name it something like `MUDdown.p12`.
4. Base64-encode it for the GitHub Actions secret (replace the filename with your actual export path):
   ```bash
   base64 MUDdown.p12 | pbcopy
   ```
5. Paste into the `APPLE_CERTIFICATE` secret.

### Creating an App-Specific Password

1. Go to [appleid.apple.com](https://appleid.apple.com/) → **Sign-In and Security** → **App-Specific Passwords**.
2. Generate a password and store it as the `APPLE_PASSWORD` secret.

> **Important:** This is an app-specific password, not your Apple ID password. Never use your real password in CI secrets.

### Finding Your Team ID and Signing Identity

```bash
# List available signing identities
security find-identity -v -p codesigning

# The output includes the identity string, e.g.:
#   "Developer ID Application: Your Name (ABC123DEF4)"
# The 10-character code in parentheses is your Team ID.
```

Set `APPLE_SIGNING_IDENTITY` to the full identity string (including "Developer ID Application:") and `APPLE_TEAM_ID` to the 10-character code.

### How It Works

When the macOS CI secrets are configured, `tauri-apps/tauri-action@v0` automatically:

1. Imports `APPLE_CERTIFICATE` into a temporary keychain
2. Code-signs the `.app` bundle with `APPLE_SIGNING_IDENTITY`, hardened runtime enabled, and the entitlements from `src-tauri/Entitlements.plist`
3. Submits the signed app to Apple's notarization service via `notarytool`
4. Waits for approval (typically 1–5 minutes)
5. Staples the notarization ticket to the `.dmg`

The entitlements in `src-tauri/Entitlements.plist` grant the permissions required by the WebView:
- `com.apple.security.cs.allow-jit` — WebKit JIT compilation
- `com.apple.security.cs.allow-unsigned-executable-memory` — JavaScriptCore executable memory allocation (required alongside allow-jit under the hardened runtime)
- `com.apple.security.network.client` — Outbound network (WebSocket, OAuth)

### Verifying Notarization Locally

After downloading a built `.dmg`:
```bash
# Check code signature
codesign -dv --verbose=4 /path/to/MUDdown.app

# Verify notarization staple
xcrun stapler validate /path/to/MUDdown.dmg

# Check Gatekeeper assessment
spctl --assess --verbose=4 --type execute /path/to/MUDdown.app
```
