# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased

- `/worktree list [filter]` opens an interactive, colored picker. Each worktree gets one verdict about whether it can be deleted:
  - 🗑 done: merged, PR closed, or remote branch deleted, with no local changes.
  - ○ empty: no commits of its own.
  - ● in progress: pushed but not finished.
  - ⚠ unsaved work: uncommitted changes, unpushed commits, or never pushed.

  Each row gives the reason for its verdict, plus the PR number and status (a clickable link), the age of the last commit, the PR title or branch description, and the path. You can type to filter, press tab to switch views, press space or ctrl+a to select, and press enter to remove worktrees (with or without their branches).
- PR status comes from the GitHub CLI (`gh`), one GraphQL request for all branches. This catches squash merges that git alone cannot see. If `gh` is missing or not logged in, it is skipped silently.
- `/worktree clean` opens the picker on finished worktrees with all of them pre-selected.
- In pi-gui and RPC clients, which can show dialogs but not terminal components, `/worktree list` is a dialog browser instead. The worktrees are buttons with a verdict, reason and age, done ones first, and the first button removes all done worktrees. Picking a worktree offers to remove it (with or without its branch) or open its PR. Print/JSON mode gets a plain-text list.
- The list is faster. The picker opens right away, then fills in change counts and PR status.
- The default `root` is now `.worktrees` instead of `.pi/worktrees`.
- `/worktree` with no active worktree, and `/worktree enter` with no name, open a switcher. Pick an existing worktree to enter it, or create a new one (`ctrl+n`, or type a name that matches nothing). It works in the terminal and as a dialog in pi-gui. Entering from the command now reports one short line: `🌿 Switched to … · <path>`.
- `/worktree enter <tab>` completes existing worktree branches.
- `scripts/demo.sh` builds a throwaway repo with one worktree in each state, for screenshots and manual testing.

## 0.1.1

- Published as `@reblink17/pi-wt` (install with `pi install npm:@reblink17/pi-wt`).
- README: badges, development section.
- CI, trusted npm publishing with provenance, Biome lint, and contributor docs.

## 0.1.0

- First release: `enter_worktree` / `exit_worktree` tools, transparent tool redirection, `pi --wt`, `/worktree` command, keep/remove picker on quit, session resume, `worktree.json` config, `pi-wt:changed` event.
