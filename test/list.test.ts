import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { dialogList } from "../extensions/worktree/dialogs.ts";
import { parseRemote } from "../extensions/worktree/github.ts";
import {
	assess,
	collect,
	fillChanges,
	formatList,
	isDone,
	type Row,
	relativeTime,
	removeRows,
	tildify,
} from "../extensions/worktree/list.ts";

test("parseRemote", () => {
	const gh = { host: "github.com", owner: "o", name: "r" };
	assert.deepEqual(parseRemote("git@github.com:o/r.git"), gh);
	assert.deepEqual(parseRemote("https://github.com/o/r"), gh);
	assert.deepEqual(parseRemote("https://x-token@github.com/o/r.git"), gh);
	assert.deepEqual(parseRemote("ssh://git@github.com:22/o/r.git"), gh);
	assert.equal(parseRemote("git@gitlab.com:o/r.git"), undefined);
});

test("assess", () => {
	const base: Row = {
		path: "/w",
		branch: "b",
		tip: "t1",
		main: false,
		here: false,
		active: false,
		locked: false,
		missing: false,
		ahead: 0,
		behind: 0,
		gone: false,
		merged: false,
		empty: false,
		changes: 0,
		upstream: "origin/b",
	};
	const pr = (state: "OPEN" | "DRAFT" | "MERGED" | "CLOSED") => ({
		number: 7,
		state,
		title: "t",
		url: "u",
		headOid: "t1",
	});
	const v = (o: Partial<Row>) => assess({ ...base, ...o }, "origin/main");
	assert.deepEqual(v({}), { verdict: "progress", reasons: ["pushed, no PR"] });
	assert.equal(v({ changes: undefined }).verdict, "pending");
	assert.deepEqual(v({ pr: pr("MERGED") }), { verdict: "done", reasons: ["PR #7 merged"] });
	assert.equal(v({ pr: pr("CLOSED") }).verdict, "done");
	assert.deepEqual(v({ pr: pr("DRAFT") }).reasons, ["draft PR #7 open"]);
	assert.equal(v({ gone: true }).verdict, "done");
	assert.deepEqual(v({ merged: true }).reasons, ["merged into origin/main"]);
	assert.equal(v({ empty: true, upstream: undefined }).verdict, "empty");
	assert.deepEqual(v({ changes: 2, pr: pr("MERGED") }), { verdict: "unsaved", reasons: ["2 uncommitted changes"] });
	assert.deepEqual(v({ ahead: 1 }).reasons, ["1 unpushed commit"]);
	assert.deepEqual(v({ upstream: undefined }).reasons, ["commits never pushed"]);
	assert.deepEqual(v({ gone: true, afterPr: true, pr: pr("MERGED") }).reasons, ["local commits differ from PR #7"]);
	assert.deepEqual(v({ afterPr: true, pr: pr("MERGED") }), {
		verdict: "progress",
		reasons: ["branch differs from PR #7"],
	});
	assert.equal(v({ missing: true, changes: undefined }).verdict, "done");
	assert.ok(!isDone({ ...base, here: true, merged: true }));
});

test("relativeTime and tildify", () => {
	const now = 1_000_000_000_000;
	assert.equal(relativeTime(now / 1000 - 30, now), "just now");
	assert.equal(relativeTime(now / 1000 - 3 * 3600, now), "3h ago");
	assert.equal(relativeTime(now / 1000 - 10 * 86400, now), "1w ago");
	assert.equal(tildify("/h/u/x", "/h/u"), "~/x");
	assert.equal(tildify("/h/user2", "/h/u"), "/h/user2");
});

async function fixture() {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piwt-list-")));
	const origin = path.join(tmp, "origin.git");
	const repo = path.join(tmp, "app");
	const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf-8" }).trim();
	g(tmp, "init", "-q", "--bare", "-b", "main", origin);
	g(tmp, "clone", "-q", origin, repo);
	g(repo, "config", "user.email", "t@t");
	g(repo, "config", "user.name", "t");
	g(repo, "commit", "-q", "--allow-empty", "-m", "init");
	g(repo, "push", "-q", "-u", "origin", "main");
	g(repo, "remote", "set-head", "origin", "main");

	const wt = (name: string) => path.join(repo, ".worktrees", name);
	const add = (name: string) => g(repo, "worktree", "add", "-q", "-b", name, wt(name));
	// merged: pushed, then merged into main
	add("merged");
	g(wt("merged"), "commit", "-q", "--allow-empty", "-m", "merged work");
	g(wt("merged"), "push", "-q", "-u", "origin", "merged");
	g(repo, "merge", "-q", "--ff-only", "merged");
	g(repo, "push", "-q", "origin", "main");
	// gone: pushed, remote branch deleted (squash-merge style)
	add("gone");
	g(wt("gone"), "commit", "-q", "--allow-empty", "-m", "gone work");
	g(wt("gone"), "push", "-q", "-u", "origin", "gone");
	g(repo, "push", "-q", "origin", "--delete", "gone");
	g(repo, "fetch", "-q", "--prune");
	// dirty and gone: must not be auto-cleaned
	add("dirty");
	g(wt("dirty"), "commit", "-q", "--allow-empty", "-m", "dirty work");
	g(wt("dirty"), "push", "-q", "-u", "origin", "dirty");
	g(repo, "push", "-q", "origin", "--delete", "dirty");
	g(repo, "fetch", "-q", "--prune");
	fs.writeFileSync(path.join(wt("dirty"), "x.txt"), "x");
	// fresh: just created, nothing of its own
	add("fresh");
	g(repo, "config", "branch.fresh.description", "Try the new thing");
	// wip: local commits, never pushed
	add("wip");
	g(wt("wip"), "commit", "-q", "--allow-empty", "-m", "wip work");
	// missing: folder deleted by hand
	add("missing");
	fs.rmSync(wt("missing"), { recursive: true });

	return { tmp, repo, g };
}

