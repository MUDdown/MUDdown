#!/usr/bin/env bash
# Pre-Identity-Validation provisioning for Microsoft Artifact Signing.
# Idempotent: safe to re-run if any step fails partway.
#
# Sections roughly map to PROJECT_PLAN.md stages 3, 4, 5, 8, 9, then 6.
# Stage 6 (Identity Validation) is intentionally last — it is a portal-only
# step that must be performed by a human after the Entra app exists. Stages
# 2 (Azure account) and 7 (Microsoft Partner Center) are out-of-band manual
# prerequisites and are not automated here.
#
# After this completes, do the portal-only Identity Validation, then run
# scripts/setup-signing-post-iv.sh.
#
# ⚠️  THIS SCRIPT PROVISIONS BILLED AZURE RESOURCES
# ⚠️  ($9.99/mo Artifact Signing Basic SKU)
# ⚠️  AND CONFIGURES GITHUB ACTIONS VARIABLES.
#
# Safe-by-default behaviour:
#  - Refuses to run unless MUDDOWN_SIGNING_CONSENT=yes
#  - Verifies you're the upstream maintainer (or override with GH_REPO)
#  - All resource names are env-overridable (no hardcoded assumptions)
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
# Config (override any of these via environment if forking)
# ──────────────────────────────────────────────────────────────────────
RG="${RG:-rg-signing}"
LOCATION="${LOCATION:-eastus}"
ACCOUNT="${ACCOUNT:-muddown-signing}"
PROFILE="${PROFILE:-muddown-public-trust}"
GH_APP_NAME="${GH_APP_NAME:-github-muddown-signing}"
GH_REPO="${GH_REPO:-MUDdown/MUDdown}"
# Branch the post-IV script triggers the first signed build on. Override
# during pre-merge verification; defaults to the upstream default branch.
GH_BRANCH="${GH_BRANCH:-main}"
ENDPOINT="${ENDPOINT:-https://eus.codesigning.azure.net}"

# ──────────────────────────────────────────────────────────────────────
# Consent gate — prevents accidental execution by anyone who clones the repo
# ──────────────────────────────────────────────────────────────────────
if [ "${MUDDOWN_SIGNING_CONSENT:-no}" != "yes" ]; then
  cat <<'EOF' >&2
This script will create paid Azure resources and configure GitHub Actions
variables on the target repository. Re-run with explicit consent:

  MUDDOWN_SIGNING_CONSENT=yes bash scripts/setup-signing.sh

For forks, also set GH_REPO=<your-org>/<your-repo> and any other overrides
you need (RG, ACCOUNT, PROFILE, GH_APP_NAME).
EOF
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Preflight
# ──────────────────────────────────────────────────────────────────────
for cmd in az gh jq; do
  command -v "$cmd" >/dev/null || { echo "Missing required tool: $cmd" >&2; exit 1; }
done

az account show >/dev/null 2>&1 || { echo "Run 'az login' first." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }

# Verify the target GitHub repo exists and is writable by current user
if ! gh repo view "$GH_REPO" --json viewerPermission --jq '.viewerPermission' 2>/dev/null \
     | grep -qE 'ADMIN|MAINTAIN|WRITE'; then
  echo "You don't have write access to $GH_REPO (or it doesn't exist)." >&2
  echo "Set GH_REPO=<your-org>/<your-repo> when forking." >&2
  exit 1
fi

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
echo "Target repo  : $GH_REPO"
echo "Subscription : $SUBSCRIPTION_ID"
echo "Tenant       : $TENANT_ID"
echo "Resource grp : $RG ($LOCATION)"
echo "Signing acct : $ACCOUNT"
echo
read -rp "Proceed? [y/N] " CONFIRM
[ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ] || { echo "Aborted."; exit 1; }

# ──────────────────────────────────────────────────────────────────────
# Stage 3 — Extension + resource provider
# ──────────────────────────────────────────────────────────────────────
az extension show --name artifact-signing >/dev/null 2>&1 \
  || az extension add --name artifact-signing

