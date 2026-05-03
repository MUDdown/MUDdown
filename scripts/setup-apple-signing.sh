#!/usr/bin/env bash
# Apple Developer ID Application certificate provisioning for macOS
# notarization. Idempotent: safe to re-run if any step fails partway.
#
# What this automates:
#  - Generates a fresh 2048-bit RSA private key locally (never leaves this machine)
#  - Builds a Certificate Signing Request (CSR) for the key
#  - Signs an App Store Connect API JWT (ES256) using your downloaded .p8 key
#  - POSTs the CSR to https://api.appstoreconnect.apple.com/v1/certificates
#    with certificateType=DEVELOPER_ID_APPLICATION
#  - Bundles the issued certificate + private key into a password-protected
#    .p12 ready for GitHub Actions
#  - Optionally pushes APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD /
#    APPLE_SIGNING_IDENTITY / APPLE_TEAM_ID / APPLE_ID secrets to GitHub
#
# What still needs the portal (one-time human steps):
#  1. App Store Connect → Users and Access → Integrations → App Store Connect
#     API → Generate API Key with the **Admin** role. Apple shows the .p8
#     exactly once for download.
#  2. Apple ID → Sign-In and Security → App-Specific Passwords → generate one
#     for "MUDdown notarization". This password cannot be retrieved later.
#  3. Apple Developer membership page → note your **Team ID** (10-char string).
#
# After this completes, the .p12, password, signing identity, team ID, Apple
# ID, and app-specific password are everything macOS notarization needs in CI.
#
# ⚠️  THIS SCRIPT GENERATES A REAL DEVELOPER ID CERTIFICATE.
# ⚠️  Apple limits Developer ID Application certificates to 5 active per team.
# ⚠️  Re-running with FORCE_NEW_CERT=yes will create another one.
#
# Safe-by-default behaviour:
#  - Refuses to run unless MUDDOWN_APPLE_SIGNING_CONSENT=yes
#  - Verifies write access to GH_REPO before pushing secrets
#  - All filenames and overrides are env-driven
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
# Config (override any of these via environment if forking)
# ──────────────────────────────────────────────────────────────────────
GH_REPO="${GH_REPO:-MUDdown/MUDdown}"
WORK_DIR="${WORK_DIR:-$HOME/.muddown-apple-signing}"
P12_NAME="${P12_NAME:-developer-id-application}"
CERT_TYPE="${CERT_TYPE:-DEVELOPER_ID_APPLICATION}"

# ──────────────────────────────────────────────────────────────────────
# Consent gate
# ──────────────────────────────────────────────────────────────────────
if [ "${MUDDOWN_APPLE_SIGNING_CONSENT:-no}" != "yes" ]; then
  cat <<'EOF' >&2
This script will:
  - Generate a Developer ID Application private key on this machine
  - Submit a CSR to App Store Connect (counts against your 5-cert limit)
  - Optionally push APPLE_* secrets to a GitHub repository

Before running, make sure you have:
  1. An App Store Connect API key (.p8) downloaded — Admin role
  2. Your App Store Connect Key ID (10 chars) and Issuer ID (UUID)
  3. Your Apple Team ID (10 chars, e.g. ABCDE12345)
  4. Your Apple ID (the email address) and an app-specific password
     (https://account.apple.com → Sign-In and Security → App-Specific Passwords)

Re-run with explicit consent:

  MUDDOWN_APPLE_SIGNING_CONSENT=yes bash scripts/setup-apple-signing.sh

For forks, also set GH_REPO=<your-org>/<your-repo>.
EOF
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Preflight
# ──────────────────────────────────────────────────────────────────────
for cmd in openssl curl jq python3 gh; do
  command -v "$cmd" >/dev/null || { echo "Missing required tool: $cmd" >&2; exit 1; }
done

gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }

if ! gh repo view "$GH_REPO" --json viewerPermission --jq '.viewerPermission' 2>/dev/null \
     | grep -qE 'ADMIN|MAINTAIN|WRITE'; then
  echo "You don't have write access to $GH_REPO (or it doesn't exist)." >&2
  echo "Set GH_REPO=<your-org>/<your-repo> when forking." >&2
  exit 1
fi

mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"

# ──────────────────────────────────────────────────────────────────────
# Collect inputs interactively (no values stored in shell history)
# ──────────────────────────────────────────────────────────────────────
prompt() {
  local var_name="$1" prompt_text="$2" hidden="${3:-no}"
  local current="${!var_name:-}"
  if [ -n "$current" ]; then
    echo "Using $var_name from environment."
    return
  fi
  if [ "$hidden" = "yes" ]; then
    read -rsp "$prompt_text: " "$var_name"
    echo
  else
    read -rp "$prompt_text: " "$var_name"
  fi
  export "$var_name"
}

prompt APP_STORE_CONNECT_KEY_ID    "App Store Connect Key ID (10 chars)"
prompt APP_STORE_CONNECT_ISSUER_ID "App Store Connect Issuer ID (UUID)"
prompt APP_STORE_CONNECT_KEY_PATH  "Path to your downloaded .p8 file"
prompt APPLE_TEAM_ID               "Apple Team ID (10 chars)"
prompt APPLE_ID                    "Apple ID (email)"
prompt APPLE_COMMON_NAME           "Common Name on the cert (e.g. 'StickMUD Entertainment LLC')"

