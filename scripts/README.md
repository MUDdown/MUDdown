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
role scoped to that profile, and triggers a `Desktop Build` workflow run
on `$GH_BRANCH`.

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
  `refs/heads/main` (additional credentials can be added later for tag
  triggers — see comments in `setup-signing.sh`)
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
