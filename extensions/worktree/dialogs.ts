/**
 * `/worktree list` for hosts that can't show terminal components but do have
 * dialogs (pi-gui, RPC clients). Everything is single-line text, because these
 * hosts render titles, options and notifications without line breaks.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { run } from "./git.ts";
import {
	assess,
	isDone,
	isRemovable,
	type Listing,
	type Row,
	relativeTime,
	removeRows,
	rowName,
	tildify,
	VERDICT_LABEL,
	type Verdict,
} from "./list.ts";

const ORDER: Record<Verdict, number> = { done: 0, empty: 1, unsaved: 2, progress: 3, pending: 4 };
const BACK = "← Back";
const CLOSE = "Close";

function clip(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function summary(l: Listing): string {
	const n = (v: Verdict[]) => l.rows.filter((r) => v.includes(assess(r, l.base).verdict)).length;
	return [
		`${l.rows.length} worktrees`,
		n(["done"]) && `${n(["done"])} done`,
		n(["empty"]) && `${n(["empty"])} empty`,
		n(["progress"]) && `${n(["progress"])} in progress`,
		n(["unsaved"]) && `${n(["unsaved"])} with unsaved work`,
	]
		.filter(Boolean)
		.join(" · ");
}

function optionLabel(r: Row, base?: string): string {
	const a = assess(r, base);
	const icon = r.main ? "⌂" : (VERDICT_LABEL[a.verdict].text.split(" ")[0] ?? "");
	const why = a.reasons[0] ?? (r.main ? "main checkout" : "");
	const when = r.time ? relativeTime(r.time) : "";
	return [`${icon} ${clip(rowName(r), 60)}`, why, when].filter(Boolean).join("  ·  ");
}

async function openUrl(url: string, cwd: string) {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	await run(cmd, [url], cwd, 10_000);
}

async function remove(ctx: ExtensionContext, rows: Row[], mainRoot: string, deleteBranches: boolean) {
	const force = rows.some((r) => (r.changes ?? 0) > 0);
	const results = await removeRows(rows, mainRoot, { deleteBranches, force });
	const ok = results.filter((x) => x.ok);
	const failed = results.filter((x) => !x.ok);
	const one = ok.length === 1;
	const what = `${one ? "1 worktree" : `${ok.length} worktrees`}${deleteBranches ? (one ? " and its branch" : " and their branches") : ""}`;
	const fails = failed.map((x) => `${rowName(x.row)} (${x.message})`).join(", ");
	ctx.ui.notify(
		failed.length ? `🗑 Removed ${what} · failed: ${fails}` : `🗑 Removed ${what}`,
		failed.length ? "warning" : "info",
	);
	const removed = new Set(ok.map((x) => x.row.path));
	return removed;
}

/** One worktree: show what it is and offer actions. Resolves to the paths removed. */
async function details(ctx: ExtensionContext, r: Row, l: Listing): Promise<Set<string>> {
	for (;;) {
		const a = assess(r, l.base);
		const head = [
			rowName(r),
			VERDICT_LABEL[a.verdict].text,
			...a.reasons,
			r.time && relativeTime(r.time),
			tildify(r.path),
		]
			.filter(Boolean)
			.join("  ·  ");
		const opts: string[] = [];
		const RM_BOTH = r.branch ? "🗑 Remove worktree and branch" : "🗑 Remove worktree";
		const RM_WT = "🗑 Remove worktree, keep branch";
		const PR = r.pr ? `↗ Open PR #${r.pr.number} (${r.pr.state.toLowerCase()})` : "";
		if (isRemovable(r)) opts.push(RM_BOTH, ...(r.branch ? [RM_WT] : []));
		if (PR) opts.push(PR);
		opts.push(BACK);
		const choice = await ctx.ui.select(head, opts);
		if (!choice || choice === BACK) return new Set();
		if (choice === PR && r.pr) {
			await openUrl(r.pr.url, l.mainRoot);
			continue;
		}
		if (choice === RM_BOTH || choice === RM_WT) {
			if (a.verdict === "unsaved" || a.verdict === "pending") {
				const ok = await ctx.ui.confirm(
					`Remove ${rowName(r)}?`,
					`It has ${a.reasons.join(", ") || "work that was not checked yet"}. Removing it loses that work.`,
				);
				if (!ok) continue;
			}
			return remove(ctx, [r], l.mainRoot, choice === RM_BOTH);
		}
	}
}

