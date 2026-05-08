# MUDdown Claude Code Plugins

This directory holds Claude Code plugins that the MUDdown project ships for third-party use. Each plugin bundles a set of agent skills (and optionally hooks, agents, MCP servers) so external MUDdown servers can install a workflow without forking the reference repo.

| Plugin | Audience | Skills |
|--------|----------|--------|
| [`muddown-content-authoring/`](muddown-content-authoring/) | Content authors on a MUDdown fork | `room-creation`, `item-creation`, `npc-creation`, `muddown-format` |
| [`muddown-operator/`](muddown-operator/) | Server operators | `osc8-bridge`, `oauth-provider` |

## Layout

Each plugin follows the [Claude Code plugin spec](https://code.claude.com/docs/en/plugins-reference#plugin-directory-structure):

```
<plugin-name>/
├── .claude-plugin/
│   └── plugin.json     # name, description, version, author, license
├── README.md           # install + usage
└── skills/
    └── <skill>/        # directory symlink → ../../../skills/<skill>
        └── SKILL.md
```

The `skills/<name>/` entries are **directory-level symlinks** into `.github/skills/<name>/` (the canonical home for all MUDdown skills). This keeps a single source of truth: editing `.github/skills/room-creation/SKILL.md` updates both the in-repo workflow and any plugin shipping that skill.

> Symlinks vs per-file: the `.claude/skills/<name>/SKILL.md` symlinks (used by Claude Code on the main repo) are per-file so each agent can drop extras alongside. The plugin layout symlinks the whole skill directory because plugins distribute the skill as a single unit.

## Adding a new plugin

1. `mkdir -p .github/plugins/<plugin-name>/{.claude-plugin,skills}`
2. Write `.claude-plugin/plugin.json` (`name`, `description`, `version`, `author`, `license`).
3. Symlink each skill directory: `cd skills && ln -s ../../../skills/<skill> <skill>`.
4. Write a `README.md` documenting audience, skill table, local-testing command, and any layout assumptions.
5. Add a row to the table above and to the **Plugins** section of [AGENTS.md](../../AGENTS.md), and verify the **Customization File Layout** table in AGENTS.md still accurately reflects the plugin structure.

## Local testing

```bash
claude --plugin-dir .github/plugins/<plugin-name>
```

Run `/help` inside Claude Code to confirm the namespaced skills appear (`/<plugin-name>:<skill>`). Restart Claude Code to pick up edits.