[ -f "$APP_STORE_CONNECT_KEY_PATH" ] \
  || { echo "App Store Connect key not found: $APP_STORE_CONNECT_KEY_PATH" >&2; exit 1; }

# Generate (or reuse) an export password for the .p12. Stored in the work
# directory with mode 600 so re-runs keep working without re-prompting.
P12_PASSWORD_FILE="$WORK_DIR/${P12_NAME}.p12.password"
if [ -f "$P12_PASSWORD_FILE" ]; then
  P12_PASSWORD=$(cat "$P12_PASSWORD_FILE")
  echo "Reusing existing .p12 export password from $P12_PASSWORD_FILE"
else
  P12_PASSWORD=$(openssl rand -base64 24 | tr -d '\n=' | tr '/+' '_-')
  printf '%s' "$P12_PASSWORD" > "$P12_PASSWORD_FILE"
  chmod 600 "$P12_PASSWORD_FILE"
  echo "Generated a fresh .p12 export password (saved to $P12_PASSWORD_FILE)."
fi

# Optional but expected — captured here so the final secret push is one step.
prompt APPLE_APP_SPECIFIC_PASSWORD "App-specific password for $APPLE_ID" yes

# ──────────────────────────────────────────────────────────────────────
# Step 1 — Generate the private key + CSR (idempotent)
# ──────────────────────────────────────────────────────────────────────
KEY_PATH="$WORK_DIR/${P12_NAME}.key"
CSR_PATH="$WORK_DIR/${P12_NAME}.csr"

if [ ! -f "$KEY_PATH" ]; then
  echo "→ Generating 2048-bit RSA key…"
  openssl genrsa -out "$KEY_PATH" 2048
  chmod 600 "$KEY_PATH"
fi

if [ ! -f "$CSR_PATH" ]; then
  echo "→ Building CSR…"
  openssl req -new -key "$KEY_PATH" -out "$CSR_PATH" \
    -subj "/emailAddress=${APPLE_ID}/CN=${APPLE_COMMON_NAME}/C=US"
fi

# Apple expects the CSR as base64-encoded *PEM body* (lines between BEGIN/END).
CSR_BODY_B64=$(awk '/BEGIN CERTIFICATE REQUEST/{flag=1;next}/END CERTIFICATE REQUEST/{flag=0}flag' \
  "$CSR_PATH" | tr -d '\n')

# ──────────────────────────────────────────────────────────────────────
# Step 2 — Build a short-lived (≤20-min) ES256 JWT for App Store Connect
# ──────────────────────────────────────────────────────────────────────
# We use python3 because ES256 signing requires DER→JOSE signature
# conversion (Apple rejects raw OpenSSL DER signatures), which is awkward
# in pure bash. Python ships with macOS Xcode Command Line Tools.
JWT=$(python3 - "$APP_STORE_CONNECT_KEY_ID" "$APP_STORE_CONNECT_ISSUER_ID" "$APP_STORE_CONNECT_KEY_PATH" <<'PY'
import base64, hashlib, json, sys, time
from pathlib import Path

# We rely only on stdlib + cryptography from XCode? No — stdlib has no ES256.
# Try cryptography (commonly preinstalled with pip); fall back to instructing
# the user.
try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
except ImportError:
    sys.stderr.write(
        "Missing Python 'cryptography' package. Install with:\n"
        "  python3 -m pip install --user cryptography\n"
    )
    sys.exit(1)

key_id, issuer_id, p8_path = sys.argv[1], sys.argv[2], sys.argv[3]
header  = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
now     = int(time.time())
payload = {"iss": issuer_id, "iat": now, "exp": now + 1100, "aud": "appstoreconnect-v1"}

def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=")

signing_input = b64url(json.dumps(header,  separators=(',', ':')).encode()) + b"." \
              + b64url(json.dumps(payload, separators=(',', ':')).encode())

private_key = serialization.load_pem_private_key(Path(p8_path).read_bytes(), password=None)
der_sig     = private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
r, s        = decode_dss_signature(der_sig)
jose_sig    = r.to_bytes(32, "big") + s.to_bytes(32, "big")

print((signing_input + b"." + b64url(jose_sig)).decode())
PY
)
[ -n "$JWT" ] || { echo "Failed to build App Store Connect JWT" >&2; exit 1; }

# ──────────────────────────────────────────────────────────────────────
# Step 3 — Submit the CSR
# ──────────────────────────────────────────────────────────────────────
CER_PATH="$WORK_DIR/${P12_NAME}.cer"
P12_PATH="$WORK_DIR/${P12_NAME}.p12"

