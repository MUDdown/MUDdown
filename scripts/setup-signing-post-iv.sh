#!/usr/bin/env bash
# Run after Identity Validation reaches 'Completed' in the Azure portal.
# Creates the certificate profile, grants the GitHub SP the signer role
# (scoped to that profile), and triggers a signed desktop build.
#
# ⚠️  Continues from setup-signing.sh — requires .signing-state.env from that run.
set -euo pipefail

if [ "${MUDDOWN_SIGNING_CONSENT:-no}" != "yes" ]; then
  echo "Re-run with: MUDDOWN_SIGNING_CONSENT=yes bash scripts/setup-signing-post-iv.sh" >&2
  exit 1
fi

[ -f .signing-state.env ] || { echo "Missing .signing-state.env — run setup-signing.sh first" >&2; exit 1; }
# shellcheck disable=SC1091
source .signing-state.env

for cmd in az gh; do
  command -v "$cmd" >/dev/null || { echo "Missing required tool: $cmd" >&2; exit 1; }
done
az account show >/dev/null 2>&1 || { echo "Run 'az login' first." >&2; exit 1; }

echo "Identity validations on $ACCOUNT:"
az rest --method get \
  --url "https://management.azure.com$ACCOUNT_ID/identityValidations?api-version=2024-02-05-preview" \
  --query "value[].{name:name,state:properties.identityValidationState,id:properties.identityValidationId}" \
  -o table

read -rp "Paste the 'id' GUID of the Completed validation: " IDENTITY_VALIDATION_ID
[ -n "$IDENTITY_VALIDATION_ID" ] || { echo "ERROR: Empty input" >&2; exit 1; }
# Validate canonical 8-4-4-4-12 hex GUID format before hitting the Azure API,
# which would otherwise return an opaque 400 for a malformed identifier.
GUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
if ! [[ "$IDENTITY_VALIDATION_ID" =~ $GUID_RE ]]; then
  echo "ERROR: Invalid GUID format for IDENTITY_VALIDATION_ID: $IDENTITY_VALIDATION_ID" >&2
  exit 1
fi

# Certificate profile
if ! az artifact-signing certificate-profile show \
       -g "$RG" --account-name "$ACCOUNT" -n "$PROFILE" >/dev/null 2>&1; then
  az artifact-signing certificate-profile create \
    -g "$RG" --account-name "$ACCOUNT" -n "$PROFILE" \
    --profile-type PublicTrust \
    --identity-validation-id "$IDENTITY_VALIDATION_ID" >/dev/null
fi
PROFILE_ID=$(az artifact-signing certificate-profile show \
  -g "$RG" --account-name "$ACCOUNT" -n "$PROFILE" --query id -o tsv)
[ -n "$PROFILE_ID" ] || { echo "ERROR: could not retrieve PROFILE_ID for $PROFILE" >&2; exit 1; }
echo "✓ Certificate profile: $PROFILE"

# Signer role, scoped to the profile (least privilege).
# Use length(@) to count exactly — see the matching note in setup-signing.sh.
ROLE_COUNT=$(az role assignment list \
  --assignee "$SP_OBJ_ID" --scope "$PROFILE_ID" \
  --role "Artifact Signing Certificate Profile Signer" \
  --query "length(@)" -o tsv 2>/dev/null || echo 0)
if [ "${ROLE_COUNT:-0}" = "0" ]; then
  az role assignment create \
    --assignee-object-id "$SP_OBJ_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "Artifact Signing Certificate Profile Signer" \
    --scope "$PROFILE_ID" >/dev/null
fi
echo "✓ Signer role granted (scoped to profile)"

# Trigger a signed build. Branch is configurable so post-IV verification
# can run against a feature branch before flipping WINDOWS_SIGNING_ENABLED
# on main. Defaults to main; override via GH_BRANCH (set in .signing-state.env
# by setup-signing.sh, or exported in the current shell).
BRANCH="${GH_BRANCH:-main}"
gh workflow run "Desktop Build" -R "$GH_REPO" -r "$BRANCH"
echo "✓ Build triggered on $BRANCH — watch with: gh run watch -R $GH_REPO"
