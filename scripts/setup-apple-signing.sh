#!/usr/bin/env bash
# Apple Developer ID Application certificate provisioning for macOS
# notarization. Idempotent: safe to re-run if any step fails partway.
#
# What this automates:
#  - Generates a fresh 2048-bit RSA private key locally; the raw .key file
#    never leaves this machine. The key material *is* later re-bundled
#    (encrypted) into the .p12 that is uploaded to GitHub Actions secrets.
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
  # Unquoted heredoc: only $WORK_DIR expands here. Do not add $VAR
  # references, backticks, or $(...) to this body without quoting them.
  cat <<EOF >&2
This script will:
  - Generate a Developer ID Application private key on this machine
  - Submit a CSR to App Store Connect (counts against your 5-cert limit)
  - Bundle the issued cert + key into a password-protected .p12 in
    $WORK_DIR
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

# `openssl pkcs12 -legacy` is an OpenSSL 3.x option needed for macOS
# Keychain compatibility on Sequoia/Sonoma. macOS ships LibreSSL at
# /usr/bin/openssl, which does NOT support -legacy and would otherwise
# fail late in the script — *after* a Developer ID cert has already been
# burned against the 5-per-team cap. Catch it now.
if ! openssl pkcs12 -help 2>&1 | grep -q -- '-legacy'; then
  cat <<EOF >&2
Detected openssl: $(command -v openssl) ($(openssl version))
This build does not support 'pkcs12 -legacy', which this script requires
for macOS Keychain compatibility. macOS ships LibreSSL at
/usr/bin/openssl, which lacks this flag.

Install OpenSSL 3 via Homebrew and put it first on PATH:

  brew install openssl@3
  export PATH="\$(brew --prefix openssl@3)/bin:\$PATH"

Then re-run this script.
EOF
  exit 1
fi

# Functional runtime check: the help-text grep above catches LibreSSL, but
# some Linux distributions package OpenSSL 3.x with the legacy provider
# compiled out — it appears in help text but fails at runtime.
_legacy_err=$(openssl genrsa 512 2>/dev/null \
  | openssl pkcs12 -export -legacy -inkey /dev/stdin \
    -out /dev/null -passout pass:smoke 2>&1 || true)
if printf '%s' "$_legacy_err" | grep -qiE 'provider|unknown option.*legacy'; then
  cat <<EOF >&2
Detected openssl: $(command -v openssl) ($(openssl version))
The '-legacy' provider is not available at runtime.

On macOS:  brew install openssl@3 && export PATH="\$(brew --prefix openssl@3)/bin:\$PATH"
On Linux:  install the openssl-legacy package for your distribution.
EOF
  exit 1
fi

# The Python `cryptography` package is only needed for the App Store
# Connect ES256 JWT path. If a portal-issued .cer is already on disk in
# $WORK_DIR (the manual-flow case — see scripts/README.md), the API call
# is skipped entirely and we don't need the dependency.
if [ ! -f "$WORK_DIR/${P12_NAME}.cer" ] \
   && ! python3 -c 'import cryptography' 2>/dev/null; then
  cat <<'EOF' >&2
Missing Python 'cryptography' package (required for ES256 JWT signing).
Install with:
  python3 -m pip install --user cryptography
Then re-run this script.

(If you intend to use the manual-portal flow, drop the issued .cer at
 $WORK_DIR/${P12_NAME}.cer first and this dependency is not needed.)
EOF
  exit 1
fi

gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first." >&2; exit 1; }

if ! gh repo view "$GH_REPO" --json viewerPermission --jq '.viewerPermission' 2>/dev/null \
     | grep -qE 'ADMIN|MAINTAIN|WRITE'; then
  echo "You don't have write access to $GH_REPO (or it doesn't exist)." >&2
  echo "Set GH_REPO=<your-org>/<your-repo> when forking." >&2
  exit 1
fi

mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"

