import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import piWorktree from "../extensions/worktree/index.ts";

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "piwt-agent-"));

function setup() {
	const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piwt-")));
	const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8" }).trim();
	g("init", "-q", "-b", "main");
	g("config", "user.email", "t@t");
	g("config", "user.name", "t");
	fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
	fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n");
	fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
	fs.writeFileSync(path.join(repo, ".worktreeinclude"), ".env\n");
	g("add", ".");
	g("commit", "-qm", "init");

	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const entries: any[] = [];
	const statuses = new Map<string, string | undefined>();
	const notes: string[] = [];
	const answers: ((options: string[]) => string | undefined)[] = [];
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (n: string, c: any) => commands.set(n, c),
		registerFlag() {},
		events: { emit() {}, on: () => () => {} },
		getFlag: () => undefined,
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		on: (ev: string, h: any) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
	};
	const ctx: any = {
		cwd: repo,
		mode: "rpc",
		hasUI: true,
		ui: {
			setStatus: (k: string, v?: string) => statuses.set(k, v),
			notify: (m: string) => notes.push(m),
			select: async (_t: string, o: string[]) => answers.shift()?.(o),
			input: async () => answers.shift()?.([]),
			custom: async () => {
				throw new Error("no custom components in tests");
			},
			theme: { fg: (_: string, s: string) => s },
		},
		sessionManager: { getBranch: () => entries },
	};
	piWorktree(pi);
	const emit = async (ev: string, e: any) => {
		for (const h of handlers.get(ev) ?? []) await h(e, ctx);
	};
	return { repo, g, tools, commands, emit, ctx, statuses, entries, notes, answers };
}

test("enter, redirect, exit remove", async () => {
	const { repo, g, tools, emit, ctx, statuses } = setup();
	await emit("session_start", { reason: "startup" });

	const res = await tools.get("enter_worktree").execute("1", { name: "feat x" }, undefined, undefined, ctx);
	const wt = res.details.worktree;
	assert.equal(wt.path, path.join(repo, ".worktrees/feat-x"));
	assert.equal(wt.branch, "feat-x");
	assert.equal(fs.readFileSync(path.join(wt.path, ".env"), "utf-8"), "SECRET=1\n");
	assert.equal(statuses.get("worktree"), "🌿 feat-x");
	assert.match(fs.readFileSync(path.join(repo, ".git/info/exclude"), "utf-8"), /\/\.worktrees\//);
	assert.equal(g("status", "--porcelain"), "");

	const read = { toolName: "read", input: { path: path.join(repo, "a.txt") } };
	await emit("tool_call", read);
	assert.equal(read.input.path, path.join(wt.path, "a.txt"));
	const rel = { toolName: "write", input: { path: "b.txt" } };
	await emit("tool_call", rel);
	assert.equal(rel.input.path, path.join(wt.path, "b.txt"));
	const grep = { toolName: "grep", input: {} as any };
	await emit("tool_call", grep);
	assert.equal(grep.input.path, wt.path);
	const bash = { toolName: "bash", input: { command: `cat ${repo}/a.txt` } };
	await emit("tool_call", bash);
	assert.equal(execFileSync("bash", ["-c", `${bash.input.command}; pwd -P`], { encoding: "utf-8" }), `a\n${wt.path}\n`);

	const prompt = { systemPromptOptions: { sections: {} as Record<string, string>, cwd: repo } };
	await emit("before_agent_start", prompt);
	assert.equal(prompt.systemPromptOptions.cwd, wt.path);
	assert.match(prompt.systemPromptOptions.sections.worktree!, /inside git worktree/);

	fs.writeFileSync(path.join(wt.path, "b.txt"), "b\n");
	await assert.rejects(
		tools.get("exit_worktree").execute("2", { action: "remove" }, undefined, undefined, ctx),
		/uncommitted/,
	);
	await assert.rejects(
		tools.get("enter_worktree").execute("3", { name: "y" }, undefined, undefined, ctx),
		/Already in worktree/,
	);
	const out = await tools
		.get("exit_worktree")
		.execute("4", { action: "remove", discard_changes: true }, undefined, undefined, ctx);
	assert.match(out.content[0].text, /Removed worktree .* and branch feat-x/);
	assert.ok(!fs.existsSync(wt.path));
	assert.equal(g("branch", "--list", "feat-x"), "");

	const after = { toolName: "read", input: { path: "a.txt" } };
	await emit("tool_call", after);
	assert.equal(after.input.path, "a.txt");
});

test("keep, resume restores, reuse existing", async () => {
	const { repo, tools, emit, ctx, statuses } = setup();
	await emit("session_start", { reason: "startup" });
	const { details } = await tools.get("enter_worktree").execute("1", { name: "keepme" }, undefined, undefined, ctx);

	await emit("session_start", { reason: "resume" });
	assert.equal(statuses.get("worktree"), "🌿 keepme");

	await tools.get("exit_worktree").execute("2", { action: "keep" }, undefined, undefined, ctx);
	assert.ok(fs.existsSync(details.worktree.path));
	assert.equal(statuses.get("worktree"), undefined);

	const again = await tools.get("enter_worktree").execute("3", { name: "keepme" }, undefined, undefined, ctx);
	assert.match(again.content[0].text, /Reusing existing worktree/);
	assert.equal(again.details.worktree.created, false);
	await assert.rejects(
		tools.get("exit_worktree").execute("4", { action: "remove" }, undefined, undefined, ctx),
		/not created by this session/,
	);
	fs.rmSync(repo, { recursive: true, force: true });
});

test("/worktree with nothing active: pick one to enter, or create one", async () => {
	const { repo, g, commands, emit, ctx, statuses, notes, answers } = setup();
	await emit("session_start", { reason: "startup" });
	const cmd = commands.get("worktree");

	// No other worktrees yet: asks for a name; blank = auto-named.
	answers.push(() => "first");
	await cmd.handler("", ctx);
	assert.equal(statuses.get("worktree"), "🌿 first");
	assert.match(notes.at(-2)!, /^🌿 Switched to new worktree first · /);
	assert.equal(notes.at(-1), "Copied 1 untracked file(s): .env");
	await cmd.handler("exit keep", ctx);

	// Existing worktrees: pick one from the dialog (pi-gui path).
	g("worktree", "add", "-q", "-b", "other", path.join(repo, "elsewhere"));
	let seen: string[] = [];
	answers.push((o) => {
		seen = o;
		return o.find((x) => x.includes("other"));
	});
	await cmd.handler("enter", ctx);
	assert.equal(seen[0], "+ New worktree…");
	assert.ok(!seen.some((x) => x.includes("main checkout")), "the current checkout is not offered");
	assert.equal(statuses.get("worktree"), "🌿 other");
	assert.match(notes.at(-1)!, /Switched to worktree other · .*elsewhere/);
	await cmd.handler("exit keep", ctx);

	// "+ New worktree…" then a name.
	answers.push(
		(o) => o[0],
		() => "made-here",
	);
	await cmd.handler("", ctx);
	assert.equal(statuses.get("worktree"), "🌿 made-here");
	assert.ok(fs.existsSync(path.join(repo, ".worktrees/made-here")));

	// While a worktree is active, bare /worktree shows status instead.
	notes.length = 0;
	await cmd.handler("", ctx);
	assert.match(notes[0]!, /^🌿 made-here on made-here/);
	fs.rmSync(repo, { recursive: true, force: true });
});
