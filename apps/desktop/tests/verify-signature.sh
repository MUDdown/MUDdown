#!/usr/bin/env bash
# Signature verification test for the Tauri auto-updater.
#
# This script validates that:
# 1. If .sig files are present, each one is verified against the project's public key.
# 2. A tampered artifact is REJECTED by the same signature.
#
# Must be run from the repository root (BUNDLE_DIR paths are relative to the repo root).
#
# Prerequisites:
#   - minisign (brew install minisign / apt install minisign)
#   - TAURI_PUBKEY env var set to the project's Ed25519 public key
#   - Artifacts already built by `tauri build` in the expected target directory
#
# Usage:
#   TAURI_PUBKEY="<pubkey>" ./apps/desktop/tests/verify-signature.sh <target>
#
# Example:
#   TAURI_PUBKEY="dW50cnV..." ./apps/desktop/tests/verify-signature.sh aarch64-apple-darwin

set -euo pipefail

TARGET="${1:?Usage: verify-signature.sh <target>}"
BUNDLE_DIR="apps/desktop/src-tauri/target/${TARGET}/release/bundle"

if [ -z "${TAURI_PUBKEY:-}" ]; then
  echo "WARNING: TAURI_PUBKEY environment variable is not set — skipping verification."
  exit 0
fi

if ! command -v minisign &> /dev/null; then
  echo "ERROR: minisign is not installed"
  exit 1
fi

# Write public key to a temp file for minisign -Vm
# TAURI_PUBKEY from tauri.conf.json is base64-encoded; minisign expects the
# decoded text (two lines: untrusted comment + base64 public key).
PUBKEY_FILE=$(mktemp)
echo "$TAURI_PUBKEY" | base64 -d > "$PUBKEY_FILE"
trap 'rm -f "$PUBKEY_FILE"' EXIT

PASSED=0
FAILED=0
FOUND=0

# Find all .sig files (e.g. .dmg.sig on macOS, .AppImage.tar.gz.sig on Linux)
while IFS= read -r -d '' sig_file; do
  FOUND=$((FOUND + 1))
  # The artifact is the sig file without the .sig extension
  artifact="${sig_file%.sig}"

  if [ ! -f "$artifact" ]; then
    echo "SKIP: Artifact not found for $sig_file"
    continue
  fi

  echo "─── Testing: $(basename "$artifact") ───"

  # Test 1: Valid signature should verify
  echo -n "  ✓ Valid signature... "
  if minisign -Vm "$artifact" -p "$PUBKEY_FILE" -x "$sig_file" > /dev/null 2>&1; then
    echo "PASS"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL (valid signature rejected!)"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Test 2: Tampered artifact should be rejected
  echo -n "  ✗ Tampered artifact... "
  TAMPERED=$(mktemp)
  cp "$artifact" "$TAMPERED"
  # Append a byte to tamper with the artifact
  printf '\x00' >> "$TAMPERED"

  if minisign -Vm "$TAMPERED" -p "$PUBKEY_FILE" -x "$sig_file" > /dev/null 2>&1; then
    echo "FAIL (tampered artifact was accepted!)"
    FAILED=$((FAILED + 1))
  else
    echo "PASS (correctly rejected)"
    PASSED=$((PASSED + 1))
  fi
  rm -f "$TAMPERED"
done < <(find "$BUNDLE_DIR" -name "*.sig" -print0 2>/dev/null)

if [ "$FOUND" -eq 0 ]; then
  echo "WARNING: No .sig files found in $BUNDLE_DIR — skipping verification."
  echo "This is expected when TAURI_SIGNING_PRIVATE_KEY is not configured."
  exit 0
fi

echo ""
echo "Results: $PASSED passed, $FAILED failed"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi

echo "All signature verification tests passed."