# If a portal-issued .cer is already on disk we'll short-circuit the
# App Store Connect API call entirely (the manual-flow case — see
# scripts/README.md). In that case the .p8 / Key ID / Issuer ID inputs
# are unused, so don't prompt for them. We still need every other input
# (Team ID, Apple ID, common name, app-specific password, .p12 password).
HAVE_PORTAL_CERT=no
if [ -f "$WORK_DIR/${P12_NAME}.cer" ]; then
  if ! openssl x509 -in "$WORK_DIR/${P12_NAME}.cer" -inform DER -noout 2>/dev/null; then
    echo "Existing $WORK_DIR/${P12_NAME}.cer is not a valid DER certificate — delete it and re-run." >&2
    exit 1
  fi
  HAVE_PORTAL_CERT=yes
  echo "→ Found existing $WORK_DIR/${P12_NAME}.cer — skipping App Store Connect API prompts."
fi

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
  while :; do
    if [ "$hidden" = "yes" ]; then
      read -rsp "$prompt_text: " "$var_name"
      echo
    else
      read -rp "$prompt_text: " "$var_name"
    fi
    if [ -n "${!var_name}" ]; then break; fi
    echo "  (value is required — please try again)" >&2
  done
  export "$var_name"
}

if [ "$HAVE_PORTAL_CERT" != "yes" ]; then
  prompt APP_STORE_CONNECT_KEY_ID    "App Store Connect Key ID (10 chars)"
  prompt APP_STORE_CONNECT_ISSUER_ID "App Store Connect Issuer ID (UUID)"
  prompt APP_STORE_CONNECT_KEY_PATH  "Path to your downloaded .p8 file"
fi
prompt APPLE_TEAM_ID               "Apple Team ID (10 chars)"
prompt APPLE_ID                    "Apple ID (email)"
prompt APPLE_COMMON_NAME           "Common Name on the cert (e.g. 'StickMUD Entertainment LLC')"

if [ "$HAVE_PORTAL_CERT" != "yes" ]; then
  [ -f "$APP_STORE_CONNECT_KEY_PATH" ] \
    || { echo "App Store Connect key not found: $APP_STORE_CONNECT_KEY_PATH" >&2; exit 1; }
fi

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
# Step 1 — Generate the private key + CSR (idempotent, drift-aware)
# ──────────────────────────────────────────────────────────────────────
KEY_PATH="$WORK_DIR/${P12_NAME}.key"
CSR_PATH="$WORK_DIR/${P12_NAME}.csr"
CSR_CONF="$WORK_DIR/${P12_NAME}.csr.conf"
CER_PATH="$WORK_DIR/${P12_NAME}.cer"
P12_PATH="$WORK_DIR/${P12_NAME}.p12"

# Build the CSR via a config file rather than `-subj`. OpenSSL's `-subj`
# uses '/' as the RDN delimiter, which silently corrupts CNs that
# contain '/' (e.g. "A/V Systems LLC") or '=' or other special chars.
# Use a quoted heredoc for the static sections and printf for the
# user-supplied values — avoids command substitution in an unquoted
# heredoc if APPLE_COMMON_NAME or APPLE_ID contain $(...) or backticks.
cat > "$CSR_CONF" <<'ENDCONF'
[req]
distinguished_name = dn
prompt             = no
[dn]
ENDCONF
printf 'CN           = %s\nemailAddress = %s\nC            = US\n' \
  "$APPLE_COMMON_NAME" "$APPLE_ID" >> "$CSR_CONF"
chmod 600 "$CSR_CONF"

if [ ! -f "$KEY_PATH" ]; then
  echo "→ Generating 2048-bit RSA key…"
  openssl genrsa -out "$KEY_PATH" 2048
  chmod 600 "$KEY_PATH"
  # Fresh key invalidates any pre-existing CSR/cert — wipe them so we
  # don't submit a CSR encoding a *different* (now-deleted) key's pubkey
  # and get a cert issued that we can never bundle into a .p12. Apple
  # caps Developer ID Application certs at 5 per team, so a wasted slot
  # on a key/CSR mismatch is genuinely costly.
  rm -f "$CSR_PATH" "$CER_PATH"
fi
# Validate the key is well-formed (catches partial writes / corrupted reuse).
if ! _key_err=$(openssl rsa -in "$KEY_PATH" -noout -check 2>&1); then
  echo "Private key at $KEY_PATH is invalid: $_key_err" >&2
  echo "Delete $KEY_PATH and re-run to generate a fresh key." >&2
  exit 1
fi

