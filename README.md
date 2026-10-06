# pi-wt

Claude-Code-style git worktrees for [pi](https://github.com/earendil-works/pi).

- **The agent decides.** When it starts a task that changes code, it calls `enter_worktree`. When the task is done, it calls `exit_worktree`.
- **No session switching.** While a worktree is active, every built-in tool runs inside it: `read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`, and your own `!` commands. Absolute paths that point at the original checkout are redirected into the worktree too.
- **Asks on quit.** If a worktree this session created is still active when you quit, pi asks whether to keep or remove it. It warns you about uncommitted changes and unmerged commits.
- **Survives resume.** The active worktree is stored in the session, so `pi -c` and `/resume` pick it up again.

## Install

```bash
pi install git:github.com/RebliNk17/pi-wt
```

## Usage

Ask for a change as usual. The agent creates `.pi/worktrees/<name>` on a new branch `<name>`. That folder is added to `.git/info/exclude` automatically. The agent works there and exits when it is done. The status bar shows `🌿 <name>` while a worktree is active.

| What | How |
| --- | --- |
| Start pi in a fresh worktree | `pi --wt` or `pi --worktree my-feature` |
| Status | `/worktree` |
| Enter or leave by hand | `/worktree enter <name> [base]`, `/worktree exit keep\|remove` |
| List worktrees | `/worktree list` |

Tools:

- `enter_worktree({ name?, base? })` creates a worktree from `HEAD` (or from `base`). If a worktree with that name or branch already exists, it is reused.
- `exit_worktree({ action: "keep" | "remove", discard_changes? })` leaves the worktree.
  - `remove` deletes the worktree and the branch this session created.
  - It refuses to remove dirty or unmerged work unless `discard_changes` is set.
  - It never removes a worktree that this session did not create.

## Config

Settings are read from `~/.pi/agent/worktree.json`. A per-repo `<repo>/.pi/worktree.json` overrides them.

```json
{
  "root": "../{repo}-worktrees",
  "branchPrefix": "",
  "copy": [".env*"],
  "setup": "npm ci",
  "policy": "auto"
}
```

- `root`: where worktrees are created, relative to the main repo. Supports `~` and `{repo}`. The default is `.pi/worktrees`.
- `copy`: gitignore-style patterns for untracked or ignored files to copy into new worktrees. Patterns from a Claude Code style `.worktreeinclude` file are also used.
- `setup`: a shell command run in each new worktree.
- `policy`:
  - `auto` (the default): the agent uses worktrees for code changes on its own.
  - `on-request`: the agent uses worktrees only when you ask.

## Limitations

- Redirection covers pi's built-in tools. Tools from other extensions that take paths are not rewritten.
- Redirection is a convenience, not a sandbox. A bash command can still reach any path you could reach yourself.
- The keep/remove prompt appears after pi's TUI has closed, as a plain terminal prompt. It only appears when stdin is a TTY.

## License

MIT
