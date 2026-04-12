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