# If a CSR is already on disk, verify it still matches the current key
# *and* the current APPLE_COMMON_NAME. If either has drifted, regenerate
# the CSR (and discard any cert that was issued for the stale CSR).
if [ -f "$CSR_PATH" ]; then
  # Break each modulus read into a separate step so that a non-zero exit
  # from openssl doesn't silently produce an empty MD5 hash via pipefail.
  # If either read fails, use a sentinel value that guarantees mismatch.
  _KEY_RAW=$(openssl rsa -in "$KEY_PATH" -noout -modulus 2>/dev/null) \
    || _KEY_RAW="(key-unreadable)"
  _CSR_RAW=$(openssl req -in "$CSR_PATH" -noout -modulus 2>/dev/null) \
    || _CSR_RAW="(csr-unreadable)"
  KEY_MOD=$(printf '%s' "$_KEY_RAW" | openssl md5 | awk '{print $NF}')
  CSR_MOD=$(printf '%s' "$_CSR_RAW" | openssl md5 | awk '{print $NF}')
  CSR_CN=$(openssl req -in "$CSR_PATH" -noout -subject -nameopt multiline,utf8 \
    | awk -F'= ' '/^[[:space:]]*commonName/ { sub(/[[:space:]]+$/, "", $2); print $2; exit }')
  if [ "$KEY_MOD" != "$CSR_MOD" ] || [ "$CSR_CN" != "$APPLE_COMMON_NAME" ]; then
    echo "→ Existing CSR is stale (key or Common Name has changed); regenerating."
    rm -f "$CSR_PATH" "$CER_PATH"
  fi
fi

if [ ! -f "$CSR_PATH" ]; then
  echo "→ Building CSR…"
  openssl req -new -key "$KEY_PATH" -out "$CSR_PATH" -config "$CSR_CONF"
fi

# Apple expects the CSR as base64-encoded *PEM body* (lines between BEGIN/END).
CSR_BODY_B64=$(awk '/BEGIN CERTIFICATE REQUEST/{flag=1;next}/END CERTIFICATE REQUEST/{flag=0}flag' \
  "$CSR_PATH" | tr -d '\r\n')
[ -n "$CSR_BODY_B64" ] \
  || { echo "CSR at $CSR_PATH is empty or malformed (no PEM body). Delete it and re-run." >&2; exit 1; }

# ──────────────────────────────────────────────────────────────────────
# Step 2 — Decide whether we need a new certificate from App Store Connect
# ──────────────────────────────────────────────────────────────────────
# (CER_PATH / P12_PATH were defined alongside KEY_PATH/CSR_PATH above.)

NEEDS_NEW_CERT=yes
if [ -f "$CER_PATH" ] && [ "${FORCE_NEW_CERT:-no}" != "yes" ]; then
  # If a non-expired cert is on disk, reuse it. Apple caps the team at 5
  # active Developer ID Application certs; we don't want to burn one on
  # every dry-run. We refuse to silently re-issue on a date-parse failure
  # — the user must explicitly opt in via FORCE_NEW_CERT=yes.
  EXP=$(openssl x509 -in "$CER_PATH" -inform DER -noout -enddate 2>/dev/null \
    | awk -F= '/notAfter/ {print $2}')
  if [ -z "$EXP" ]; then
    echo "Existing $CER_PATH is unreadable (no notAfter). Delete it or set FORCE_NEW_CERT=yes." >&2
    exit 1
  fi
  # Normalize double-space day-of-month padding ("Jan  2" → "Jan 2") so
  # BSD date -f '%b %d ...' parses correctly on macOS for days 1-9.
  EXP_NORM=$(printf '%s' "$EXP" | tr -s ' ')
  EXP_EPOCH=$(date -u -j -f '%b %d %T %Y %Z' "$EXP_NORM" +%s 2>/dev/null \
           || date -u -d "$EXP_NORM" +%s 2>/dev/null || true)
  if [ -z "$EXP_EPOCH" ]; then
    echo "Could not parse certificate expiry '$EXP_NORM'. Set FORCE_NEW_CERT=yes to re-issue, or fix locally." >&2
    exit 1
  fi
  if [ "$(date -u +%s)" -lt "$EXP_EPOCH" ]; then
    echo "→ Reusing existing certificate (valid until $EXP_NORM)"
    NEEDS_NEW_CERT=no
  fi
fi