if [ "$(az provider show --namespace Microsoft.CodeSigning --query registrationState -o tsv 2>/dev/null)" != "Registered" ]; then
  az provider register --namespace Microsoft.CodeSigning
  # Bound the wait so a stuck registration doesn't hang CI/local runs forever.
  # Microsoft.CodeSigning typically registers in well under a minute; 10 minutes
  # is generous. Override with PROVIDER_REGISTER_TIMEOUT if needed.
  REGISTER_TIMEOUT="${PROVIDER_REGISTER_TIMEOUT:-600}"
  REGISTER_INTERVAL=5
  ELAPSED=0
  until [ "$(az provider show --namespace Microsoft.CodeSigning --query registrationState -o tsv)" = "Registered" ]; do
    if [ "$ELAPSED" -ge "$REGISTER_TIMEOUT" ]; then
      STATE=$(az provider show --namespace Microsoft.CodeSigning --query registrationState -o tsv 2>/dev/null || echo Unknown)
      echo "ERROR: Microsoft.CodeSigning did not reach 'Registered' after ${REGISTER_TIMEOUT}s (state: $STATE)" >&2
      exit 1
    fi
    echo "  waiting for resource provider… (${ELAPSED}s / ${REGISTER_TIMEOUT}s)"
    sleep "$REGISTER_INTERVAL"
    ELAPSED=$((ELAPSED + REGISTER_INTERVAL))
  done
fi
echo "✓ Microsoft.CodeSigning registered"

# ──────────────────────────────────────────────────────────────────────
# Stage 4 — Resource group + Artifact Signing account
# ──────────────────────────────────────────────────────────────────────
az group show -n "$RG" >/dev/null 2>&1 \
  || az group create -n "$RG" -l "$LOCATION" >/dev/null
echo "✓ Resource group: $RG"

if ! az artifact-signing show -n "$ACCOUNT" -g "$RG" >/dev/null 2>&1; then
  AVAIL=$(az artifact-signing check-name-availability \
    --type Microsoft.CodeSigning/codeSigningAccounts \
    --name "$ACCOUNT" --query nameAvailable -o tsv)
  [ "$AVAIL" = "true" ] || { echo "Account name '$ACCOUNT' is taken — pick another"; exit 1; }
  az artifact-signing create -n "$ACCOUNT" -g "$RG" -l "$LOCATION" --sku Basic >/dev/null
fi
ACCOUNT_ID=$(az artifact-signing show -n "$ACCOUNT" -g "$RG" --query id -o tsv)
echo "✓ Artifact Signing account: $ACCOUNT"

# ──────────────────────────────────────────────────────────────────────
# Stage 5 — Identity Verifier role for you
# ──────────────────────────────────────────────────────────────────────
MY_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)
# `--query "length(@)"` returns a numeric count we can compare exactly;
# this avoids matching stray Azure CLI error text that some versions print
# to stdout under `-o tsv`.
ROLE_COUNT=$(az role assignment list \
  --assignee "$MY_OBJECT_ID" --scope "$ACCOUNT_ID" \
  --role "Artifact Signing Identity Verifier" \
  --query "length(@)" -o tsv 2>/dev/null || echo 0)
if [ "${ROLE_COUNT:-0}" = "0" ]; then
  az role assignment create \
    --assignee-object-id "$MY_OBJECT_ID" \
    --assignee-principal-type User \
    --role "Artifact Signing Identity Verifier" \
    --scope "$ACCOUNT_ID" >/dev/null
fi
echo "✓ Identity Verifier role granted to you"

# ──────────────────────────────────────────────────────────────────────
# Stage 8 — Entra app + GitHub federated credentials
# ──────────────────────────────────────────────────────────────────────
# Use an OData $filter for exact displayName match — `--display-name` is
# a prefix/substring match in some `az` versions and could pick a similarly
# named app from another project in the same tenant.
APP_ID=$(az ad app list --filter "displayName eq '$GH_APP_NAME'" --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  APP_ID=$(az ad app create --display-name "$GH_APP_NAME" --query appId -o tsv)
fi
APP_OBJ_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)

az ad sp show --id "$APP_ID" >/dev/null 2>&1 \
  || az ad sp create --id "$APP_ID" >/dev/null
SP_OBJ_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)
echo "✓ Service principal: $GH_APP_NAME ($APP_ID)"

