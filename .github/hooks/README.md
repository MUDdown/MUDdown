# Agent Hooks

Tool-use hooks that enforce rules from [`AGENTS.md`](../../AGENTS.md) deterministically rather than relying on the agent reading and remembering them.

Canonical location: `.github/hooks/`. Per-agent symlinks (e.g. `.claude/hooks/`) point here so a single source of truth is shared across all agent integrations.

> Not to be confused with the **game-engine hooks** in [`packages/server/src/hooks.ts`](../../packages/server/src/hooks.ts), which are NPC/item/room event handlers.

## Hooks

| Script | Event | Matcher | Behavior |
|--------|-------|---------|----------|
| `check-dco.sh` | `PreToolUse` | `Bash` | Blocks `git commit` without `Signed-off-by:` and rejects AI-attribution trailers (`Co-Authored-By: Claude\|Copilot\|ChatGPT`, "Generated with Claude Code", etc.) |
| `block-dangerous.sh` | `PreToolUse` | `Bash` | Blocks `git push --force`, `git reset --hard`, `git commit --no-verify`, `git clean -fdx`, `npm publish`, and `rm -rf` outside build directories |
| `validate-world.sh` | `PostToolUse` | `Write\|Edit` | When a file under `packages/server/world/**` is touched, runs `vitest world-integrity.test.ts` and surfaces failures |

Wired up for Claude Code via [`.claude/settings.json`](../../.claude/settings.json), which references the canonical `.github/hooks/*.sh` paths.

## Conventions

- POSIX `bash`, no Node/Python deps.
- `jq` is used when present; falls back to a `sed` extractor.
- Exit `0` to allow, exit `2` with stderr to **block** the tool call (Claude Code surfaces stderr to the agent).
- `exit 1` is "informational failure" — the call already happened (PostToolUse), the agent just sees the message.
- Scripts must be executable (`chmod +x`).

## Adding a new hook

1. Drop a `*.sh` script in `.github/hooks/` and `chmod +x`.
2. Create a per-file symlink at `.claude/hooks/<script>.sh` pointing to `../../.github/hooks/<script>.sh` (matches the skill convention; see [`AGENTS.md` § Customization File Layout](../../AGENTS.md#customization-file-layout)).
3. Reference it from `.claude/settings.json` under the appropriate event using the canonical `.github/hooks/` path.
4. Document it in the table above.
5. Update [`PROJECT_PLAN.md`](../../PROJECT_PLAN.md) "Agent Development Kit Adoption" section.
