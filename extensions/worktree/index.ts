/**
 * pi-wt: Claude-Code-style git worktrees for pi.
 *
 * - The agent calls `enter_worktree` when it starts a change and `exit_worktree`
 *   when it is done. While a worktree is active, every built-in file tool and
 *   bash command is transparently redirected into it.
 * - On quit, if a worktree created by this session is still active, you are
 *   asked whether to keep or remove it.
 * - `pi --wt` / `pi --worktree <name>` starts the session inside a new worktree.
 * - `/worktree` shows status, `/worktree enter <name>`, `/worktree exit [keep|remove]`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type BashOperations,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, readWorktreeInclude, type WorktreeConfig } from "./config.ts";
import {
	branchExists,
	copyUntracked,
	git,
	gitOut,
	listWorktrees,
	type RepoInfo,
	repoInfo,
	run,
	validBranchName,
	worktreeStatus,
} from "./git.ts";
import {
	isWithin,
	mapPath,
	type PathMapping,
	resolveRoot,
	rewriteCommand,
	shellQuote,
	slugify,
	timestampName,
} from "./paths.ts";

const STATE_ENTRY = "pi-wt-state";
const STATUS_KEY = "worktree";

interface ActiveWorktree {
	name: string;
	path: string;
	branch: string;
	/** Commit the worktree branch started from (for "new commits" checks). */
	baseCommit: string;
	/** True when this session created the worktree (and its branch). */
	created: boolean;
	/** True when this session created the branch. */
	createdBranch: boolean;
	/** Checkout pi was started in; paths under it are redirected. */
	repoRoot: string;
	mainRoot: string;
}

interface Repo extends RepoInfo {
	config: WorktreeConfig;
	worktreesRoot: string;
}

const FILE_TOOLS = new Set(["read", "write", "edit"]);
const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);

