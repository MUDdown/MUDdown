# MUDdown Content Authoring

A Claude Code plugin that bundles the agent skills needed to author MUDdown game content: rooms, items, NPCs, and MUDdown markup.

This plugin is intended for **third-party MUDdown servers** that want to adopt the same authoring workflow used by the reference implementation without forking the main repo.

## What's inside

| Skill | Purpose |
|-------|---------|
| `/muddown-content-authoring:room-creation` | Create MUDdown room files (frontmatter, exits, sections) |
| `/muddown-content-authoring:item-creation` | Create item definition JSON files (equippable, usable, fixed, recipes) |
| `/muddown-content-authoring:npc-creation` | Create NPC definitions with dialogue trees |
| `/muddown-content-authoring:muddown-format` | MUDdown markup format (container blocks, link schemes, wire protocol) |

The skill files are symlinks to `.github/skills/<name>/` so the source of truth stays with the canonical MUDdown repo.

## Local testing

From a checkout of `MUDdown/MUDdown`:

```bash
claude --plugin-dir .github/plugins/muddown-content-authoring
```

After Claude Code starts, run `/help` and confirm the four skills appear under the `muddown-content-authoring` namespace. Restart Claude Code to pick up edits.

## Distribution

Until a marketplace entry exists, install directly from a clone of this repo:

```bash
git clone https://github.com/MUDdown/MUDdown.git
claude --plugin-dir MUDdown/.github/plugins/muddown-content-authoring
```

## Compatibility

The skills assume the MUDdown directory layout (`packages/server/world/<region>/`, `packages/server/world/items/`, `packages/server/world/npcs/`). Forks that keep this layout can use the plugin unchanged; servers with different layouts should fork the skills and adjust the paths.

## License

MIT — see [LICENSE](https://github.com/MUDdown/MUDdown/blob/main/LICENSE).