if [ "$NEEDS_NEW_CERT" = "yes" ]; then
  # Build the short-lived (≤20-min) ES256 JWT only when we actually need
  # to call the API. Building it eagerly would load the .p8 key into a
  # Python process on every run, even when reusing a still-valid cert.
  #
  # ES256 signing requires DER→JOSE signature conversion (Apple rejects
  # raw OpenSSL DER signatures), which is awkward in pure bash. The
  # `cryptography` package was pre-checked in the bash preflight.
  echo "→ Building App Store Connect JWT…"
  JWT=$(python3 - "$APP_STORE_CONNECT_KEY_ID" "$APP_STORE_CONNECT_ISSUER_ID" "$APP_STORE_CONNECT_KEY_PATH" <<'PY'
import base64, json, sys, time
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

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

  echo "→ Requesting Developer ID Application certificate from App Store Connect…"
  REQ_BODY=$(jq -nc \
    --arg type "$CERT_TYPE" --arg csr "$CSR_BODY_B64" \
    '{data:{type:"certificates",attributes:{certificateType:$type,csrContent:$csr}}}')

  RESP=$(curl -sS -X POST https://api.appstoreconnect.apple.com/v1/certificates \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    -d "$REQ_BODY")

  # `jq -e` returns success on the JSON string "" — guard against null/empty
  # certificateContent explicitly so we never write a zero-byte .cer that
  # would then poison the idempotency check on the next run.
  CERT_B64=$(printf '%s' "$RESP" | jq -r '.data.attributes.certificateContent // empty')
  if [ -z "$CERT_B64" ]; then
    echo "App Store Connect rejected the request or returned empty certificateContent:" >&2
    printf '%s\n' "$RESP" | jq . >&2 || printf '%s\n' "$RESP" >&2
    exit 1
  fi

  # `base64 --decode` is GNU; macOS BSD `base64` uses `-D`. Use
  # `openssl base64 -d -A` which is portable across both (and is already
  # a hard dependency of this script).
  printf '%s' "$CERT_B64" | openssl base64 -d -A > "$CER_PATH"
  if [ ! -s "$CER_PATH" ] \
     || ! openssl x509 -in "$CER_PATH" -inform DER -noout 2>/dev/null; then
    echo "Decoded certificate at $CER_PATH is empty or not valid DER." >&2
    rm -f "$CER_PATH"
    exit 1
  fi
  echo "✓ Certificate saved to $CER_PATH"
fi

# ──────────────────────────────────────────────────────────────────────
# Step 4 — Bundle key + cert into a .p12
# ──────────────────────────────────────────────────────────────────────
echo "→ Building ${P12_PATH}…"
# Convert the DER cert to PEM for openssl pkcs12; the private key is
# already PEM. -legacy avoids macOS Keychain "MAC verification failed"
# loading errors on Sequoia / Sonoma. Note: GitHub-hosted Linux runners
# using OpenSSL 3.x must explicitly enable the legacy provider to read
# this .p12 (`-provider legacy -provider default` on the import side, or
# rely on Apple's `apple-actions/import-codesign-certs` which already
# does this).
CER_PEM_PATH="$WORK_DIR/${P12_NAME}.pem"
openssl x509 -inform DER -in "$CER_PATH" -out "$CER_PEM_PATH"

# Extract the CN using -nameopt multiline (one attribute per line, no
# comma escaping). Apple issues Developer ID certs as e.g.
#   commonName = Developer ID Application: Acme, LLC (ABCDE12345)
# A naive `sed 's/.*CN=([^,]+).*/\1/'` truncates on the first comma,
# silently breaking codesign matching for any org with a comma in its
# legal name.
SIGNING_IDENTITY=$(openssl x509 -in "$CER_PEM_PATH" -noout -subject -nameopt multiline,utf8 \
  | awk -F'= ' '/^[[:space:]]*commonName/ { sub(/[[:space:]]+$/, "", $2); print $2; exit }')
[ -n "$SIGNING_IDENTITY" ] \
  || { echo "Could not extract CN from certificate." >&2; exit 1; }

# Apple issues Developer ID identities as e.g.
#   "Developer ID Application: StickMUD Entertainment LLC (ABCDE12345)"
# Cross-check that the Team ID embedded in the CN matches the value the
# user typed at the prompt. A mismatch here means either the prompt was
# wrong or the cert came from a different team — either way the secrets
# we're about to push would lead to confusing CI notarization failures
# rather than a clean error here.
case "$SIGNING_IDENTITY" in
  *"($APPLE_TEAM_ID)") ;;
  *)
    echo "✗ Signing identity does not contain the configured Team ID." >&2
    echo "    Identity:  $SIGNING_IDENTITY" >&2
    echo "    Team ID:   $APPLE_TEAM_ID" >&2
    echo "  Re-run with the correct APPLE_TEAM_ID, or delete \$WORK_DIR" >&2
    echo "  if this cert was issued under the wrong team." >&2
    exit 1
    ;;
