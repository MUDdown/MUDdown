#!/usr/bin/env bash
# PostToolUse / Write|Edit hook: when a file under packages/server/world/**
# is modified, run the world-integrity vitest suite so invariants from
# AGENTS.md (bidirectional exits, frontmatter ↔ container ID, item/npc
# references) are enforced deterministically.
#
# Output is informational — exit 1 surfaces failures back to the agent
# without aborting the conversation.

set -u

payload="$(cat || true)"
if command -v jq >/dev/null 2>&1; then
  file="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // ""')"
else
  file="$(printf '%s' "$payload" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -n1)"
fi

case "$file" in
  *packages/server/world/*) ;;
  *) exit 0 ;;
esac

repo_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$repo_root/packages/server" 2>/dev/null || exit 0

# Run only world-integrity tests; quiet output unless something fails.
out="$(npx --no-install vitest run tests/world-integrity.test.ts --reporter=dot 2>&1)"
status=$?

if [ "$status" -ne 0 ]; then
  echo "[validate-world] world-integrity tests FAILED after editing $file" >&2
  echo "$out" >&2
  exit 1
fi

echo "[validate-world] world-integrity OK ($file)" >&2
exit 0
