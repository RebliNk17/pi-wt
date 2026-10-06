# Contributing

Thanks for helping improve pi-wt!

## Setup

```bash
git clone https://github.com/RebliNk17/pi-wt
cd pi-wt
npm ci
npm run check          # lint + typecheck + tests
pi -e ./extensions/worktree/index.ts   # try your changes in pi
```

Node 22.19+ is required (same as pi).

## Layout

| File | Purpose |
| --- | --- |
| `extensions/worktree/index.ts` | Extension entry: tools, redirection, lifecycle, `/worktree` |
| `extensions/worktree/paths.ts` | Pure path mapping helpers (unit tested) |
| `extensions/worktree/git.ts` | `git` wrappers, no shell |
| `extensions/worktree/config.ts` | `worktree.json` / `.worktreeinclude` loading |
| `extensions/worktree/prompt.ts` | Terminal picker shown on quit |

## Pull requests

- Keep changes focused; open an issue first for larger features.
- Add or update tests for behavior changes (`test/`).
- Run `npm run format` before committing.
- Add a line to `CHANGELOG.md` under "Unreleased".

## Releasing (maintainers)

1. Move "Unreleased" entries in `CHANGELOG.md` under the new version.
2. `npm version patch|minor|major && git push --follow-tags`
3. The `Publish` workflow tests the tag and publishes to npm with provenance.
4. Create the GitHub release: `gh release create vX.Y.Z --generate-notes`
