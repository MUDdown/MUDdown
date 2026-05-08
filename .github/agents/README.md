# Agent Subagents

Specialized read-only sub-assistants that handle focused tasks (validation, mapping, auditing) in their own context window so the main conversation stays uncluttered. See the [Claude Code subagent docs](https://code.claude.com/docs/en/sub-agents) for the loading model and frontmatter spec.

Canonical location: `.github/agents/`. Per-agent symlinks (e.g. `.claude/agents/`) point here so a single source of truth is shared across all agent integrations.

> Not to be confused with the **agent hooks** in [`.github/hooks/`](../hooks/) (deterministic tool-use guards) or the **game-engine hooks** in [`packages/server/src/hooks.ts`](../../packages/server/src/hooks.ts) (NPC/item/room event handlers).

## Agents

| File | Purpose | Tools | Model | When to delegate |
|------|---------|-------|-------|------------------|
| `world-validator.md` | Audit `packages/server/world/` for bidirectional-exit violations, frontmatter ↔ container-id mismatches, dangling item/NPC references, recipe references, orphaned files | `Read, Grep, Glob, Bash` | `haiku` | After any change under `packages/server/world/**`, or before a PR that touches rooms/items/NPCs/recipes |
| `spec-compliance.md` | Verify server output and protocol code stay conformant with `packages/spec/SPECIFICATION.md` (envelope shape, container blocks, link schemes, ARIA mapping) | `Read, Grep, Glob, Bash` | `sonnet` | When changing wire-protocol envelopes, container blocks, link schemes, or anywhere server output is generated |
| `wiki-sync.md` | Map a code diff to the wiki pages under `MUDdown.wiki/` that need updates, per the rules in [`AGENTS.md` § Maintaining the Wiki](../../AGENTS.md#maintaining-the-wiki) | `Read, Grep, Glob, Bash` | `haiku` | After shipping a feature, command, world content, or protocol change |

All three are **read-only**: they audit, map, and report. They never edit files in this repo or the sibling wiki repo.

## Conventions

- **Frontmatter required fields:** `name` (lowercase-kebab, must match the filename) and `description` (Claude uses this to decide when to delegate — write it to encourage proactive use).
- **Tools allowlist** (`tools:` in frontmatter) — restrict to the minimum needed. For our auditors, that means `Read, Grep, Glob` plus optionally `Bash` for `git diff`/`vitest`. Subagents inherit all tools by default if `tools` is omitted, which we explicitly avoid.
- **Body is the system prompt.** Subagents do **not** inherit Claude Code's default system prompt or the project `AGENTS.md`. Each subagent's body must be self-contained: include the workflow, mapping rules, output format, and guardrails inline.
- **Output format spec.** Every agent ends with a fenced template for the report it returns. This is what flows back into the main conversation; keep it concise.
- **Model selection.** Use `haiku` for structured mapping/validation work (cheaper, fast). Use `sonnet` when nuanced reading of prose specs is required. `inherit` is the alternative if you want the subagent to follow the parent session.
- **Loaded at session start** (as of this writing — depends on the agent runtime's loading model). For Claude Code, restart the session after adding or editing a subagent file on disk.

## Adding a new subagent

1. Create `.github/agents/<name>.md` (lowercase-kebab) with YAML frontmatter (`name`, `description`, `tools`, `model`, optional `color`) and a Markdown body containing the system prompt, workflow, and output template.
2. Create a per-file symlink at `.claude/agents/<name>.md` pointing to `../../.github/agents/<name>.md` (matches the skill / hook conventions; see [`AGENTS.md` § Customization File Layout](../../AGENTS.md#customization-file-layout)).
3. Document it in the table above.
4. Add a row to the Customization File Layout table in [`AGENTS.md`](../../AGENTS.md) and a brief entry in the "Agent Subagents" section.
5. Update [`PROJECT_PLAN.md`](../../PROJECT_PLAN.md) "Agent Development Kit Adoption" section if relevant.
6. Restart your Claude Code session so the agent is loaded.

## Invoking

- **Automatic delegation:** Claude reads each agent's `description` at session start and delegates when a task matches. Phrasing the description with "Use proactively when …" encourages auto-delegation.
- **Explicit:** ask the main thread "use the world-validator subagent to …" or `@world-validator`.
- **Session-wide:** `claude --agent world-validator` runs the whole session under that agent's system prompt and tool restrictions.

Subagents cannot spawn other subagents. If a workflow needs nested delegation, chain them from the main thread.
