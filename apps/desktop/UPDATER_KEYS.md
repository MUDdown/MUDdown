# Updater Key Management

The MUDdown desktop app uses Tauri's built-in [auto-updater](https://v2.tauri.app/plugin/updater/) with **Ed25519 signature verification** to ensure update integrity. See the [Tauri signing docs](https://v2.tauri.app/plugin/updater/#signing-updates) for background on key generation and the update flow.

## Key Pair

| File | Purpose | Location |
|------|---------|----------|
| Public key | Embedded in `tauri.conf.json` → `plugins.updater.pubkey` | **Not yet configured** — set when keys are generated |
| Private key | Used by CI to sign release artifacts | GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` |

## Generating a New Key Pair

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/muddown.key
```

This produces:
- `~/.tauri/muddown.key` — the private key (keep secret!)
- The public key is printed to stdout

## Rotating Keys

1. Generate a new key pair (see above).
2. Update `tauri.conf.json` → `plugins.updater.pubkey` with the new public key.
3. Update the `TAURI_SIGNING_PRIVATE_KEY` secret in GitHub Actions.
4. Update the `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret if a password was set.
5. Create a new signed release. Previous releases signed with the old key will no longer be accepted by clients running the new version.

## CI Secrets Required

| Secret | Description |
|--------|-------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Ed25519 private key for signing updates |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Optional — only required if the private key is password-protected |

## Verification

The [updater plugin](https://v2.tauri.app/plugin/updater/) validates every downloaded update against the public key before applying it. If the signature does not match — whether due to tampering, a forged release, or a key mismatch — the update is **rejected** and the app remains on its current version.

## Testing

> **Status:** The integration test described below is planned but not yet implemented. See the Phase 5 roadmap in `PROJECT_PLAN.md` for tracking.

The CI workflow (`.github/workflows/desktop-build.yml`) will include an integration test that:
1. Builds a properly signed release artifact.
2. Verifies the updater accepts the valid signature.
3. Tampers with the artifact and verifies the updater **rejects** the invalid signature.