esac

# Pass the password via file rather than `pass:…` so it never appears in
# the process argv (visible to other users via `ps`).
openssl pkcs12 -export -legacy \
  -inkey "$KEY_PATH" -in "$CER_PEM_PATH" \
  -name "$SIGNING_IDENTITY" \
  -out "$P12_PATH" \
  -passout "file:$P12_PASSWORD_FILE"
chmod 600 "$P12_PATH"
echo "✓ .p12 ready: $P12_PATH"
echo "  Signing identity: $SIGNING_IDENTITY"

# Verify the .p12 round-trips: extract cert and key moduli separately and
# confirm they match. Catches key/cert mismatches, wrong password, and
# corrupt .p12 files. set +e around the pipelines since we check results
# explicitly via the empty-string and equality tests below.
set +e
_P12_CERT_MOD=$(openssl pkcs12 -in "$P12_PATH" -clcerts -nokeys \
  -passin "file:$P12_PASSWORD_FILE" -legacy 2>/dev/null \
  | openssl x509 -noout -modulus 2>/dev/null \
  | openssl md5 2>/dev/null | awk '{print $NF}')
_P12_KEY_MOD=$(openssl pkcs12 -in "$P12_PATH" -nocerts \
  -passin "file:$P12_PASSWORD_FILE" -legacy -passout pass:smoke 2>/dev/null \
  | openssl rsa -passin pass:smoke -noout -modulus 2>/dev/null \
  | openssl md5 2>/dev/null | awk '{print $NF}')
set -e
if [ -z "$_P12_CERT_MOD" ] || [ -z "$_P12_KEY_MOD" ] || [ "$_P12_CERT_MOD" != "$_P12_KEY_MOD" ]; then
  echo "Self-test failed: key and cert in $P12_PATH do not match (or file is unreadable)." >&2
  exit 1
fi

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

# Push secrets one by one and aggregate failures so a partial-secrets
# state is reported clearly. We disable `set -e` only inside this loop;
# the caller still gets a non-zero exit if anything failed.
set +e
FAILED=()
push_secret() {
  local name="$1" value="$2" _err
  # Capture gh's stderr so we can report which secret failed and why.
  # 2>&1 >/dev/null: stderr goes to capture pipe, stdout to /dev/null.
  if ! _err=$(printf '%s' "$value" | gh secret set "$name" -R "$GH_REPO" --body - 2>&1 >/dev/null); then
    echo "  Failed to push $name: $_err" >&2
    FAILED+=("$name")
  fi
}
push_secret APPLE_CERTIFICATE          "$P12_B64"
push_secret APPLE_CERTIFICATE_PASSWORD "$P12_PASSWORD"
push_secret APPLE_SIGNING_IDENTITY     "$SIGNING_IDENTITY"
push_secret APPLE_TEAM_ID              "$APPLE_TEAM_ID"
push_secret APPLE_ID                   "$APPLE_ID"
push_secret APPLE_PASSWORD             "$APPLE_APP_SPECIFIC_PASSWORD"
set -e

if [ "${#FAILED[@]}" -ne 0 ]; then
  echo >&2
  echo "✗ Failed to push the following secrets to $GH_REPO:" >&2
  for s in "${FAILED[@]}"; do echo "    - $s" >&2; done
  echo "  Re-run the script (idempotent) or 'gh secret set' the failed names manually." >&2
  exit 1
fi
echo "✓ All six APPLE_* secrets pushed to $GH_REPO"
echo
echo "Next step: trigger a desktop build. The macOS leg should now produce a"
echo "notarized + stapled .dmg, and the Verify notarization (macOS) workflow"
echo "step should pass."