NEEDS_NEW_CERT=yes
if [ -f "$CER_PATH" ] && [ "${FORCE_NEW_CERT:-no}" != "yes" ]; then
  # If a non-expired cert is on disk, reuse it. Apple caps the team at 5
  # active Developer ID Application certs; we don't want to burn one on
  # every dry-run.
  EXP=$(openssl x509 -in "$CER_PATH" -inform DER -noout -enddate 2>/dev/null \
    | awk -F= '/notAfter/ {print $2}')
  if [ -n "$EXP" ] && [ "$(date -u +%s)" -lt "$(date -u -j -f '%b %d %T %Y %Z' "$EXP" +%s 2>/dev/null \
                                                  || date -u -d "$EXP" +%s 2>/dev/null \
                                                  || echo 0)" ]; then
    echo "→ Reusing existing certificate (valid until $EXP)"
    NEEDS_NEW_CERT=no
  fi
fi

if [ "$NEEDS_NEW_CERT" = "yes" ]; then
  echo "→ Requesting Developer ID Application certificate from App Store Connect…"
  REQ_BODY=$(jq -nc \
    --arg type "$CERT_TYPE" --arg csr "$CSR_BODY_B64" \
    '{data:{type:"certificates",attributes:{certificateType:$type,csrContent:$csr}}}')

  RESP=$(curl -sS -X POST https://api.appstoreconnect.apple.com/v1/certificates \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    -d "$REQ_BODY")

  if ! printf '%s' "$RESP" | jq -e '.data.attributes.certificateContent' >/dev/null; then
    echo "App Store Connect rejected the request:" >&2
    printf '%s\n' "$RESP" | jq . >&2 || printf '%s\n' "$RESP" >&2
    exit 1
  fi

  printf '%s' "$RESP" | jq -r '.data.attributes.certificateContent' \
    | base64 --decode > "$CER_PATH"
  echo "✓ Certificate saved to $CER_PATH"
fi

# ──────────────────────────────────────────────────────────────────────
# Step 4 — Bundle key + cert into a .p12
# ──────────────────────────────────────────────────────────────────────
echo "→ Building $P12_PATH…"
# Convert the DER cert to PEM for openssl pkcs12; the private key is
# already PEM. -legacy avoids macOS Keychain "MAC verification failed"
# loading errors on Sequoia / Sonoma.
CER_PEM_PATH="$WORK_DIR/${P12_NAME}.pem"
openssl x509 -inform DER -in "$CER_PATH" -out "$CER_PEM_PATH"

SIGNING_IDENTITY=$(openssl x509 -in "$CER_PEM_PATH" -noout -subject -nameopt RFC2253 \
  | sed -E 's/.*CN=([^,]+).*/\1/')
[ -n "$SIGNING_IDENTITY" ] \
  || { echo "Could not extract CN from certificate." >&2; exit 1; }

openssl pkcs12 -export -legacy \
  -inkey "$KEY_PATH" -in "$CER_PEM_PATH" \
  -name "$SIGNING_IDENTITY" \
  -out "$P12_PATH" \
  -passout "pass:$P12_PASSWORD"
chmod 600 "$P12_PATH"
echo "✓ .p12 ready: $P12_PATH"
echo "  Signing identity: $SIGNING_IDENTITY"

# ──────────────────────────────────────────────────────────────────────
# Step 5 — Push secrets to GitHub Actions
# ──────────────────────────────────────────────────────────────────────
if [ "${SKIP_GH_SECRETS:-no}" = "yes" ]; then
  echo "Skipping GitHub secret push (SKIP_GH_SECRETS=yes)."
  exit 0
fi

echo
echo "About to push the following secrets to $GH_REPO:"
echo "  APPLE_CERTIFICATE          (base64 of $P12_PATH)"
echo "  APPLE_CERTIFICATE_PASSWORD"
echo "  APPLE_SIGNING_IDENTITY     ($SIGNING_IDENTITY)"
echo "  APPLE_TEAM_ID              ($APPLE_TEAM_ID)"
echo "  APPLE_ID                   ($APPLE_ID)"
echo "  APPLE_PASSWORD             (app-specific password)"
read -rp "Push to GitHub? [y/N] " CONFIRM
[ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ] \
  || { echo "Skipped. Re-run when ready, or set the secrets manually."; exit 0; }

P12_B64=$(base64 < "$P12_PATH" | tr -d '\n')
gh secret set APPLE_CERTIFICATE          -b "$P12_B64"                     -R "$GH_REPO"
gh secret set APPLE_CERTIFICATE_PASSWORD -b "$P12_PASSWORD"                -R "$GH_REPO"
gh secret set APPLE_SIGNING_IDENTITY     -b "$SIGNING_IDENTITY"            -R "$GH_REPO"
gh secret set APPLE_TEAM_ID              -b "$APPLE_TEAM_ID"               -R "$GH_REPO"
gh secret set APPLE_ID                   -b "$APPLE_ID"                    -R "$GH_REPO"
gh secret set APPLE_PASSWORD             -b "$APPLE_APP_SPECIFIC_PASSWORD" -R "$GH_REPO"
echo "✓ All six APPLE_* secrets pushed to $GH_REPO"
echo
echo "Next step: trigger a desktop build. The macOS leg should now produce a"
echo "notarized + stapled .dmg, and the Verify notarization (macOS) workflow"
echo "step should pass."
