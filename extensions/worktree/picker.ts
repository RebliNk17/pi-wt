/**
 * Interactive `/worktree list`: filter, multi-select and remove worktrees.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	decodeKittyPrintable,
	hyperlink,
	matchesKey,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	assess,
	type Badge,
	isDone,
	isRemovable,
	type Listing,
	prBadge,
	type Row,
	relativeTime,
	rowName,
	tags,
	tildify,
	VERDICT_LABEL,
	type Verdict,
} from "./list.ts";

export type View = "all" | "done" | "progress" | "unsaved";
const VIEWS: View[] = ["all", "done", "progress", "unsaved"];
const VIEW_LABEL: Record<View, string> = { all: "all", done: "done", progress: "in progress", unsaved: "unsaved" };
const IN_VIEW: Record<View, (v: Verdict, r: Row) => boolean> = {
	all: () => true,
	done: (v) => v === "done" || v === "empty",
	// The main checkout is never a cleanup candidate; keep it out of the filtered views.
	progress: (v, r) => v === "progress" && !r.main,
	unsaved: (v, r) => v === "unsaved" && !r.main,
};

export type PickerResult =
	| { action: "remove"; rows: Row[] }
	| { action: "enter"; row: Row }
	| { action: "create"; name: string }
	| { action: "close" };

export interface PickerOptions {
	/** "manage": select and remove (default). "switch": pick one to enter, or create a new one. */
	mode?: "manage" | "switch";
	view?: View;
	filter?: string;
	/** Pre-select "done" rows once loading finishes. */
	autoSelectDone?: boolean;
}

/** Rows you can switch into: anything except the checkout this session runs in. */
export const isEnterable = (r: Row) => !r.here && !r.missing;

export class WorktreePicker implements Component {
	private listing: Listing;
	private tui: TUI;
	private theme: Theme;
	private done: (r: PickerResult) => void;
	private opts: PickerOptions;
	private view: View;
	private filter: string;
	private cursor = 0;
	private scroll = 0;
	private selected = new Set<string>();
	private touched = new Set<string>();
	private loading: string[] = [];
	private lines?: string[];
	private width?: number;

	constructor(listing: Listing, tui: TUI, theme: Theme, done: (r: PickerResult) => void, opts: PickerOptions = {}) {
		this.listing = listing;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.opts = opts;
		this.view = opts.view ?? "all";
		this.filter = opts.filter ?? "";
	}

	private placed = false;

