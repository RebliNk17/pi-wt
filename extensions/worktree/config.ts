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
	const merged = {
		...DEFAULT_CONFIG,
		...readJson(path.join(agentDir(), "worktree.json")),
		...readJson(path.join(mainRoot, ".pi", "worktree.json")),
	};
	return {
		root: typeof merged.root === "string" && merged.root ? merged.root : DEFAULT_CONFIG.root,
		branchPrefix: typeof merged.branchPrefix === "string" ? merged.branchPrefix : "",
		copy: Array.isArray(merged.copy) ? merged.copy.filter((p) => typeof p === "string") : [],
		setup: typeof merged.setup === "string" && merged.setup.trim() ? merged.setup : undefined,
		policy: merged.policy === "on-request" ? "on-request" : "auto",
	};
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
