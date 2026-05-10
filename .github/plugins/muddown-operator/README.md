# MUDdown Operator

A Claude Code plugin that bundles the agent skills needed to operate a MUDdown server: the telnet bridge with OSC 8 hyperlink support, the Discord-as-client bridge, and OAuth/OIDC identity provider integration.

This plugin is intended for **ops-focused contributors** running a MUDdown server who want the same operational guidance the reference deployment uses.

## What's inside

| Skill | Purpose |
|-------|---------|
| `/muddown-operator:osc8-bridge` | Add or modify OSC 8 hyperlink capabilities in the telnet bridge — NEW-ENVIRON negotiation, Mudlet `send:`/`prompt:` URIs, tooltip/menu metadata, word-wrap envelope invariant |
| `/muddown-operator:discord-bridge` | Work on the Discord-as-client bridge — renderer invariants, button `custom_id` encoding, no-auto-message rule, multi-character picker flow, public `/feed` subscriber |
| `/muddown-operator:oauth-provider` | Add a new OAuth/OIDC identity provider (shared types, auth switches, server config, login button, env vars, tests) |

The skill files are symlinks to `.github/skills/<name>/` so the source of truth stays with the canonical MUDdown repo.

## Local testing

From a checkout of `MUDdown/MUDdown`:

```bash
claude --plugin-dir .github/plugins/muddown-operator
```

After Claude Code starts, run `/help` and confirm all three skills appear under the `muddown-operator` namespace. Restart Claude Code to pick up edits.

## Distribution

Until a marketplace entry exists, install directly from a clone of this repo:

```bash
git clone https://github.com/MUDdown/MUDdown.git
claude --plugin-dir MUDdown/.github/plugins/muddown-operator
```

## Compatibility

These skills assume the MUDdown package layout (`packages/bridge/`, `packages/server/src/auth.ts`, `packages/shared/src/index.ts`). Forks that diverge from this layout will need to adapt the skill instructions accordingly.

## License

MIT — see [LICENSE](https://github.com/MUDdown/MUDdown/blob/main/LICENSE).