	/** Re-render after async data arrived. `loading` lists what is still being fetched. */
	update(loading: string[] = this.loading): void {
		this.loading = loading;
		if (this.switching && !this.placed) {
			// Start on the first worktree you can actually switch to.
			const i = this.visible().findIndex((r) => isEnterable(r));
			if (i >= 0) this.cursor = i;
			this.placed = true;
		}
		if (this.opts.autoSelectDone && loading.length === 0) {
			for (const r of this.listing.rows) {
				if (this.touched.has(r.path)) continue;
				if (isDone(r)) this.selected.add(r.path);
				else this.selected.delete(r.path);
			}
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private verdict(r: Row): Verdict {
		return assess(r, this.listing.base).verdict;
	}

	private visible(): Row[] {
		const q = this.filter.toLowerCase().trim();
		return this.listing.rows.filter(
			(r) =>
				IN_VIEW[this.view](this.verdict(r), r) &&
				(!q ||
					[r.branch, r.path, r.subject, r.description, r.pr?.title, r.pr && `#${r.pr.number}`]
						.filter(Boolean)
						.some((s) => (s as string).toLowerCase().includes(q))),
		);
	}

	private toggle(r: Row | undefined, on?: boolean) {
		if (!r || !isRemovable(r)) return;
		this.touched.add(r.path);
		const next = on ?? !this.selected.has(r.path);
		if (next) this.selected.add(r.path);
		else this.selected.delete(r.path);
	}

	private get switching(): boolean {
		return this.opts.mode === "switch";
	}

	handleInput(data: string): void {
		const rows = this.visible();
		const page = this.pageSize();
		if (this.switching && matchesKey(data, "ctrl+n")) {
			this.done({ action: "create", name: this.filter.trim() });
			return;
		}
		if (this.switching && matchesKey(data, "enter")) {
			const current = rows[this.cursor];
			if (current && isEnterable(current)) this.done({ action: "enter", row: current });
			else if (!rows.length && this.filter.trim()) this.done({ action: "create", name: this.filter.trim() });
			return;
		}
		if (this.switching && (matchesKey(data, "space") || matchesKey(data, "ctrl+a"))) return;
		if (matchesKey(data, "ctrl+c") || (matchesKey(data, "escape") && !this.filter)) {
			this.done({ action: "close" });
			return;
		}
		if (matchesKey(data, "escape")) this.filter = "";
		else if (matchesKey(data, "up")) this.cursor = Math.max(0, this.cursor - 1);
		else if (matchesKey(data, "down")) this.cursor = Math.min(rows.length - 1, this.cursor + 1);
		else if (matchesKey(data, "pageUp")) this.cursor = Math.max(0, this.cursor - page);
		else if (matchesKey(data, "pageDown")) this.cursor = Math.min(rows.length - 1, this.cursor + page);
		else if (matchesKey(data, "home")) this.cursor = 0;
		else if (matchesKey(data, "end")) this.cursor = rows.length - 1;
		else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			const step = matchesKey(data, "tab") ? 1 : VIEWS.length - 1;
			this.view = VIEWS[(VIEWS.indexOf(this.view) + step) % VIEWS.length] ?? "all";
			this.cursor = 0;
		} else if (matchesKey(data, "space")) {
			this.toggle(rows[this.cursor]);
			this.cursor = Math.min(rows.length - 1, this.cursor + 1);
		} else if (matchesKey(data, "ctrl+a")) {
			const done = rows.filter(isDone);
			const all = done.length > 0 && done.every((r) => this.selected.has(r.path));
			for (const r of done) this.toggle(r, !all);
		} else if (matchesKey(data, "enter")) {
			const chosen = this.listing.rows.filter((r) => this.selected.has(r.path));
			const current = rows[this.cursor];
			const target = chosen.length ? chosen : current && isRemovable(current) ? [current] : [];
			if (target.length) {
				this.done({ action: "remove", rows: target });
				return;
			}
		} else if (matchesKey(data, "backspace")) this.filter = this.filter.slice(0, -1);
		else if (matchesKey(data, "ctrl+u")) this.filter = "";
		else {
			const ch = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
			if (!ch) return;
			this.filter += ch;
			this.cursor = 0;
		}
		this.cursor = Math.max(0, Math.min(this.cursor, this.visible().length - 1));
		this.invalidate();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.lines = undefined;
	}

	private pageSize(): number {
		const rows = this.tui.terminal?.rows ?? 30;
		return Math.max(3, Math.floor((rows - 12) / 2));
	}

	private paint(b: Badge): string {
		return this.theme.fg(b.tone, b.text);
	}

	render(width: number): string[] {
		if (this.lines && this.width === width) return this.lines;
		const th = this.theme;
		const fit = (s: string) => truncateToWidth(s, width, "…");
		const sep = th.fg("dim", " · ");
		const all = this.listing.rows;
		const rows = this.visible();
		const out: string[] = [];

		// Header
		const count = (v: View) => all.filter((r) => IN_VIEW[v](this.verdict(r), r)).length;
		const heading = this.switching ? " 🌿 Switch to worktree " : " 🌿 Worktrees ";
		const title = `${th.fg("accent", th.bold(heading))}${th.fg("muted", tildify(this.listing.mainRoot))}`;
		const loading = this.loading.length ? th.fg("dim", `checking ${this.loading.join(" and ")}…`) : "";
		out.push(fit(th.fg("borderMuted", "─".repeat(width))));
		out.push(fit(`${title}  ${loading}`));

		// Tabs + filter
		const tabs = VIEWS.map((v) => {
			const label = ` ${VIEW_LABEL[v]} ${count(v)} `;
			return v === this.view ? th.style(label, { bg: "selectedBg", fg: "accent", bold: true }) : th.fg("muted", label);
		}).join(" ");
		const filter = this.filter
			? `${th.fg("accent", "filter:")} ${th.fg("text", this.filter)}${th.fg("accent", "▏")}`
			: th.fg("dim", "type to filter");
		out.push(fit(` ${tabs}   ${filter}`));
		out.push("");

		// Rows
		const page = this.pageSize();
		if (this.cursor < this.scroll) this.scroll = this.cursor;
		if (this.cursor >= this.scroll + page) this.scroll = this.cursor - page + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - page)));
		if (rows.length === 0)
			out.push(
				fit(
					this.switching && this.filter.trim()
						? `  ${th.fg("accent", "+")} ${th.fg("text", `press enter to create worktree "${this.filter.trim()}"`)}`
						: `  ${th.fg("muted", "No worktrees here.")}`,
				),
			);
		for (const [i, r] of rows.slice(this.scroll, this.scroll + page).entries()) {
			const isCursor = this.scroll + i === this.cursor;
			const sel = this.selected.has(r.path);
			const a = assess(r, this.listing.base);
			const pointer = isCursor ? th.fg("accent", "❯") : " ";
			const box = this.switching
				? isEnterable(r)
					? th.fg("muted", "›")
					: th.fg("dim", "·")
				: !isRemovable(r)
					? th.fg("dim", "·")
					: sel
						? th.fg("error", "◉")
						: th.fg("muted", "○");
			const name = isCursor ? th.fg("accent", th.bold(rowName(r))) : th.bold(th.fg("text", rowName(r)));
			const t = tags(r)
				.map((b) => this.paint(b))
				.join(" ");
			const showVerdict = !(r.main && a.verdict === "progress");
			const verdict = showVerdict ? this.paint(VERDICT_LABEL[a.verdict]) : "";
			const why = a.reasons.map((x) => th.fg("muted", x)).join(sep);
			const line1 = `${pointer} ${box} ${name}${t ? ` ${t}` : ""}  ${[verdict, why].filter(Boolean).join(sep)}`;

			const when = r.time ? th.fg("accent", relativeTime(r.time)) : "";
			const pr = r.pr ? hyperlink(this.paint(prBadge(r.pr)), r.pr.url) : "";
			const what = r.description
				? th.fg("customMessageLabel", `“${r.description.split("\n")[0]}”`)
				: th.fg("text", r.pr?.title ?? r.subject ?? "");
			const line2 = `      ${[when, pr, what, th.fg("dim", tildify(r.path))].filter(Boolean).join("  ")}`;
			const bg = (s: string) => (isCursor ? th.bg("selectedBg", truncateToWidth(s, width, "…", true)) : fit(s));
			out.push(bg(line1), bg(line2));
		}
		if (rows.length > page)
			out.push(
				fit(th.fg("dim", `  ${this.scroll + 1}-${Math.min(rows.length, this.scroll + page)} of ${rows.length}`)),
			);

		// Legend + keys
		out.push("");
		out.push(
			fit(
				` ${[
					`${this.paint(VERDICT_LABEL.done)} ${th.fg("dim", "finished, nothing lost")}`,
					`${this.paint(VERDICT_LABEL.empty)} ${th.fg("dim", "no commits of its own")}`,
					`${this.paint(VERDICT_LABEL.progress)} ${th.fg("dim", "pushed, not finished")}`,
					`${this.paint(VERDICT_LABEL.unsaved)} ${th.fg("dim", "only on this disk")}`,
				].join("   ")}`,
			),
		);
		const n = this.selected.size;
		const key = (k: string, label: string) => `${th.fg("accent", k)} ${th.fg("muted", label)}`;
		const keys = this.switching
			? [
					key("↑↓", "move"),
					key("enter", "switch"),
					key("ctrl+n", this.filter.trim() ? `new worktree "${this.filter.trim()}"` : "new worktree"),
					key("tab", "view"),
					key("esc", this.filter ? "clear filter" : "close"),
				]
			: undefined;
		out.push(
			fit(
				` ${(
					keys ?? [
						key("↑↓", "move"),
						key("space", "select"),
						key("ctrl+a", "select all done"),
						key("tab", "view"),
						key("enter", n ? th.fg("error", `remove ${n} selected`) : "remove"),
						key("esc", this.filter ? "clear filter" : "close"),
					]
				).join("  ")}`,
			),
		);
		out.push(fit(th.fg("borderMuted", "─".repeat(width))));
		this.lines = out;
		this.width = width;
		return out;
	}
}
