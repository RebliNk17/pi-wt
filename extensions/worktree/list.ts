import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	branchDescriptions,
	countChanges,
	defaultBaseRef,
	git,
	headSummary,
	listBranches,
	listWorktrees,
	mergedInto,
} from "./git.ts";
import { fetchPrs, type PrInfo } from "./github.ts";

export interface Row {
	path: string;
	branch?: string;
	head?: string;
	/** Main (non-linked) worktree. */
	main: boolean;
	/** The checkout pi was started in. */
	here: boolean;
	/** The worktree this session is working in. */
	active: boolean;
	locked: boolean;
	/** Folder is gone; `git worktree prune` material. */
	missing: boolean;
	/** Commit the branch points at. */
	tip?: string;
	upstream?: string;
	/** Branch name on the remote, used to look up its PR. */
	remoteBranch?: string;
	ahead: number;
	behind: number;
	/** Upstream configured but deleted on the remote (usually: PR merged). */
	gone: boolean;
	/** Tip is contained in the base branch, and the branch was pushed at some point. */
	merged: boolean;
	/** Tip is contained in the base branch but it was never pushed: no work of its own yet. */
	empty: boolean;
	time?: number;
	subject?: string;
	description?: string;
	/** Uncommitted changes; undefined while still being counted. */
	changes?: number;
	/** Latest PR for this branch, if `gh` found one. */
	pr?: PrInfo;
	/** Local branch is not contained in the (merged/closed) PR's head, or that can't be verified. */
	afterPr?: boolean;
}

/**
 * What a worktree means for "can I delete it?":
 * - done: its work is merged or closed; removing it loses nothing.
 * - empty: no commits of its own and no changes; removing it loses nothing.
 * - progress: pushed and not finished (open PR, or no PR yet).
 * - unsaved: has work that exists only on this disk.
 * - pending: still counting uncommitted changes.
 */
export type Verdict = "done" | "empty" | "progress" | "unsaved" | "pending";

export interface Assessment {
	verdict: Verdict;
	/** Why, most important first. */
	reasons: string[];
}

export function assess(r: Row, base?: string): Assessment {
	if (r.missing) return { verdict: "done", reasons: ["folder already deleted"] };
	const unsaved: string[] = [];
	if (r.changes && r.changes > 0) unsaved.push(`${r.changes} uncommitted change${r.changes === 1 ? "" : "s"}`);
	if (r.upstream && !r.gone && r.ahead > 0) unsaved.push(`${r.ahead} unpushed commit${r.ahead === 1 ? "" : "s"}`);
	if (r.branch && !r.upstream && !r.merged && !r.empty && !r.pr && !r.main) unsaved.push("commits never pushed");
	const pushed = !!r.upstream && !r.gone;
	if (r.afterPr && r.pr && !pushed) unsaved.push(`local commits differ from PR #${r.pr.number}`);
	if (unsaved.length) return { verdict: "unsaved", reasons: unsaved };
	if (r.changes === undefined) return { verdict: "pending", reasons: [] };
	if (r.main) return { verdict: "progress", reasons: [] };

	const pr = r.afterPr ? undefined : r.pr;
	if (r.afterPr && r.pr) return { verdict: "progress", reasons: [`branch differs from PR #${r.pr.number}`] };
	if (pr?.state === "MERGED") return { verdict: "done", reasons: [`PR #${pr.number} merged`] };
	if (r.merged) return { verdict: "done", reasons: [`merged into ${base ?? "base"}`] };
	if (pr?.state === "CLOSED") return { verdict: "done", reasons: [`PR #${pr.number} closed without merging`] };
	if (r.gone && !pr) return { verdict: "done", reasons: ["branch deleted on remote (PR likely merged)"] };
	if (r.empty) return { verdict: "empty", reasons: [`no commits beyond ${base ?? "base"}`] };

	const reasons: string[] = [];
	if (pr) reasons.push(`${pr.state === "DRAFT" ? "draft " : ""}PR #${pr.number} open`);
	else reasons.push(r.gone ? "branch deleted on remote" : "pushed, no PR");
	if (r.behind > 0) reasons.push(`${r.behind} behind remote`);
	return { verdict: "progress", reasons };
}

export interface Listing {
	rows: Row[];
	/** Branch "merged" is measured against, e.g. `origin/main`. */
	base?: string;
	mainRoot: string;
}

