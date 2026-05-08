#!/usr/bin/env bash
# PostToolUse / Write|Edit hook: when a file under packages/server/world/**
# is modified, run the world-integrity vitest suite so invariants from
# AGENTS.md (bidirectional exits, frontmatter ↔ container ID, item/npc
# references) are enforced deterministically.
#
# Output is informational — exit 1 surfaces failures back to the agent
# without aborting the conversation.

set -uo pipefail

payload="$(cat || true)"
# Prefer jq; fall back to python3 (almost always available on macOS/Linux);
# last-resort sed is best-effort and cannot fully handle escaped quotes or
# nested keys named "file_path".
if command -v jq >/dev/null 2>&1; then
  # Fail-closed: jq parse failure surfaces an error rather than silently
  # skipping the integrity check.
  if ! file="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // ""' 2>/dev/null)"; then
    echo "[validate-world] ERROR: jq failed to parse hook payload — integrity check SKIPPED." >&2
    exit 1
  fi
elif command -v python3 >/dev/null 2>&1; then
  if ! file="$(printf '%s' "$payload" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
print((d.get("tool_input") or {}).get("file_path","") or "")' 2>/dev/null)"; then
    echo "[validate-world] ERROR: python3 failed to parse hook payload — integrity check SKIPPED." >&2
    exit 1
  fi
else
  echo "[validate-world] warning: jq and python3 not found; using best-effort sed fallback" >&2
  # Match the first "file_path":"..." value, stopping at the first unescaped
  # double quote. Escaped quotes inside the path WILL truncate the match.
  file="$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi

repo_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Anchor the path match to the resolved repo root so unrelated repos that
# happen to contain a `packages/server/world/` substring don't trigger.
if [[ "$file" != "$repo_root"/packages/server/world/* ]]; then
  exit 0
fi

if ! cd "$repo_root/packages/server"; then
  echo "[validate-world] ERROR: could not cd to '$repo_root/packages/server' — integrity check SKIPPED (edited file: $file)" >&2
  exit 1
fi

# Run only the world-integrity suite. On success, emit a one-line confirmation
# to stderr so the agent sees the check actually ran; on failure, surface the
# full vitest output and exit 1.
out="$(npx --no-install vitest run tests/world-integrity.test.ts --reporter=dot 2>&1)"
status=$?

if [ "$status" -ne 0 ]; then
  echo "[validate-world] world-integrity tests FAILED after editing $file" >&2
  echo "$out" >&2
  exit 1
fi

echo "[validate-world] world-integrity OK ($file)" >&2
exit 0
