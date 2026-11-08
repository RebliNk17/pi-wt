import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Policy = "auto" | "on-request";

export interface WorktreeConfig {
	/** Where worktrees are created. Relative to the main repo root; supports `~` and `{repo}`. */
	root: string;
	/** Prefix for new branch names, e.g. "worktree-". */
	branchPrefix: string;
	/** Gitignore-style patterns of untracked files to copy into new worktrees (e.g. ".env*"). */
	copy: string[];
	/** Shell command run inside a new worktree after creation (e.g. "npm ci"). */
	setup?: string;
	/** `setup` comes from the repo's own `.pi/worktree.json`, so it needs the user's approval before it runs. */
	setupFromRepo?: boolean;
	/** "auto": the agent enters/exits worktrees on its own. "on-request": only when asked. */
	policy: Policy;
}

export const DEFAULT_CONFIG: WorktreeConfig = {
	root: ".worktrees",
	branchPrefix: "",
	copy: [],
	policy: "auto",
};

function readJson(file: string): Partial<WorktreeConfig> {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

/** Global `~/.pi/agent/worktree.json`, overridden by `<repo>/.pi/worktree.json`. */
export function loadConfig(mainRoot: string): WorktreeConfig {
	const repo = readJson(path.join(mainRoot, ".pi", "worktree.json"));
	const merged = { ...DEFAULT_CONFIG, ...readJson(path.join(agentDir(), "worktree.json")), ...repo };
	return {
		root: typeof merged.root === "string" && merged.root ? merged.root : DEFAULT_CONFIG.root,
		branchPrefix: typeof merged.branchPrefix === "string" ? merged.branchPrefix : "",
		copy: Array.isArray(merged.copy) ? merged.copy.filter((p) => typeof p === "string") : [],
		setup: typeof merged.setup === "string" && merged.setup.trim() ? merged.setup : undefined,
		setupFromRepo: typeof repo.setup === "string" && !!repo.setup.trim(),
		policy: merged.policy === "on-request" ? "on-request" : "auto",
	};
}

// Repo-provided setup commands the user allowed, per repo: { "<mainRoot>": ["npm ci", ...] }.
const approvalsFile = () => path.join(agentDir(), "worktree-approved.json");

export function isSetupApproved(mainRoot: string, command: string): boolean {
	const list = (readJson(approvalsFile()) as Record<string, unknown>)[mainRoot];
	return Array.isArray(list) && list.includes(command);
}

export function approveSetup(mainRoot: string, command: string): void {
	const all = readJson(approvalsFile()) as Record<string, unknown>;
	const list = Array.isArray(all[mainRoot]) ? (all[mainRoot] as unknown[]) : [];
	all[mainRoot] = [...list, command];
	fs.mkdirSync(path.dirname(approvalsFile()), { recursive: true });
	fs.writeFileSync(approvalsFile(), `${JSON.stringify(all, null, 2)}\n`);
}

/** Patterns from `.worktreeinclude` (same file Claude Code uses), if present. */
export function readWorktreeInclude(mainRoot: string): string[] {
	try {
		return fs
			.readFileSync(path.join(mainRoot, ".worktreeinclude"), "utf-8")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#"));
	} catch {
		return [];
	}
}