export const isRemovable = (r: Row) => !r.main && !r.here && !r.active && !r.locked;
/** Safe to remove without losing anything, and its work is finished. */
export const isDone = (r: Row) => isRemovable(r) && assess(r).verdict === "done";

export function rowName(r: Row): string {
	return r.branch ?? (r.head ? `(detached ${r.head.slice(0, 9)})` : "(detached)");
}

const real = (p: string) => {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
};

/**
 * Everything that is cheap to get (a handful of git calls, independent of the
 * number of worktrees). Uncommitted-change counts come later via `fillChanges`.
 */
export async function collect(mainRoot: string, repoRoot: string, activePath?: string): Promise<Listing> {
	const [entries, branches, descriptions, base] = await Promise.all([
		listWorktrees(mainRoot),
		listBranches(mainRoot),
		branchDescriptions(mainRoot),
		defaultBaseRef(mainRoot),
	]);
	const merged = base ? await mergedInto(base, mainRoot) : new Set<string>();
	const here = real(repoRoot);
	const active = activePath ? real(activePath) : undefined;
	const rows = await Promise.all(
		entries.map(async (w, i): Promise<Row> => {
			const missing = w.prunable || !fs.existsSync(w.path);
			const b = w.branch ? branches.get(w.branch) : undefined;
			const isBase = !!w.branch && !!base && (base === w.branch || base.endsWith(`/${w.branch}`));
			const contained = !!w.branch && !isBase && i !== 0 && merged.has(w.branch);
			const pushed = !!b?.upstream;
			const head = !w.branch && !missing ? await headSummary(w.path) : {};
			const p = real(w.path);
			return {
				path: w.path,
				branch: w.branch,
				head: w.head,
				main: i === 0,
				here: p === here,
				active: p === active,
				locked: w.locked,
				missing,
				tip: b?.tip,
				upstream: b?.upstream,
				remoteBranch: b?.remoteBranch ?? w.branch,
				ahead: b?.ahead ?? 0,
				behind: b?.behind ?? 0,
				gone: b?.gone ?? false,
				merged: contained && pushed,
				empty: contained && !pushed,
				time: b?.time ?? head.time,
				subject: b?.subject ?? head.subject,
				description: w.branch ? descriptions.get(w.branch) : undefined,
				changes: missing ? 0 : undefined,
			};
		}),
	);
	rows.sort((a, b) => Number(b.main) - Number(a.main) || (b.time ?? 0) - (a.time ?? 0));
	return { rows, base, mainRoot };
}

