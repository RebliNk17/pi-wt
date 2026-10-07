/**
 * pi-wt: Claude-Code-style git worktrees for pi.
 *
 * - The agent calls `enter_worktree` when it starts a change and `exit_worktree`
 *   when it is done. While a worktree is active, every built-in file tool and
 *   bash command is transparently redirected into it.
 * - On quit, if a worktree created by this session is still active, you are
 *   asked whether to keep or remove it.
 * - `pi --wt` / `pi --worktree <name>` starts the session inside a new worktree.
 * - `/worktree` picks a worktree to switch to (status while in one); `/worktree enter [name]`,
 *   `/worktree exit [keep|remove]`, `/worktree list [filter]`, `/worktree clean`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type BashOperations,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig, readWorktreeInclude, type WorktreeConfig } from "./config.ts";
import { dialogClean, dialogList, dialogSwitch } from "./dialogs.ts";
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
	assess,
	collect,
	fillChanges,
	fillPrs,
	formatList,
	isDone,
	type Row,
	removeRows,
	rowName,
	tildify as tildifyPath,
} from "./list.ts";
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
import { isEnterable, type PickerOptions, type PickerResult, WorktreePicker } from "./picker.ts";
import { color, select } from "./prompt.ts";

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

	const realPath = (p: string) => {
		try {
			return fs.realpathSync(p);
		} catch {
			return path.resolve(p);
		}
	};

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
		// Lets custom footers/statuslines follow the worktree (branch, PR, etc.).
		pi.events.emit("pi-wt:changed", next ? { name: next.name, path: next.path, branch: next.branch } : null);
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
			const excludePath = await gitOut(
				["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
				r.mainRoot,
			);
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
		params: { name?: string; base?: string /** Enter this existing worktree. */; path?: string },
		ctx: ExtensionContext,
	): Promise<{ text: string; wt: ActiveWorktree; summary: string[] }> {
		const r = requireRepo();
		if (active) {
			throw new Error(`Already in worktree "${active.name}" (${active.path}). Call exit_worktree first.`);
		}

		const entries = await listWorktrees(r.mainRoot);
		const byPath = params.path ? entries.find((w) => realPath(w.path) === realPath(params.path ?? "")) : undefined;
		if (params.path && !byPath) throw new Error(`Not a worktree of this repo: ${params.path}`);
		const name = byPath ? (byPath.branch ?? path.basename(byPath.path)) : slugify(params.name ?? "") || timestampName();
		const existing =
			byPath ??
			entries.find(
				(w) => w.branch === name || w.branch === `${r.config.branchPrefix}${name}` || path.basename(w.path) === name,
			);

		let wt: ActiveWorktree;
		const notes: string[] = [];

		if (existing) {
			if (realPath(existing.path) === realPath(r.repoRoot)) {
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
			const args = hasBranch
				? ["worktree", "add", wtPath, branch]
				: ["worktree", "add", "-b", branch, wtPath, baseCommit];
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
			if (copied.length > 0)
				notes.push(
					`Copied ${copied.length} untracked file(s): ${copied.slice(0, 10).join(", ")}${copied.length > 10 ? ", …" : ""}`,
				);

			if (r.config.setup) {
				ctx.ui.notify(`pi-wt: running setup in ${name}…`, "info");
				const s = await run("/bin/sh", ["-c", r.config.setup], wt.path, 15 * 60_000);
				const tail = (s.stdout + s.stderr).trim().split("\n").slice(-15).join("\n");
				notes.push(`Setup \`${r.config.setup}\` exited with ${s.code}.${tail ? `\n${tail}` : ""}`);
			}
		}

		setActive(wt, ctx);
		const summary = [...notes];
		notes.push(
			"All file tools and bash commands now run inside this worktree. Paths under the original checkout are redirected automatically. Call exit_worktree when the work is finished.",
		);
		return { text: notes.join("\n"), wt, summary };
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
				Type.String({
					description:
						"Short name for the worktree and its branch, e.g. a ticket id or 'fix-login-bug'. Random if omitted.",
				}),
			),
			base: Type.Optional(
				Type.String({ description: "Ref to branch from. Defaults to HEAD of the current checkout." }),
			),
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
			discard_changes: Type.Optional(
				Type.Boolean({ description: "Required to remove a worktree with uncommitted changes or unmerged commits." }),
			),
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

	pi.on("user_bash", () => {
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

	pi.registerFlag("worktree", {
		description: "Start the session in a new git worktree with this name",
		type: "string",
	});
	pi.registerFlag("wt", {
		description: "Start the session in a new git worktree (auto-named)",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (event, ctx) => {
		sessionCwd = ctx.cwd;
		repo = await loadRepo(ctx.cwd);
		active = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		pi.events.emit("pi-wt:changed", null);
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
		const home = os.homedir();
		const tilde = (p: string) => (p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);
		if (!process.stdin.isTTY || !process.stderr.isTTY) {
			process.stderr.write(`Worktree kept at ${tilde(wt.path)} (branch ${wt.branch}).\n`);
			return;
		}

		const { bold, dim, green, yellow, cyan, red } = color;
		const header = [
			"",
			`  🌿 ${bold("Worktree still active")}`,
			"",
			`     ${dim("name  ")} ${cyan(wt.name)}`,
			`     ${dim("branch")} ${wt.branch}`,
			`     ${dim("path  ")} ${tilde(wt.path)}`,
			...(changes.dirty ? ["", `     ${yellow(`⚠  ${changes.summary} — removing discards them`)}`] : []),
			"",
			`  ${bold("Remove this worktree?")} ${dim("(↑/↓ to choose, enter to confirm)")}`,
		];
		const remove = await select(
			header,
			[
				{ label: "No", hint: "keep it on disk", value: false },
				{ label: "Yes", hint: wt.createdBranch ? "delete worktree and branch" : "delete worktree", value: true },
			],
			0,
			false,
		);

		if (!remove) {
			process.stderr.write(`\n  ${green("✔")} Kept ${dim(tilde(wt.path))}\n\n`);
			return;
		}
		try {
			await removeWorktree(wt, changes.dirty);
			process.stderr.write(
				`\n  ${green("✔")} Removed worktree ${cyan(wt.name)}${wt.createdBranch ? " and its branch" : ""}\n\n`,
			);
		} catch (error) {
			process.stderr.write(`\n  ${red("✖")} ${(error as Error).message}\n\n`);
		}
	});

	// ------------------------------------------------------------ list/clean

	async function listCommand(ctx: ExtensionContext, opts: PickerOptions) {
		const r = requireRepo();
		const listing = await collect(r.mainRoot, r.repoRoot, active?.path);

		// Hosts without terminal components. pi-gui/RPC have dialogs; print/json only get text.
		const plain = async () => {
			if (ctx.hasUI) ctx.ui.notify("🌿 Checking worktrees…", "info");
			await Promise.all([fillChanges(listing.rows), fillPrs(listing).catch(() => false)]);
			const q = opts.filter?.toLowerCase().trim();
			if (q)
				listing.rows = listing.rows.filter((x) =>
					[x.branch, x.path, x.subject, x.pr?.title].some((v) => v?.toLowerCase().includes(q)),
				);
			if (ctx.hasUI) return opts.autoSelectDone ? dialogClean(ctx, listing) : dialogList(ctx, listing);
			if (!opts.autoSelectDone) return ctx.ui.notify(formatList(listing), "info");
			const rows = listing.rows.filter(isDone);
			if (!rows.length) return ctx.ui.notify("Nothing to clean: no finished worktrees.", "info");
			await confirmAndRemove(ctx, rows, r.mainRoot);
		};
		if (ctx.mode !== "tui") return plain();

		let picker: WorktreePicker | undefined;
		let closed = false;
		const loading = new Set(["changes", "PRs"]);
		const update = () => picker?.update([...loading]);
		const result = ctx.ui.custom<PickerResult>((tui, theme, _kb, done) => {
			picker = new WorktreePicker(listing, tui, theme, done, opts);
			picker.update([...loading]);
			return picker;
		});
		// Change counts and PR lookups are the slow parts; they fill in while the picker is open.
		void fillChanges(listing.rows, update, () => closed).finally(() => {
			loading.delete("changes");
			update();
		});
		void fillPrs(listing)
			.catch(() => false)
			.finally(() => {
				loading.delete("PRs");
				update();
			});
		let res: PickerResult;
		try {
			res = await result;
		} catch {
			closed = true;
			return plain(); // host refused the custom component
		}
		closed = true;
		if (res.action === "remove") await confirmAndRemove(ctx, res.rows, r.mainRoot);
	}

	/** Enter (or create) a worktree from a command and say where we are, in one short line. */
	async function enterAndReport(ctx: ExtensionContext, params: { name?: string; base?: string; path?: string }) {
		const { wt, summary } = await enterWorktree(params, ctx);
		const how = wt.created ? (wt.createdBranch ? "new worktree" : "new worktree for existing branch") : "worktree";
		ctx.ui.notify(`🌿 Switched to ${how} ${wt.branch} · ${tildifyPath(wt.path)}`, "info");
		const extra = summary.filter((l) => !/^(Created|Reusing)/.test(l));
		if (extra.length) ctx.ui.notify(extra.join("\n"), "info");
	}

	/** Pick an existing worktree to enter, or create a new one. */
	async function switchCommand(ctx: ExtensionContext) {
		const r = requireRepo();
		if (active) {
			ctx.ui.notify(`Already in worktree ${active.name}. Use \`/worktree exit\` first.`, "warning");
			return;
		}
		const listing = await collect(r.mainRoot, r.repoRoot);
		const enterable = listing.rows.filter(isEnterable);

		const viaDialogs = async () => {
			await Promise.all([fillChanges(listing.rows), fillPrs(listing).catch(() => false)]);
			const pick = await dialogSwitch(ctx, listing);
			if (pick?.action === "enter") await enterAndReport(ctx, { path: pick.row.path });
			else if (pick?.action === "create") await enterAndReport(ctx, { name: pick.name || undefined });
		};
		if (!enterable.length) {
			// Nothing to choose from: ask for a name (blank = auto-named).
			if (!ctx.hasUI) return enterAndReport(ctx, {});
			const name = await ctx.ui.input("New worktree name", "leave empty for an automatic name");
			if (name === undefined) return;
			return enterAndReport(ctx, { name: name.trim() || undefined });
		}
		if (ctx.mode !== "tui") return ctx.hasUI ? viaDialogs() : undefined;

		let picker: WorktreePicker | undefined;
		let closed = false;
		const loading = new Set(["changes", "PRs"]);
		const update = () => picker?.update([...loading]);
		const result = ctx.ui.custom<PickerResult>((tui, theme, _kb, done) => {
			picker = new WorktreePicker(listing, tui, theme, done, { mode: "switch" });
			picker.update([...loading]);
			return picker;
		});
		void fillChanges(listing.rows, update, () => closed).finally(() => {
			loading.delete("changes");
			update();
		});
		void fillPrs(listing)
			.catch(() => false)
			.finally(() => {
				loading.delete("PRs");
				update();
			});
		let res: PickerResult;
		try {
			res = await result;
		} catch {
			closed = true;
			return viaDialogs();
		}
		closed = true;
		if (res.action === "enter") await enterAndReport(ctx, { path: res.row.path });
		else if (res.action === "create") {
			const name = res.name || (await ctx.ui.input("New worktree name", "leave empty for an automatic name"));
			if (name !== undefined) await enterAndReport(ctx, { name: name.trim() || undefined });
		}
	}

	async function confirmAndRemove(ctx: ExtensionContext, rows: Row[], mainRoot: string) {
		const verdicts = rows.map((row) => assess(row));
		const risky = rows.filter((_, i) => verdicts[i]?.verdict === "unsaved" || verdicts[i]?.verdict === "pending");
		const names = rows.map((row, i) => {
			const a = verdicts[i];
			const note = a?.verdict === "unsaved" ? `  ⚠ ${a.reasons.join(", ")}` : "";
			return `  • ${rowName(row)}${note}`;
		});
		const title = `Remove ${rows.length} worktree${rows.length === 1 ? "" : "s"}?`;
		const warn = risky.length ? `\n⚠ ${risky.length} of them have work that will be lost.` : "";
		const BOTH = "Remove worktrees and their branches";
		const WT = "Remove worktrees, keep branches";
		const choice = await ctx.ui.select(`${title}\n${names.join("\n")}${warn}`, [BOTH, WT, "Cancel"]);
		if (choice !== BOTH && choice !== WT) return;
		const force = rows.some((row) => (row.changes ?? 0) > 0);
		const results = await removeRows(rows, mainRoot, { deleteBranches: choice === BOTH, force });
		const ok = results.filter((x) => x.ok).length;
		const lines = results.map((x) => `${x.ok ? "✔" : "✖"} ${rowName(x.row)}: ${x.message}`);
		ctx.ui.notify(`Removed ${ok}/${rows.length}\n${lines.join("\n")}`, ok === rows.length ? "info" : "warning");
	}

	// ----------------------------------------------------------------- command

	pi.registerCommand("worktree", {
		description:
			"Pick a worktree to switch to (or status when in one); `/worktree enter [name]`, `/worktree exit [keep|remove]`, `/worktree list [filter]`, `/worktree clean`",
		getArgumentCompletions: async (prefix) => {
			const subs = ["enter ", "switch", "exit keep", "exit remove", "list", "clean"];
			const m = /^enter\s+(\S*)$/.exec(prefix);
			if (m && repo) {
				// Complete existing worktree branches for `/worktree enter <name>`.
				const here = realPath(repo.repoRoot);
				const names = (await listWorktrees(repo.mainRoot).catch(() => []))
					.filter((w) => w.branch && realPath(w.path) !== here)
					.map((w) => w.branch as string)
					.filter((b) => b.startsWith(m[1] ?? ""));
				return names.map((b) => ({ value: `enter ${b}`, label: b }));
			}
			return subs.filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
		},
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (sub === "enter" && rest[0]) {
					await enterAndReport(ctx, { name: rest[0], base: rest[1] });
				} else if (sub === "enter" || sub === "switch" || (!sub && !active)) {
					await switchCommand(ctx);
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
				} else if (sub === "list" || sub === "ls") {
					await listCommand(ctx, { filter: rest.join(" ") });
				} else if (sub === "clean") {
					await listCommand(ctx, { view: "done", autoSelectDone: true });
				} else if (active && !sub) {
					const { summary } = await describeChanges(active);
					ctx.ui.notify(`🌿 ${active.name} on ${active.branch}\n${active.path}\n${summary}`, "info");
				} else {
					ctx.ui.notify(`Unknown subcommand "${sub}". Try enter, switch, exit, list or clean.`, "warning");
				}
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	});
}
