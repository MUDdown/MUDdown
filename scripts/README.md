# scripts/

Operational helpers for the MUDdown maintainers. Most contributors will never
need to run anything here.

## Code-signing setup (Microsoft Artifact Signing)

Two scripts that provision Azure resources for signing the Windows desktop
builds. They are committed for reproducibility/audit, **not** for general use.

| Script | Purpose | When |
|--------|---------|------|
| `setup-signing.sh` | Provisions Azure resources and initiates Identity Validation | Once, before submitting the Identity Validation |
| `setup-signing-post-iv.sh` | Creates cert profile, scoped Signer role, and triggers first signed build | Once, after Identity Validation reaches *Completed* |

`setup-signing.sh` performs, in order:

- Adds the `artifact-signing` Azure CLI extension
- Registers the `Microsoft.CodeSigning` resource provider on the subscription
- Creates the resource group (`$RG`)
- Creates the Artifact Signing account (`$ACCOUNT`, Basic SKU)
- Grants the maintainer the `Artifact Signing Identity Verifier` role
- Creates the Microsoft Entra app (`$GH_APP_NAME`) and a service principal
- Adds a GitHub OIDC federated credential for `refs/heads/$GH_BRANCH`
- Sets six non-secret GitHub Actions variables on `$GH_REPO`
- Opens the Azure portal at the Identity Validation page for the manual KYC step

`setup-signing-post-iv.sh` reads `.signing-state.env`, prompts for the
completed validation's GUID, creates the certificate profile, grants the
Entra service principal the `Artifact Signing Certificate Profile Signer`
role scoped to that profile, sets the `WINDOWS_SIGNING_ENABLED=true`
GitHub Actions variable, and triggers a `Desktop Build` workflow run on
`$GH_BRANCH` — that run will produce a signed MSI.

### Prerequisites

- Azure CLI (`az`) installed, with `az login` completed
- GitHub CLI (`gh`) installed, with `gh auth login` completed
- `jq` installed (used by the Entra federated-credential helper)
- Write access to the target GitHub repository (`$GH_REPO`)
- An Azure subscription you can create resource groups in
- A Microsoft Partner Center account linked to the same Entra tenant
  (required by Microsoft for Public Trust Identity Validation)

### What they create

- An Azure Resource Group + Artifact Signing account (Basic SKU, **$9.99/mo**)
- An Entra app registration with a GitHub OIDC federated credential for
  `refs/heads/$GH_BRANCH` (defaults to `main`; additional credentials can
  be added later for tag triggers — see comments in `setup-signing.sh`)
- Six non-secret GitHub Actions Variables on the target repo
- A local `.signing-state.env` (gitignored) bridging the two scripts

### Safety guarantees

- **Refuse to run without explicit consent.** Both scripts require
  `MUDDOWN_SIGNING_CONSENT=yes` in the environment.
- **No hardcoded credentials, IDs, or secrets.** Subscription/tenant/app IDs
  are read at runtime from `az`. Federated credentials (OIDC) replace the
  long-lived secrets that older guides used.
- **Fork-aware.** The script verifies you have write access to `$GH_REPO`
  before pushing variables. Override `GH_REPO` and other names via env if
  forking; defaults assume the upstream `MUDdown/MUDdown` repository.
- **Idempotent.** Re-running the script after a partial failure is safe; each
  resource is created only if it doesn't already exist.

### If you forked MUDdown and want your own signing pipeline

```bash
MUDDOWN_SIGNING_CONSENT=yes \
  GH_REPO=your-org/your-fork \
  RG=rg-signing-fork \
  ACCOUNT=your-fork-signing \
  PROFILE=your-fork-public-trust \
  GH_APP_NAME=github-your-fork-signing \
  bash scripts/setup-signing.sh
```

You'll need a separate Azure subscription, your own Identity Validation
(Microsoft documents 1–20 business days), and your own GitHub repo.

### What's *not* in this directory

- No private keys (Artifact Signing keeps them in Azure HSMs, never exported)
- No Azure secrets (federated OIDC, no client secrets to leak)
- No customer/contributor data

## Code-signing setup (Apple Developer ID — macOS notarization)

`setup-apple-signing.sh` provisions a Developer ID Application certificate
for signing and notarizing the macOS desktop builds.

| Script | Purpose | When |
|--------|---------|------|
| `setup-apple-signing.sh` | Generates a Developer ID Application key + CSR, requests a cert from App Store Connect, bundles it into a `.p12`, and pushes the six `APPLE_*` secrets to GitHub | Once, after Apple Developer Program enrollment is complete |

What it automates:

- Generates a fresh 2048-bit RSA private key locally (in `$WORK_DIR`,
  default `~/.muddown-apple-signing`, mode 700)
- Builds a CSR with CN = your organisation's legal name
- Signs an ES256 JWT (≤20-min expiry) for the App Store Connect API using
  your downloaded `.p8` key
- POSTs the CSR to `https://api.appstoreconnect.apple.com/v1/certificates`
  with `certificateType=DEVELOPER_ID_APPLICATION`
- Bundles the issued certificate + private key into a password-protected
  `.p12` (using `openssl pkcs12 -legacy` for Sequoia/Sonoma compatibility)
- After confirmation, pushes six secrets to `$GH_REPO` via `gh secret set`:
  `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, `APPLE_ID`, `APPLE_PASSWORD`

What still requires the Apple portals (one-time human steps):

1. **App Store Connect API key** — App Store Connect → Users and Access →
   Integrations → App Store Connect API → Generate API Key with the
   **Admin** role. Apple shows the `.p8` exactly once for download.
   (The Developer role *cannot* issue Developer ID certificates.)
2. **App-specific password** — `https://account.apple.com` → Sign-In and
   Security → App-Specific Passwords → generate one for "MUDdown
   notarization". Cannot be retrieved later.
3. **Team ID** — Apple Developer membership page (10-character string).

### Prerequisites

- macOS (the script uses `openssl pkcs12 -legacy` and Xcode CLI tooling)
- `openssl`, `curl`, `jq`, `python3`, `gh` on `$PATH`
- The Python `cryptography` package (`python3 -m pip install --user
  cryptography`) — required for ES256 signing
- An Apple Developer Program membership (Organization, with D-U-N-S)
- Write access to `$GH_REPO`

### Safety guarantees

- **Refuse to run without explicit consent.** Requires
  `MUDDOWN_APPLE_SIGNING_CONSENT=yes` in the environment.
- **No silent re-issuance.** Apple caps Developer ID Application
  certificates at 5 active per team. The script reuses a still-valid cert
  on disk; pass `FORCE_NEW_CERT=yes` to override.
- **Idempotent.** Re-running after a partial failure is safe: the key,
  CSR, and `.p12` export password are reused from `$WORK_DIR`.
- **Local-only private key.** The Developer ID private key is generated
  on this machine and never leaves it; only the `.p12` (encrypted) is
  uploaded to GitHub Actions.
- **Fork-aware.** Override `GH_REPO` to target your own fork.

### What's *not* in this directory

- No private keys (Developer ID key lives in `$WORK_DIR` only, gitignored)
- No `.p8` API keys (you supply the path at runtime)
- No app-specific passwords (read from a hidden prompt, never stored)
- No customer/contributor data
