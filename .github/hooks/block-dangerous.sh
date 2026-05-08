#!/usr/bin/env bash
# PreToolUse / Bash hook: block hard-to-reverse operations per AGENTS.md
# § "Agent Hooks". Allows the human to override by running the command
# manually outside the agent.
#
# Input  : Claude Code hook JSON on stdin (tool_input.command).
# Output : exit 0 to allow; exit 2 + stderr to block.

set -uo pipefail

payload="$(cat || true)"
# Prefer jq for robust JSON parsing of the Claude Code hook envelope.
# The sed fallback below is best-effort: it cannot fully handle escaped
# quotes, embedded newlines, or other JSON escapes inside .tool_input.command.
# Install jq for accurate parsing — `brew install jq` / `apt install jq`.
if command -v jq >/dev/null 2>&1; then
  # Fail-closed: jq parse failure (malformed JSON, truncated input) blocks
  # rather than passing through with an empty cmd that would silently
  # bypass every dangerous-pattern check below.
  if ! cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null)"; then
    echo "[block-dangerous] ERROR: jq failed to parse hook payload — blocking." >&2
    exit 2
  fi
else
  echo "[block-dangerous] warning: jq not found; using best-effort sed fallback (escaped quotes may be mis-parsed)" >&2
  # Match the first "command":"..." value, stopping at the first unescaped
  # double quote (character class [^"]*). Escaped quotes inside the value
  # WILL truncate the match — accept that and rely on jq for correctness.
  cmd="$(printf '%s' "$payload" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi

# block() exits the script with status 2 (Claude Code's "deny" signal).
# Note: `exit 2` here terminates the entire hook process, not just the
# function — do not refactor this into a subshell ($(block ...) etc.) or
# the exit will only kill the subshell and the dangerous command will run.
block() {
  echo "[block-dangerous] Refusing: $1" >&2
  echo "[block-dangerous] Run manually outside the agent if intentional." >&2
  exit 2
}

# git push --force / --force-with-lease / -f (also when bundled, e.g. -fu/-uf)
# and force-push refspec ("+ref:ref"). Only inspect when the command actually
# contains a `git push` invocation.
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])git[[:space:]]+push([[:space:]]|$)'; then
  # Long forms: --force and --force-with-lease (with optional =value).
  if printf '%s' "$cmd" | grep -qE -- '--force(-with-lease)?($|=|[[:space:]])'; then
    block "git push --force is not allowed via the agent."
  fi
  # Short-flag bundle containing 'f' anywhere, e.g. -f, -fu, -uf, -vf.
  if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|$)'; then
    block "git push -f (force) is not allowed via the agent."
  fi
  # Refspec with leading '+' (force-push): a space followed by '+' then a
  # non-space token. Avoids matching stray pluses elsewhere in the command.
  if printf '%s' "$cmd" | grep -qE '[[:space:]]\+[^[:space:]]'; then
    block "git push with force refspec (+ref) is not allowed via the agent."
  fi
fi

# git reset --hard
case "$cmd" in
  *"git reset --hard"*|*"git reset"*" --hard"*)
    block "git reset --hard is not allowed via the agent." ;;
esac

# git commit --no-verify (bypasses pre-commit hooks). Detect both the long
# form and any short-flag bundle containing 'n' (e.g. -n, -nm, -nv, -na).
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])git[[:space:]]+commit([[:space:]]|$)'; then
  if printf '%s' "$cmd" | grep -qE -- '--no-verify($|=|[[:space:]])'; then
    block "git commit --no-verify bypasses pre-commit hooks."
  fi
  if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|$)'; then
    block "git commit -n (no-verify) bypasses pre-commit hooks."
  fi
fi

# git clean with -f (any short-flag bundle containing 'f', e.g. -f, -fd,
# -fx, -fdx and all permutations) or --force. All variants delete untracked
# files / directories without confirmation.
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])git[[:space:]]+clean([[:space:]]|$)'; then
  if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|$)'; then
    block "git clean -f (deletes untracked files) is not allowed via the agent."
  fi
  if printf '%s' "$cmd" | grep -qE -- '--force($|=|[[:space:]])'; then
    block "git clean --force is not allowed via the agent."
  fi
fi

# Working-tree discard / branch force-delete (AGENTS.md § Git Safety Protocol).
case "$cmd" in
  *"git restore ."*|*"git restore -- "*)
    block "git restore (working-tree discard) is not allowed via the agent." ;;
  *"git checkout ."*|*"git checkout -- "*)
    block "git checkout . / -- (working-tree discard) is not allowed via the agent." ;;
esac
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])git[[:space:]]+branch([[:space:]]|$)'; then
  if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])-[a-zA-Z]*D[a-zA-Z]*([[:space:]]|$)'; then
    block "git branch -D (force-delete branch) is not allowed via the agent."
  fi
  if printf '%s' "$cmd" | grep -qE -- '--delete[[:space:]]+--force|--force[[:space:]]+--delete'; then
    block "git branch --delete --force is not allowed via the agent."
  fi
fi

# npm publish (block direct invocation only — not packages whose names happen
# to contain "publish")
case "$cmd" in
  *"npm publish"*)
    block "npm publish is not allowed via the agent." ;;
esac

# rm -rf with absolute paths or parent traversal — only allow inside known
# build/output directories. Handles separated (`rm -r -f`) and long-form
# (`rm --recursive --force`) flags as well as the contiguous `rm -rf` form.
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])rm[[:space:]]'; then
  # Strip everything up to and including the first `rm` token, then iterate
  # whitespace-separated tokens — skipping any flag-like token (`-*`/`--*`)
  # so all path arguments are inspected regardless of flag layout.
  args="$(printf '%s' "$cmd" | sed -E 's/^(.*[[:space:]])?rm[[:space:]]+//')"
  has_r=false
  has_f=false
  paths=""
  for tok in $args; do
    case "$tok" in
      "") ;;
      --recursive|--recursive=*|-R|-r) has_r=true ;;
      --force|--force=*) has_f=true ;;
      --*) ;; # other long-form flag, ignore
      -*)
        # short-flag bundle — inspect chars
        case "$tok" in *[rR]*) has_r=true ;; esac
        case "$tok" in *f*)    has_f=true ;; esac
        ;;
      *) paths="$paths $tok" ;;
    esac
  done
  if [ "$has_r" = true ] && [ "$has_f" = true ]; then
    for tok in $paths; do
      case "$tok" in
        /|/*|"~"|"~/"*|"$HOME"*)
          block "rm -rf with absolute path: $tok" ;;
        *..*)
          block "rm -rf with parent traversal: $tok" ;;
        node_modules|dist|.turbo|coverage|.astro|.expo|build|out|target|.next|.nuxt|.svelte-kit|tmp|.tmp|.cache|node_modules/*|dist/*|.turbo/*|coverage/*|.astro/*|.expo/*|build/*|out/*|target/*|.next/*|.nuxt/*|.svelte-kit/*|tmp/*|.tmp/*|.cache/*)
          : ;; # safe build outputs
        *)
          # Anything else under the workspace is also blocked — too risky.
          block "rm -rf outside build directories: $tok" ;;
      esac
    done
  fi
fi

exit 0