export default function piWorktree(pi: ExtensionAPI) {
	let repo: Repo | undefined;
	let active: ActiveWorktree | undefined;
	let sessionCwd = process.cwd();
	let localBash: BashOperations | undefined;

	// ---------------------------------------------------------------- helpers

	function mapping(): PathMapping | undefined {
		if (!active) return undefined;
		const rel = isWithin(sessionCwd, active.repoRoot) ? path.relative(active.repoRoot, sessionCwd) : "";
		const cwd = path.join(active.path, rel);
		const excluded = repo && isWithin(repo.worktreesRoot, active.repoRoot) ? [repo.worktreesRoot] : [];
		return { repoRoot: active.repoRoot, worktree: active.path, cwd: fs.existsSync(cwd) ? cwd : active.path, excluded };
	}

	function setActive(next: ActiveWorktree | undefined, ctx: ExtensionContext, persist = true) {
		active = next;
		if (persist) pi.appendEntry(STATE_ENTRY, next ?? null);
		ctx.ui.setStatus(STATUS_KEY, next ? ctx.ui.theme.fg("accent", `🌿 ${next.name}`) : undefined);
	}

	async function loadRepo(cwd: string): Promise<Repo | undefined> {
		const info = await repoInfo(cwd);
		if (!info) return undefined;
		const config = loadConfig(info.mainRoot);
		const worktreesRoot = resolveRoot(config.root, info.mainRoot);
		return { ...info, config, worktreesRoot };
	}

	function requireRepo(): Repo {
		if (!repo) throw new Error("Not inside a git repository, so worktrees are unavailable.");
		return repo;
	}

	async function ensureIgnored(r: Repo) {
		if (!isWithin(r.worktreesRoot, r.mainRoot)) return;
		const rel = `/${path.relative(r.mainRoot, r.worktreesRoot).split(path.sep).join("/")}/`;
		try {
			const excludePath = await gitOut(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], r.mainRoot);
			const content = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : "";
			if (content.split(/\r?\n/).some((l) => l.trim() === rel)) return;
			fs.mkdirSync(path.dirname(excludePath), { recursive: true });
			fs.appendFileSync(excludePath, `${content && !content.endsWith("\n") ? "\n" : ""}${rel}\n`);
		} catch {
			// best effort
		}
	}

	// ------------------------------------------------------------ operations

	async function enterWorktree(
		params: { name?: string; base?: string },
		ctx: ExtensionContext,
	): Promise<{ text: string; wt: ActiveWorktree }> {
		const r = requireRepo();
		if (active) {
			throw new Error(`Already in worktree "${active.name}" (${active.path}). Call exit_worktree first.`);
		}

		const name = slugify(params.name ?? "") || timestampName();
		const existing = (await listWorktrees(r.mainRoot)).find(
			(w) => w.branch === name || w.branch === `${r.config.branchPrefix}${name}` || path.basename(w.path) === name,
		);

		let wt: ActiveWorktree;
		const notes: string[] = [];

		if (existing) {
			if (path.resolve(existing.path) === path.resolve(r.repoRoot)) {
				throw new Error(`"${name}" is the checkout this session already runs in.`);
			}
			wt = {
				name,
				path: existing.path,
				branch: existing.branch ?? "(detached)",
				baseCommit: await gitOut(["rev-parse", "HEAD"], existing.path),
				created: false,
				createdBranch: false,
				repoRoot: r.repoRoot,
				mainRoot: r.mainRoot,
			};
			notes.push(`Reusing existing worktree at ${existing.path}.`);
		} else {
			const branch = `${r.config.branchPrefix}${name}`;
			if (!(await validBranchName(branch, r.mainRoot))) throw new Error(`Invalid branch name: ${branch}`);
			const wtPath = path.join(r.worktreesRoot, name.replaceAll("/", "-"));
			if (fs.existsSync(wtPath)) throw new Error(`Path already exists and is not a registered worktree: ${wtPath}`);
			const base = params.base?.trim() || "HEAD";
			const baseCommit = await gitOut(["rev-parse", "--verify", `${base}^{commit}`], r.repoRoot);
			const hasBranch = await branchExists(branch, r.mainRoot);

			fs.mkdirSync(path.dirname(wtPath), { recursive: true });
			await ensureIgnored(r);
			const args = hasBranch ? ["worktree", "add", wtPath, branch] : ["worktree", "add", "-b", branch, wtPath, baseCommit];
			const res = await git(args, r.mainRoot, 300_000);
			if (res.code !== 0) throw new Error(`git worktree add failed: ${(res.stderr || res.stdout).trim()}`);

			wt = {
				name,
				path: fs.realpathSync(wtPath),
				branch,
				baseCommit: hasBranch ? await gitOut(["rev-parse", "HEAD"], wtPath) : baseCommit,
				created: true,
				createdBranch: !hasBranch,
				repoRoot: r.repoRoot,
				mainRoot: r.mainRoot,
			};
			notes.push(
				hasBranch
					? `Created worktree for existing branch ${branch} at ${wt.path}.`
					: `Created worktree at ${wt.path} on new branch ${branch} (from ${base} @ ${baseCommit.slice(0, 9)}).`,
			);

			const patterns = [...r.config.copy, ...readWorktreeInclude(r.mainRoot)];
			const copied = await copyUntracked(r.repoRoot, wt.path, patterns);
			if (copied.length > 0) notes.push(`Copied ${copied.length} untracked file(s): ${copied.slice(0, 10).join(", ")}${copied.length > 10 ? ", …" : ""}`);

			if (r.config.setup) {
				ctx.ui.notify(`pi-wt: running setup in ${name}…`, "info");
				const s = await run("/bin/sh", ["-c", r.config.setup], wt.path, 15 * 60_000);
				const tail = (s.stdout + s.stderr).trim().split("\n").slice(-15).join("\n");
				notes.push(`Setup \`${r.config.setup}\` exited with ${s.code}.${tail ? `\n${tail}` : ""}`);
			}
		}

		setActive(wt, ctx);
		notes.push(
			"All file tools and bash commands now run inside this worktree. Paths under the original checkout are redirected automatically. Call exit_worktree when the work is finished.",
		);
		return { text: notes.join("\n"), wt };
	}

	async function describeChanges(wt: ActiveWorktree): Promise<{ dirty: boolean; summary: string }> {
		const st = await worktreeStatus(wt.path, wt.baseCommit);
		const parts: string[] = [];
		if (st.changes.length) parts.push(`${st.changes.length} uncommitted change(s)`);
		if (st.newCommits) parts.push(`${st.newCommits} new commit(s) on ${wt.branch}`);
		return { dirty: parts.length > 0, summary: parts.join(" and ") || "no changes" };
	}

	async function removeWorktree(wt: ActiveWorktree, force: boolean): Promise<string> {
		const res = await git(["worktree", "remove", ...(force ? ["--force"] : []), wt.path], wt.mainRoot, 120_000);
		if (res.code !== 0) throw new Error(`git worktree remove failed: ${(res.stderr || res.stdout).trim()}`);
		if (!wt.createdBranch) return `Removed worktree ${wt.path} (branch ${wt.branch} kept).`;
		const del = await git(["branch", force ? "-D" : "-d", wt.branch], wt.mainRoot);
		return del.code === 0
			? `Removed worktree ${wt.path} and branch ${wt.branch}.`
			: `Removed worktree ${wt.path}; branch ${wt.branch} kept (${(del.stderr || del.stdout).trim()}).`;
	}

	async function exitWorktree(
		params: { action: "keep" | "remove"; discard_changes?: boolean },
		ctx: ExtensionContext,
	): Promise<string> {
		const wt = active;
		if (!wt) throw new Error("No worktree is active in this session.");
		if (params.action === "keep") {
			setActive(undefined, ctx);
			return `Left worktree "${wt.name}". It is kept at ${wt.path} on branch ${wt.branch}. Tools point at ${wt.repoRoot} again.`;
		}
		if (!wt.created) {
			throw new Error(
				`Worktree "${wt.name}" was not created by this session, so it will not be removed. Use action "keep".`,
			);
		}
		const { dirty, summary } = await describeChanges(wt);
		if (dirty && !params.discard_changes) {
			throw new Error(
				`Worktree "${wt.name}" has ${summary}. Removing it would lose that work. Confirm with the user, then call exit_worktree again with discard_changes: true, or use action "keep".`,
			);
		}
		const text = await removeWorktree(wt, dirty);
		setActive(undefined, ctx);
		return `${text} Tools point at ${wt.repoRoot} again.`;
	}

	// ---------------------------------------------------------------- tools

	pi.registerTool({
		name: "enter_worktree",
		label: "Enter worktree",
		description:
			"Create an isolated git worktree (new branch from the current HEAD, or from `base`) and move this session into it. " +
			"If a worktree with that name/branch already exists, it is reused. After this call every file tool and bash command runs inside the worktree.",
		promptSnippet: "Create/enter an isolated git worktree for the current task",
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Short name for the worktree and its branch, e.g. a ticket id or 'fix-login-bug'. Random if omitted." }),
			),
			base: Type.Optional(Type.String({ description: "Ref to branch from. Defaults to HEAD of the current checkout." })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { text, wt } = await enterWorktree(params, ctx);
			return { content: [{ type: "text", text }], details: { worktree: wt } };
		},
	});

	pi.registerTool({
		name: "exit_worktree",
		label: "Exit worktree",
		description:
			"Leave the active worktree and return to the original checkout. action 'keep' leaves it on disk; 'remove' deletes the worktree and the branch this session created. " +
			"Removal refuses if there are uncommitted changes or new commits unless discard_changes is true — only set that after the user confirmed.",
		promptSnippet: "Leave the active worktree (keep or remove it)",
		parameters: Type.Object({
			action: StringEnum(["keep", "remove"] as const),
			discard_changes: Type.Optional(Type.Boolean({ description: "Required to remove a worktree with uncommitted changes or unmerged commits." })),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const text = await exitWorktree(params, ctx);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	// ------------------------------------------------------------- redirection

	pi.on("tool_call", (event) => {
		const m = mapping();
		if (!m) return;
		const input = event.input as Record<string, unknown>;

		if (event.toolName === "bash") {
			if (typeof input.command !== "string") return;
			input.command = `cd ${shellQuote(m.cwd)} && ${rewriteCommand(input.command, m)}`;
			return;
		}
		if (FILE_TOOLS.has(event.toolName)) {
			if (typeof input.path === "string") input.path = mapPath(input.path, m);
			return;
		}
		if (SEARCH_TOOLS.has(event.toolName)) {
			input.path = typeof input.path === "string" && input.path ? mapPath(input.path, m) : m.cwd;
		}
	});

	pi.on("user_bash", (event) => {
		const m = mapping();
		if (!m) return;
		localBash ??= createLocalBashOperations();
		const ops = localBash;
		return {
			operations: {
				exec: (command, _cwd, options) => ops.exec(rewriteCommand(command, m), m.cwd, options),
			},
		};
	});

	pi.on("before_agent_start", (event) => {
		if (!repo) return;
		const opts = event.systemPromptOptions;
		const m = mapping();
		if (m && active) {
			opts.cwd = m.cwd;
			opts.sections.worktree = [
				`You are working inside git worktree "${active.name}" on branch ${active.branch} at ${active.path}.`,
				`The original checkout is ${active.repoRoot}; paths under it are redirected into the worktree automatically, so prefer paths relative to the working directory.`,
				"Commit your work on this branch when appropriate. When the task is finished, call exit_worktree (keep, or remove after the work is merged/pushed or the user agrees to discard it).",
			].join("\n");
		} else if (repo.config.policy === "auto") {
			opts.sections.worktree = [
				"Git worktrees are available via enter_worktree / exit_worktree.",
				"When you start a task that will modify code in this repository (a feature, fix, refactor, or experiment), first call enter_worktree with a short descriptive name (use the ticket id if there is one), then do the work there. When done, call exit_worktree.",
				"Skip worktrees for questions, read-only exploration, or when the user asks you to work in the current checkout.",
			].join("\n");
		} else {
			opts.sections.worktree =
				"Git worktrees are available via enter_worktree / exit_worktree. Use them only when the user asks to work in a worktree.";
		}
	});

	// --------------------------------------------------------------- lifecycle

	pi.registerFlag("worktree", { description: "Start the session in a new git worktree with this name", type: "string" });
	pi.registerFlag("wt", { description: "Start the session in a new git worktree (auto-named)", type: "boolean", default: false });

	pi.on("session_start", async (event, ctx) => {
		sessionCwd = ctx.cwd;
		repo = await loadRepo(ctx.cwd);
		active = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (!repo) return;

		// Restore the latest state from this session branch (resume, reload, fork).
		let restored: ActiveWorktree | null | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) restored = entry.data as ActiveWorktree | null;
		}
		if (restored && fs.existsSync(restored.path)) {
			setActive(restored, ctx, false);
		} else if (restored) {
			pi.appendEntry(STATE_ENTRY, null);
			ctx.ui.notify(`pi-wt: worktree ${restored.path} no longer exists; back in ${repo.repoRoot}`, "warning");
		}

		if (event.reason !== "startup" || active) return;
		const flagName = pi.getFlag("worktree");
		if (typeof flagName !== "string" && pi.getFlag("wt") !== true) return;
		try {
			const { wt } = await enterWorktree({ name: typeof flagName === "string" ? flagName : undefined }, ctx);
			ctx.ui.notify(`🌿 Working in worktree ${wt.name} (${wt.path})`, "info");
		} catch (error) {
			ctx.ui.notify(`pi-wt: ${(error as Error).message}`, "error");
		}
	});

	pi.on("session_shutdown", async (event) => {
		const wt = active;
		if (!wt || event.reason !== "quit" || !wt.created) return;
		let changes: { dirty: boolean; summary: string };
		try {
			changes = await describeChanges(wt);
		} catch {
			return;
		}
		// The TUI is already stopped here, so ask on the raw terminal.
		if (!process.stdin.isTTY || !process.stderr.isTTY) {
			process.stderr.write(`Worktree kept at ${wt.path} (branch ${wt.branch}).\n`);
			return;
		}
		if (process.stdin.isRaw) process.stdin.setRawMode(false);
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		let remove = false;
		try {
			const warn = changes.dirty ? `\x1b[33m⚠ It has ${changes.summary}; removing discards them.\x1b[0m\n` : "";
			const answer = await rl.question(
				`\n🌿 Worktree "${wt.name}" is still active at ${wt.path} (branch ${wt.branch}).\n${warn}Keep or remove it? [K]eep / [r]emove: `,
			);
			remove = /^r(emove)?$/i.test(answer.trim());
		} finally {
			rl.close();
		}
		if (!remove) {
			process.stderr.write(`Kept ${wt.path}\n`);
			return;
		}
		try {
			process.stderr.write(`${await removeWorktree(wt, changes.dirty)}\n`);
		} catch (error) {
			process.stderr.write(`${(error as Error).message}\n`);
		}
	});

	// ----------------------------------------------------------------- command

	pi.registerCommand("worktree", {
		description: "Worktree status; `/worktree enter <name>`, `/worktree exit [keep|remove]`, `/worktree list`",
		getArgumentCompletions: (prefix) =>
			["enter ", "exit keep", "exit remove", "list"]
				.filter((v) => v.startsWith(prefix))
				.map((v) => ({ value: v, label: v })),
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (sub === "enter") {
					const { text } = await enterWorktree({ name: rest[0], base: rest[1] }, ctx);
					ctx.ui.notify(text, "info");
				} else if (sub === "exit") {
					const wt = active;
					const action = rest[0] === "remove" ? "remove" : "keep";
					let discard = false;
					if (wt && action === "remove") {
						const { dirty, summary } = await describeChanges(wt);
						if (dirty) {
							discard = await ctx.ui.confirm("Remove worktree?", `"${wt.name}" has ${summary}. Discard them?`);
							if (!discard) return;
						}
					}
					ctx.ui.notify(await exitWorktree({ action, discard_changes: discard }, ctx), "info");
				} else if (sub === "list") {
					const r = requireRepo();
					const lines = (await listWorktrees(r.mainRoot)).map(
						(w) => `${active && path.resolve(w.path) === path.resolve(active.path) ? "▶" : " "} ${w.branch ?? "(detached)"}  ${w.path}${w.prunable ? "  [prunable]" : ""}`,
					);
					ctx.ui.notify(lines.join("\n"), "info");
				} else if (active) {
					const { summary } = await describeChanges(active);
					ctx.ui.notify(`🌿 ${active.name} on ${active.branch}\n${active.path}\n${summary}`, "info");
				} else {
					ctx.ui.notify("No active worktree. Use `/worktree enter <name>` or ask the agent to start one.", "info");
				}
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});
}
