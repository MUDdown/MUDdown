#!/usr/bin/env bash
# PreToolUse / Bash hook: block hard-to-reverse operations per AGENTS.md
# "operationalSafety". Allows the human to override by running the command
# manually outside the agent.
#
# Input  : Claude Code hook JSON on stdin (tool_input.command).
# Output : exit 0 to allow; exit 2 + stderr to block.

set -u

payload="$(cat || true)"
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')"
else
  cmd="$(printf '%s' "$payload" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -n1)"
fi

block() {
  echo "[block-dangerous] Refusing: $1" >&2
  echo "[block-dangerous] Run manually outside the agent if intentional." >&2
  exit 2
}

# git push --force / -f / +refspec
case "$cmd" in
  *"git push"*"--force"*|*"git push"*" -f "*|*"git push"*" -f"|*"git push"*" +"*)
    block "git push --force is not allowed via the agent." ;;
esac

# git reset --hard
case "$cmd" in
  *"git reset --hard"*|*"git reset"*" --hard"*)
    block "git reset --hard is not allowed via the agent." ;;
esac

# git commit --no-verify (bypasses pre-commit hooks)
case "$cmd" in
  *"git commit"*"--no-verify"*|*"git commit"*" -n "*|*"git commit"*" -n"*)
    block "git commit --no-verify bypasses pre-commit hooks." ;;
esac

# git clean -fdx outside known build dirs
case "$cmd" in
  *"git clean -fdx"*|*"git clean -fxd"*|*"git clean -dfx"*|*"git clean -dxf"*)
    block "git clean -fdx is not allowed via the agent." ;;
esac

# npm publish
case "$cmd" in
  *"npm publish"*|*"npm "*"publish"*)
    block "npm publish is not allowed via the agent." ;;
esac

# rm -rf with absolute paths or parent traversal — only allow inside known
# build/output directories.
if printf '%s' "$cmd" | grep -qE 'rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-rf|-fr)[[:space:]]'; then
  # Capture each token after rm flags and inspect.
  args="$(printf '%s' "$cmd" | sed -E 's/.*rm[[:space:]]+-[a-zA-Z]+[[:space:]]+//')"
  for tok in $args; do
    case "$tok" in
      ""|-*) continue ;;
      /|/*|"~"|"~/"*|"$HOME"*)
        block "rm -rf with absolute path: $tok" ;;
      *..*)
        block "rm -rf with parent traversal: $tok" ;;
      node_modules|dist|.turbo|coverage|.astro|.expo|build|out|target|node_modules/*|dist/*|.turbo/*|coverage/*|.astro/*|.expo/*|build/*|out/*|target/*)
        : ;; # safe build outputs
      *)
        # Anything else under the workspace is also blocked — too risky.
        block "rm -rf outside build directories: $tok" ;;
    esac
  done
fi

exit 0
