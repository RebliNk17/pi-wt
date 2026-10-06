import assert from "node:assert/strict";
import { test } from "node:test";
import { mapPath, resolveRoot, rewriteCommand, slugify } from "../extensions/worktree/paths.ts";

const m = {
	repoRoot: "/r/app",
	worktree: "/r/app/.pi/worktrees/x",
	cwd: "/r/app/.pi/worktrees/x/src",
	excluded: ["/r/app/.pi/worktrees"],
};

test("mapPath", () => {
	assert.equal(mapPath("a.ts", m), "/r/app/.pi/worktrees/x/src/a.ts");
	assert.equal(mapPath("../b", m), "/r/app/.pi/worktrees/x/b");
	assert.equal(mapPath("/r/app/src/a.ts", m), "/r/app/.pi/worktrees/x/src/a.ts");
	assert.equal(mapPath("/r/app", m), "/r/app/.pi/worktrees/x");
	assert.equal(mapPath("/r/app/.pi/worktrees/x/z", m), "/r/app/.pi/worktrees/x/z");
	assert.equal(mapPath("/r/app/.pi/worktrees/other/z", m), "/r/app/.pi/worktrees/other/z");
	assert.equal(mapPath("/r/application/z", m), "/r/application/z");
	assert.equal(mapPath("/etc/hosts", m), "/etc/hosts");
	assert.equal(mapPath("@/r/app/a", m), "/r/app/.pi/worktrees/x/a");
});

test("rewriteCommand", () => {
	assert.equal(
		rewriteCommand("cat /r/app/a.ts && ls '/r/app/b'", m),
		"cat /r/app/.pi/worktrees/x/a.ts && ls '/r/app/.pi/worktrees/x/b'",
	);
	assert.equal(rewriteCommand("cd /r/app; ls /r/application", m), "cd /r/app/.pi/worktrees/x; ls /r/application");
});

test("resolveRoot / slugify", () => {
	assert.equal(resolveRoot(".pi/worktrees", "/r/app"), "/r/app/.pi/worktrees");
	assert.equal(resolveRoot("../{repo}-worktrees", "/r/app"), "/r/app-worktrees");
	assert.equal(slugify(" Fix login bug! "), "Fix-login-bug");
	assert.equal(slugify("ALTM-1/x y"), "ALTM-1/x-y");
});
