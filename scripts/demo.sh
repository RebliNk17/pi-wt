#!/usr/bin/env bash
# Build a throwaway repo with one worktree in every state `/worktree list` knows,
# for screenshots and manual testing. Uses a local bare "origin", so no network.
#
#   scripts/demo.sh [dir]        # default: ~/git/acme-app
#   cd ~/git/acme-app && pi      # then: /worktree list
set -euo pipefail

dir="${1:-$HOME/git/acme-app}"
origin="$dir-origin.git"
if [[ -e "$dir" || -e "$origin" ]]; then
	echo "refusing: $dir or $origin already exists (delete them first)" >&2
	exit 1
fi

now=$(date +%s)
# commit <dir> <hours-ago> <message> [file]
commit() {
	local at=$((now - $2 * 3600)) file="${4:-}"
	if [[ -n "$file" ]]; then
		mkdir -p "$1/$(dirname "$file")"
		echo "$3" >>"$1/$file"
		git -C "$1" add "$file"
	fi
	GIT_AUTHOR_DATE="@$at +0000" GIT_COMMITTER_DATE="@$at +0000" \
		git -C "$1" commit -q --allow-empty -m "$3"
}
wt() { git -C "$dir" worktree add -q -b "$1" "$dir/.worktrees/${1//\//-}" "${2:-main}"; }
path() { echo "$dir/.worktrees/${1//\//-}"; }

git init -q --bare -b main "$origin"
git clone -q "$origin" "$dir" 2>/dev/null
git -C "$dir" config user.name "Demo"
git -C "$dir" config user.email "demo@example.com"
echo "/.worktrees/" >>"$dir/.git/info/exclude"
commit "$dir" 2000 "Initial commit" README.md
commit "$dir" 900 "Add checkout service" src/checkout.ts
git -C "$dir" push -q -u origin main
git -C "$dir" remote set-head origin main

# 🗑 done: merged into origin/main
wt fix/login-timeout
commit "$(path fix/login-timeout)" 500 "Fix session timeout on the login page" src/login.ts
git -C "$(path fix/login-timeout)" push -q -u origin fix/login-timeout
git -C "$dir" merge -q --no-ff fix/login-timeout -m "Merge fix/login-timeout"
git -C "$dir" push -q origin main

# 🗑 done: remote branch deleted (squash-merged on the server)
wt chore/upgrade-deps
commit "$(path chore/upgrade-deps)" 300 "Upgrade dependencies to latest minor" package.json
git -C "$(path chore/upgrade-deps)" push -q -u origin chore/upgrade-deps
git -C "$dir" push -q origin --delete chore/upgrade-deps
git -C "$dir" fetch -q --prune

# ● in progress: pushed, nothing local only; has a branch description
wt feat/checkout-redesign
commit "$(path feat/checkout-redesign)" 30 "New checkout layout behind a flag" src/checkout.ts
git -C "$(path feat/checkout-redesign)" push -q -u origin feat/checkout-redesign
git -C "$dir" config branch.feat/checkout-redesign.description "Redesigned checkout, waiting on design review"

# ⚠ unsaved: uncommitted changes
wt feat/dark-mode
commit "$(path feat/dark-mode)" 5 "Add dark theme tokens" src/theme.ts
git -C "$(path feat/dark-mode)" push -q -u origin feat/dark-mode
echo "// wip" >>"$(path feat/dark-mode)/src/theme.ts"
echo "body { background: #111 }" >"$(path feat/dark-mode)/dark.css"

# ⚠ unsaved: commits that were never pushed
wt spike/graphql-api
commit "$(path spike/graphql-api)" 70 "Try a GraphQL schema for orders" src/schema.graphql

# ⚠ unsaved: pushed, plus local commits not pushed yet
wt feat/search
commit "$(path feat/search)" 48 "Add search endpoint" src/search.ts
git -C "$(path feat/search)" push -q -u origin feat/search
commit "$(path feat/search)" 2 "Rank results by recency" src/search.ts

# ○ empty: just created, no commits of its own
wt docs/api-guide

echo "Demo repo ready: $dir"
echo "  cd $dir && pi    # then /worktree list"
echo "Clean up: rm -rf '$dir' '$origin'"