/** Count uncommitted changes, a few worktrees at a time, calling `onRow` as each one lands. */
export async function fillChanges(
	rows: Row[],
	onRow: (r: Row) => void = () => {},
	isCancelled: () => boolean = () => false,
	concurrency = 6,
): Promise<void> {
	const queue = rows.filter((r) => r.changes === undefined);
	const worker = async () => {
		for (let r = queue.shift(); r && !isCancelled(); r = queue.shift()) {
			r.changes = (await countChanges(r.path)) ?? 0;
			if (!isCancelled()) onRow(r);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

/** Look up PRs with `gh` (if available) and mark local commits that never made it into a finished PR. */
export async function fillPrs(l: Listing, onDone: () => void = () => {}): Promise<boolean> {
	const rows = l.rows.filter((r) => r.remoteBranch && !r.missing);
	const prs = await fetchPrs(
		l.mainRoot,
		rows.map((r) => r.remoteBranch as string),
	);
	for (const r of rows) {
		const pr = prs.get(r.remoteBranch as string);
		if (!pr) continue;
		r.pr = pr;
		if ((pr.state === "MERGED" || pr.state === "CLOSED") && r.tip && r.tip !== pr.headOid) {
			// 0: local tip is inside the PR (fine). 1: local has commits on top. 128: PR head not
			// fetched locally, so it can't be verified; treat it as different to be safe.
			const res = await git(["merge-base", "--is-ancestor", r.tip, pr.headOid], l.mainRoot);
			r.afterPr = res.code !== 0;
		}
	}
	onDone();
	return prs.size > 0;
}

export interface RemoveResult {
	row: Row;
	ok: boolean;
	message: string;
}

/**
 * Remove worktrees (and optionally their branches). Branches that are merged or
 * whose upstream is gone are deleted with `-D` (squash merges are not
 * ancestors); others with `-d`, so unmerged work is kept.
 */
export async function removeRows(
	rows: Row[],
	mainRoot: string,
	opts: { deleteBranches: boolean; force: boolean },
): Promise<RemoveResult[]> {
	const results: RemoveResult[] = [];
	for (const row of rows) {
		if (!isRemovable(row)) {
			results.push({ row, ok: false, message: "skipped (main, current, active or locked)" });
			continue;
		}
		const force = opts.force || row.missing;
		const rm = await git(["worktree", "remove", ...(force ? ["--force"] : []), row.path], mainRoot, 120_000);
		if (rm.code !== 0) {
			results.push({ row, ok: false, message: (rm.stderr || rm.stdout).trim().split("\n")[0] ?? "failed" });
			continue;
		}
		let message = "worktree removed";
		if (opts.deleteBranches && row.branch) {
			// Squash/rebase merges are not ancestors of the base, so finished branches need -D.
			const v = assess(row).verdict;
			const flag = v === "done" || v === "empty" ? "-D" : "-d";
			const del = await git(["branch", flag, row.branch], mainRoot);
			message += del.code === 0 ? ", branch deleted" : ", branch kept (not fully merged)";
		}
		results.push({ row, ok: true, message });
	}
	if (rows.some((r) => r.missing)) await git(["worktree", "prune"], mainRoot);
	return results;
}

export function tildify(p: string, home = os.homedir()): string {
	return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

export function relativeTime(seconds: number, now = Date.now()): string {
	const s = Math.max(0, Math.round(now / 1000 - seconds));
	const units: [number, string][] = [
		[365 * 86400, "y"],
		[30 * 86400, "mo"],
		[7 * 86400, "w"],
		[86400, "d"],
		[3600, "h"],
		[60, "m"],
	];
	for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
	return "just now";
}

export type Tone = "accent" | "success" | "warning" | "error" | "muted" | "dim";
export interface Badge {
	text: string;
	tone: Tone;
}

export const VERDICT_LABEL: Record<Verdict, Badge> = {
	done: { text: "🗑 done", tone: "success" },
	empty: { text: "○ empty", tone: "muted" },
	progress: { text: "● in progress", tone: "accent" },
	unsaved: { text: "⚠ unsaved work", tone: "error" },
	pending: { text: "… checking", tone: "dim" },
};

export function prBadge(pr: PrInfo): Badge {
	const tone: Tone = pr.state === "MERGED" ? "success" : pr.state === "OPEN" ? "accent" : "muted";
	return { text: `#${pr.number} ${pr.state.toLowerCase()}`, tone };
}

export function tags(r: Row): Badge[] {
	const out: Badge[] = [];
	if (r.active) out.push({ text: "▶ active", tone: "success" });
	if (r.main) out.push({ text: "main", tone: "accent" });
	if (r.here && !r.active) out.push({ text: "here", tone: "accent" });
	if (r.locked) out.push({ text: "🔒 locked", tone: "warning" });
	return out;
}

/** Plain-text rendering (non-interactive modes). */
export function formatList(l: Listing, now = Date.now()): string {
	const done = l.rows.filter(isDone).length;
	const head = `🌿 ${l.rows.length} worktree${l.rows.length === 1 ? "" : "s"} of ${tildify(l.mainRoot)}${done ? ` · ${done} done (safe to remove)` : ""}`;
	const blocks = l.rows.map((r) => {
		const t = tags(r);
		const a = assess(r, l.base);
		const verdict = r.main && a.verdict === "progress" ? "" : VERDICT_LABEL[a.verdict].text;
		const why = [verdict, ...a.reasons].filter(Boolean).join(" · ");
		const lines = [`${r.active ? "▶" : "•"} ${rowName(r)}${t.length ? `  [${t.map((b) => b.text).join(", ")}]` : ""}`];
		if (why) lines.push(`    ${why}`);
		const what = r.description ? `“${r.description.split("\n")[0]}”` : (r.pr?.title ?? r.subject);
		if (what) lines.push(`    ${r.time ? `${relativeTime(r.time, now)}: ` : ""}${what}`);
		lines.push(`    ${tildify(r.path)}`);
		return lines.join("\n");
	});
	return [head, ...blocks].join("\n\n");
}