/** `/worktree clean` with dialogs: confirm and remove every finished worktree. */
export async function dialogClean(ctx: ExtensionContext, l: Listing): Promise<void> {
	const done = l.rows.filter(isDone);
	if (!done.length) {
		ctx.ui.notify("🌿 Nothing to clean: no finished worktrees.", "info");
		return;
	}
	const names = done.map((r) => rowName(r)).join(", ");
	const BOTH = "Remove worktrees and their branches";
	const WT = "Remove worktrees, keep branches";
	const how = await ctx.ui.select(`🗑 Remove ${done.length} done worktree${done.length === 1 ? "" : "s"}: ${names}`, [
		BOTH,
		WT,
		"Cancel",
	]);
	if (how === BOTH || how === WT) await remove(ctx, done, l.mainRoot, how === BOTH);
}

/** Dialog-driven browser: pick a worktree to see actions, or remove all finished ones at once. */
export async function dialogList(ctx: ExtensionContext, l: Listing): Promise<void> {
	for (;;) {
		const rows = [...l.rows].sort(
			(a, b) =>
				Number(b.main) - Number(a.main) ||
				ORDER[assess(a, l.base).verdict] - ORDER[assess(b, l.base).verdict] ||
				(b.time ?? 0) - (a.time ?? 0),
		);
		const done = rows.filter(isDone);
		const ALL =
			done.length === 1
				? `🗑 Remove the done worktree (${rowName(done[0] as Row)})`
				: done.length
					? `🗑 Remove all ${done.length} done worktrees`
					: "";
		const byLabel = new Map<string, Row>();
		for (const r of rows) {
			let label = optionLabel(r, l.base);
			while (byLabel.has(label)) label += " ";
			byLabel.set(label, r);
		}
		const options = [...(ALL ? [ALL] : []), ...byLabel.keys(), CLOSE];
		const choice = await ctx.ui.select(`🌿 ${summary(l)}`, options);
		if (!choice || choice === CLOSE) return;

		let removed = new Set<string>();
		if (choice === ALL) {
			const BOTH = "Remove worktrees and their branches";
			const WT = "Remove worktrees, keep branches";
			const how = await ctx.ui.select(`Remove ${done.length} done worktrees?`, [BOTH, WT, BACK]);
			if (how === BOTH || how === WT) removed = await remove(ctx, done, l.mainRoot, how === BOTH);
		} else {
			const r = byLabel.get(choice);
			if (r) removed = await details(ctx, r, l);
		}
		l.rows = l.rows.filter((r) => !removed.has(r.path));
		if (!l.rows.some((r) => !r.main)) return;
	}
}

export type SwitchPick = { action: "enter"; row: Row } | { action: "create"; name: string } | undefined;

/** Pick a worktree to switch to, or create a new one (pi-gui / RPC). */
export async function dialogSwitch(ctx: ExtensionContext, l: Listing): Promise<SwitchPick> {
	const rows = l.rows
		.filter((r) => !r.here && !r.missing)
		.sort((a, b) => Number(b.main) - Number(a.main) || (b.time ?? 0) - (a.time ?? 0));
	const NEW = "+ New worktree…";
	const byLabel = new Map<string, Row>();
	for (const r of rows) {
		let label = optionLabel(r, l.base);
		while (byLabel.has(label)) label += " ";
		byLabel.set(label, r);
	}
	const choice = await ctx.ui.select("🌿 Switch to worktree", [NEW, ...byLabel.keys(), CLOSE]);
	if (!choice || choice === CLOSE) return undefined;
	if (choice === NEW) {
		const name = await ctx.ui.input("New worktree name", "leave empty for an automatic name");
		return name === undefined ? undefined : { action: "create", name: name.trim() };
	}
	const row = byLabel.get(choice);
	return row ? { action: "enter", row } : undefined;
}