# create_fic <name> <subject>
#   Creates (idempotently) a GitHub Actions OIDC federated credential on the
#   Entra app. Depends on outer-scope $APP_OBJ_ID. The <subject> argument
#   must be an exact-match GitHub Actions subject claim (e.g.
#   "repo:OWNER/REPO:ref:refs/heads/main") — Azure AD federated credentials
#   do NOT support wildcards in `subject`; wildcard matching requires the
#   separate `claimsMatchingExpression` API shape.
create_fic() {
  local name="$1" subject="$2"
  local count
  count=$(az ad app federated-credential list --id "$APP_OBJ_ID" \
    --query "length([?name=='$name'])" -o tsv 2>/dev/null || echo 0)
  if [ "${count:-0}" = "0" ]; then
    az ad app federated-credential create --id "$APP_OBJ_ID" --parameters "$(jq -n \
      --arg n "$name" --arg s "$subject" \
      '{name:$n, issuer:"https://token.actions.githubusercontent.com",
        subject:$s, audiences:["api://AzureADTokenExchange"]}')" >/dev/null
  fi
}
create_fic "github-main-branch" "repo:${GH_REPO}:ref:refs/heads/main"
# NOTE: Tag-triggered releases are not yet wired up. When they are, add an
# additional FIC here using an exact subject (e.g.
# "repo:${GH_REPO}:ref:refs/tags/desktop-v1.2.3" per release) or migrate to
# the claimsMatchingExpression API for prefix matching. A `refs/tags/*` glob
# in `subject` would NOT match — Azure treats `*` as a literal character.
echo "✓ Federated credentials configured"

# ──────────────────────────────────────────────────────────────────────
# Stage 9 — GitHub Actions variables
# ──────────────────────────────────────────────────────────────────────
gh variable set AZURE_TENANT_ID                 -b "$TENANT_ID"        -R "$GH_REPO"
gh variable set AZURE_CLIENT_ID                 -b "$APP_ID"           -R "$GH_REPO"
gh variable set AZURE_SUBSCRIPTION_ID           -b "$SUBSCRIPTION_ID"  -R "$GH_REPO"
gh variable set AZURE_CODE_SIGNING_ENDPOINT     -b "$ENDPOINT"         -R "$GH_REPO"
gh variable set AZURE_CODE_SIGNING_ACCOUNT_NAME -b "$ACCOUNT"          -R "$GH_REPO"
gh variable set AZURE_CERT_PROFILE_NAME         -b "$PROFILE"          -R "$GH_REPO"
echo "✓ GitHub Actions variables set"

# ──────────────────────────────────────────────────────────────────────
# Persist state for the post-IV script
# ──────────────────────────────────────────────────────────────────────
# Single-quote every value so the file is safe to `source`. GH_REPO and
# other env-overridable inputs may legally contain shell metacharacters
# (spaces, parentheses, etc.). Embedded single quotes are escaped via the
# standard '\'' trick so the closing quote terminates correctly.
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

cat > .signing-state.env <<EOF
# Generated $(date -u +%FT%TZ) — sourced by setup-signing-post-iv.sh
SUBSCRIPTION_ID=$(shq "$SUBSCRIPTION_ID")
TENANT_ID=$(shq "$TENANT_ID")
RG=$(shq "$RG")
ACCOUNT=$(shq "$ACCOUNT")
ACCOUNT_ID=$(shq "$ACCOUNT_ID")
PROFILE=$(shq "$PROFILE")
APP_ID=$(shq "$APP_ID")
SP_OBJ_ID=$(shq "$SP_OBJ_ID")
GH_REPO=$(shq "$GH_REPO")
GH_BRANCH=$(shq "$GH_BRANCH")
EOF
echo "✓ Saved state to .signing-state.env"

# ──────────────────────────────────────────────────────────────────────
# Stage 6 — open the portal for the one browser-only step
# ──────────────────────────────────────────────────────────────────────
# Placed last because Identity Validation is a portal-only KYC flow that
# must be performed by a human after all CLI-provisioned resources exist.
PORTAL_URL="https://portal.azure.com/#@/resource$ACCOUNT_ID/identityValidations"
echo
echo "═══════════════════════════════════════════════════════════════"
echo "Next: submit the Public Trust Identity Validation in the portal."
echo "(Org name, address, EIN, two emails, government-ID KYC.)"
echo "═══════════════════════════════════════════════════════════════"
if command -v open >/dev/null 2>&1; then
  open "$PORTAL_URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$PORTAL_URL" >/dev/null 2>&1 || true
fi
echo "Portal URL: $PORTAL_URL"
echo
echo "When status reaches 'Completed' (1–20 business days),"
echo "run: bash scripts/setup-signing-post-iv.sh"