test("collect, classify, clean", async () => {
	const { tmp, repo, g } = await fixture();
	const l = await collect(repo, repo);
	const by = (b: string) => l.rows.find((r) => r.branch === b)!;
	assert.equal(l.base, "origin/main");
	assert.equal(l.rows[0]!.branch, "main");
	assert.ok(l.rows[0]!.main && l.rows[0]!.here);
	assert.ok(by("merged").merged);
	assert.ok(by("gone").gone && !by("gone").merged);
	assert.ok(by("fresh").empty && !by("fresh").merged);
	assert.equal(by("fresh").description, "Try the new thing");
	assert.ok(!by("wip").merged && !by("wip").gone && !by("wip").upstream);
	assert.ok(by("missing").missing);
	assert.equal(by("wip").subject, "wip work");

	await fillChanges(l.rows);
	assert.equal(by("dirty").changes, 1);
	assert.equal(by("merged").changes, 0);
	assert.deepEqual(
		l.rows
			.filter(isDone)
			.map((r) => r.branch)
			.sort(),
		["gone", "merged", "missing"],
	);
	assert.equal(assess(by("dirty")).verdict, "unsaved");
	assert.equal(assess(by("wip")).verdict, "unsaved");
	assert.equal(assess(by("fresh")).verdict, "empty");
	assert.match(formatList(l), /7 worktrees of .* · 3 done/);

	const res = await removeRows(l.rows.filter(isDone), repo, { deleteBranches: true, force: false });
	assert.ok(
		res.every((r) => r.ok),
		JSON.stringify(res.map((r) => r.message)),
	);
	const left = g(repo, "worktree", "list", "--porcelain");
	assert.doesNotMatch(left, /merged|\/gone|missing/);
	assert.match(left, /dirty/);
	assert.equal(g(repo, "branch", "--list", "merged", "gone", "missing"), "");
	assert.match(g(repo, "branch", "--list", "dirty", "fresh", "wip"), /dirty[\s\S]*fresh[\s\S]*wip/);
	fs.rmSync(tmp, { recursive: true, force: true });
});

test("dialog fallback (pi-gui)", async () => {
	const { tmp, repo, g } = await fixture();
	// Dialog fallback (pi-gui): single-line options, done first, then "Remove all done".
	const seen: { title: string; options: string[] }[] = [];
	const answers = ["🗑 Remove all", "Remove worktrees and their branches", "Close"];
	const notes: string[] = [];
	const ui = {
		select: async (title: string, options: string[]) => {
			seen.push({ title, options });
			const a = answers.shift();
			return options.find((o) => a && o.startsWith(a));
		},
		notify: (m: string) => notes.push(m),
		confirm: async () => false,
	};
	const copy = await collect(repo, repo);
	await Promise.all([fillChanges(copy.rows)]);
	await dialogList({ ui } as any, copy);
	assert.match(seen[0]!.title, /^🌿 7 worktrees · 3 done · 1 empty · 3 with unsaved work$/);
	assert.ok(seen[0]!.options.every((o) => !o.includes("\n")));
	assert.equal(seen[0]!.options[0], "🗑 Remove all 3 done worktrees");
	assert.match(seen[0]!.options[1]!, /^⌂ main/);
	assert.match(notes.at(-1)!, /Removed 3 worktrees and their branches/);
	assert.equal(copy.rows.length, 4);
	assert.ok(!seen[2]!.options.some((o) => o.startsWith("🗑 Remove all")));
	const left0 = g(repo, "worktree", "list", "--porcelain");
	assert.doesNotMatch(left0, /merged|\/gone|missing/);
	assert.equal(g(repo, "branch", "--list", "merged", "gone", "missing"), "");
	fs.rmSync(tmp, { recursive: true, force: true });
});
