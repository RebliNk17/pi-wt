import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run a program without a shell. Never rejects. */
export function run(file: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			const errCode: unknown = error ? (error as { code?: unknown }).code : 0;
			const code = typeof errCode === "number" ? errCode : error ? 1 : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : "")) });
		});
	});
}

export function git(args: string[], cwd: string, timeoutMs?: number): Promise<RunResult> {
	return run("git", args, cwd, timeoutMs);
}

export async function gitOut(args: string[], cwd: string): Promise<string> {
	const r = await git(args, cwd);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
	return r.stdout.trim();
}

export interface RepoInfo {
	/** Top-level of the checkout containing `cwd`. */
	repoRoot: string;
	/** Top-level of the main (non-linked) worktree. */
	mainRoot: string;
}

export async function repoInfo(cwd: string): Promise<RepoInfo | undefined> {
	const top = await git(["rev-parse", "--show-toplevel"], cwd);
	if (top.code !== 0) return undefined;
	const repoRoot = fs.realpathSync(top.stdout.trim());
	const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	let mainRoot = repoRoot;
	if (common.code === 0) {
		const dir = common.stdout.trim();
		if (path.basename(dir) === ".git") mainRoot = fs.realpathSync(path.dirname(dir));
	}
	return { repoRoot, mainRoot };
}

export interface WorktreeEntry {
	path: string;
	branch?: string;
	head?: string;
	bare: boolean;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
	const out = await gitOut(["worktree", "list", "--porcelain"], cwd);
	const entries: WorktreeEntry[] = [];
	let cur: WorktreeEntry | undefined;
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) {
			cur = { path: line.slice(9), bare: false, detached: false, locked: false, prunable: false };
			entries.push(cur);
		} else if (!cur) continue;
		else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
		else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
		else if (line === "bare") cur.bare = true;
		else if (line === "detached") cur.detached = true;
		else if (line.startsWith("locked")) cur.locked = true;
		else if (line.startsWith("prunable")) cur.prunable = true;
	}
	return entries;
}

export async function branchExists(branch: string, cwd: string): Promise<boolean> {
	return (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd)).code === 0;
}

export async function validBranchName(branch: string, cwd: string): Promise<boolean> {
	return (await git(["check-ref-format", "--branch", branch], cwd)).code === 0;
}

export interface WorktreeStatus {
	/** `git status --porcelain` lines. */
	changes: string[];
	/** Commits on HEAD that are not on `base`. */
	newCommits: number;
}

export async function worktreeStatus(wtPath: string, base?: string): Promise<WorktreeStatus> {
	const status = await gitOut(["status", "--porcelain", "--untracked-files=normal"], wtPath);
	let newCommits = 0;
	if (base) {
		const r = await git(["rev-list", "--count", `${base}..HEAD`], wtPath);
		if (r.code === 0) newCommits = Number(r.stdout.trim()) || 0;
	}
	return { changes: status ? status.split("\n") : [], newCommits };
}

export interface BranchInfo {
	/** Commit the branch points at. */
	tip: string;
	upstream?: string;
	/** Branch name on the remote (`feature-x` for `refs/heads/feature-x`). */
	remoteBranch?: string;
	ahead: number;
	behind: number;
	/** Upstream is configured but no longer exists (typically: PR merged and remote branch deleted). */
	gone: boolean;
	/** Committer date of the tip, unix seconds. */
	time?: number;
	subject?: string;
}

/** Every local branch with upstream tracking and its last commit, in one `for-each-ref` call. */
export async function listBranches(cwd: string): Promise<Map<string, BranchInfo>> {
	const fmt =
		"%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:remoteref)%00%(upstream:track)%00%(committerdate:unix)%00%(contents:subject)";
	const r = await git(["for-each-ref", "refs/heads", `--format=${fmt}`], cwd);
	const out = new Map<string, BranchInfo>();
	if (r.code !== 0) return out;
	for (const line of r.stdout.split("\n")) {
		if (!line) continue;
		const [ref = "", tip = "", upstream, remoteRef, track = "", time, subject] = line.split("\0");
		out.set(ref.replace(/^refs\/heads\//, ""), {
			tip,
			upstream: upstream || undefined,
			remoteBranch: remoteRef?.replace(/^refs\/heads\//, "") || undefined,
			ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
			behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
			gone: track.includes("gone"),
			time: Number(time) || undefined,
			subject: subject || undefined,
		});
	}
	return out;
}

/** `git branch --edit-description` texts, keyed by branch. */
export async function branchDescriptions(cwd: string): Promise<Map<string, string>> {
	const r = await git(["config", "-z", "--get-regexp", "^branch\\..*\\.description$"], cwd);
	const out = new Map<string, string>();
	if (r.code !== 0) return out;
	for (const rec of r.stdout.split("\0")) {
		const nl = rec.indexOf("\n");
		if (nl < 0) continue;
		const value = rec.slice(nl + 1).trim();
		if (value) out.set(rec.slice("branch.".length, nl - ".description".length), value);
	}
	return out;
}

/** The repo's default branch (e.g. `origin/main`), if one can be found. */
export async function defaultBaseRef(cwd: string): Promise<string | undefined> {
	const r = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd);
	if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
	for (const b of ["main", "master"]) if (await branchExists(b, cwd)) return b;
	return undefined;
}

/** Local branches whose tip is contained in `base`. */
export async function mergedInto(base: string, cwd: string): Promise<Set<string>> {
	const r = await git(["branch", "--merged", base, "--format=%(refname)"], cwd);
	if (r.code !== 0) return new Set();
	return new Set(
		r.stdout
			.split("\n")
			.filter(Boolean)
			.map((l) => l.replace(/^refs\/heads\//, "")),
	);
}

/** Number of uncommitted changes (incl. untracked files), or undefined if git failed. */
export async function countChanges(wtPath: string): Promise<number | undefined> {
	const r = await git(["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal"], wtPath, 30_000);
	if (r.code !== 0) return undefined;
	return r.stdout.split("\n").filter(Boolean).length;
}

/** Last commit of a checkout (for detached worktrees, which have no branch entry). */
export async function headSummary(wtPath: string): Promise<{ time?: number; subject?: string }> {
	const r = await git(["log", "-1", "--format=%ct%x00%s", "HEAD"], wtPath);
	if (r.code !== 0) return {};
	const [time, subject] = r.stdout.trim().split("\0");
	return { time: Number(time) || undefined, subject: subject || undefined };
}

/** Copy untracked files matching `patterns` (gitignore syntax) from `from` into `to`. */
export async function copyUntracked(from: string, to: string, patterns: string[]): Promise<string[]> {
	if (patterns.length === 0) return [];
	const args = ["ls-files", "-z", "--others", "--ignored"];
	for (const p of patterns) args.push(`--exclude=${p}`);
	const r = await git(args, from, 120_000);
	if (r.code !== 0) return [];
	const copied: string[] = [];
	for (const rel of r.stdout.split("\0").filter(Boolean)) {
		const src = path.join(from, rel);
		const dst = path.join(to, rel);
		try {
			if (fs.existsSync(dst) || !fs.statSync(src).isFile()) continue;
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			fs.copyFileSync(src, dst);
			copied.push(rel);
		} catch {
			// best effort
		}
	}
	return copied;
}
