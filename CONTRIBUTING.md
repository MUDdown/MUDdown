# Contributing to MUDdown

Thank you for your interest in contributing! This project is licensed under
the [MIT License](LICENSE) and uses the
[Developer Certificate of Origin (DCO)](DCO) to ensure every contributor has
the right to submit their work.

## Sign Your Commits

Every commit in a pull request **must** include a `Signed-off-by` line.
This certifies that you wrote the code (or have the right to submit it)
under the project's MIT license.

Add it automatically with the `-s` flag:

```bash
git commit -s -m "fix: correct Microsoft scope for Graph API"
```

This produces a commit message like:

```
fix: correct Microsoft scope for Graph API

Signed-off-by: Your Name <your.email@example.com>
```

A GitHub Actions check enforces this on all pull requests to `main`.

### Fixing Unsigned Commits

If the DCO check fails, amend your most recent commit:

```bash
git commit --amend -s --no-edit
git push --force-with-lease
```

For multiple unsigned commits, use an interactive rebase:

```bash
git rebase -i HEAD~N   # N = number of commits to fix
# Mark each commit as "edit", then for each:
git commit --amend -s --no-edit
git rebase --continue
```

## Development Setup

```bash
npm install
npx turbo run build
npx turbo run test
```

See [AGENTS.md](AGENTS.md) for architecture details, coding conventions,
and build commands.

## Community

Join the [MUDdown Discord](https://discord.gg/mDFcMT3egK) to ask questions,
discuss ideas, or coordinate contributions.
