/**
 * Pure path helpers: map paths that point at the main checkout into the
 * active worktree. No I/O here so it can be unit-tested.
 */

import * as os from "node:os";
import * as path from "node:path";

export interface PathMapping {
	/** Top-level of the checkout pi was started in (what the model "sees"). */
	repoRoot: string;
	/** Absolute path of the active worktree. */
	worktree: string;
	/** Effective working directory inside the worktree (mirrors pi's cwd). */
	cwd: string;
	/** Directories under repoRoot that must never be redirected (e.g. the worktrees root). */
	excluded: string[];
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function isWithin(target: string, dir: string): boolean {
	const rel = path.relative(dir, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function expandPath(input: string): string {
	let p = input.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** Map one path argument of a file tool into the worktree. */
export function mapPath(input: string, m: PathMapping): string {
	const p = expandPath(input);
	if (!path.isAbsolute(p)) return path.resolve(m.cwd, p);
	const abs = path.resolve(p);
	if (isWithin(abs, m.worktree)) return abs;
	if (m.excluded.some((dir) => isWithin(abs, dir))) return abs;
	if (isWithin(abs, m.repoRoot)) return path.join(m.worktree, path.relative(m.repoRoot, abs));
	return abs;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrite absolute references to the main checkout inside a shell command. */
export function rewriteCommand(command: string, m: PathMapping): string {
	const pattern = new RegExp(`${escapeRegExp(m.repoRoot)}(?=$|[/\\s'"\`;|&<>()])[^\\s'"\`;|&<>()]*`, "g");
	return command.replace(pattern, (match) => mapPath(match, m));
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Expand `~` and `{repo}` in the configured worktrees root, relative to the main repo. */
export function resolveRoot(template: string, mainRoot: string): string {
	const withRepo = template.replaceAll("{repo}", path.basename(mainRoot));
	const expanded = expandPath(withRepo);
	return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(mainRoot, expanded);
}

/** Turn free text into a safe worktree / branch name. */
export function slugify(name: string): string {
	return name
		.trim()
		.replace(/[^A-Za-z0-9._/-]+/g, "-")
		.replace(/\/{2,}/g, "/")
		.replace(/-{2,}/g, "-")
		.replace(/^[-./]+|[-./]+$/g, "")
		.slice(0, 80);
}

export function timestampName(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `wt-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
