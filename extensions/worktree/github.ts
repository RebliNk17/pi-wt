/**
 * Optional PR status via the GitHub CLI (`gh`). One GraphQL request for all
 * branches. Silently returns nothing when `gh` is missing, not logged in, or
 * the remote is not on GitHub.
 */

import { git, run } from "./git.ts";

export type PrState = "OPEN" | "DRAFT" | "MERGED" | "CLOSED";

export interface PrInfo {
	number: number;
	state: PrState;
	title: string;
	url: string;
	/** Commit the PR head pointed to (to tell whether local commits came after it). */
	headOid: string;
}

export interface GithubRemote {
	host: string;
	owner: string;
	name: string;
}

/** Parse `git@github.com:o/r.git`, `https://github.com/o/r`, `ssh://git@host/o/r.git`. */
export function parseRemote(url: string): GithubRemote | undefined {
	const m =
		/^(?:[\w.+-]+@)?([\w.-]+):(?!\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
		/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
	if (!m) return undefined;
	const [, host = "", owner = "", name = ""] = m;
	return host.includes("github") ? { host, owner, name } : undefined;
}

const gql = (s: string) => JSON.stringify(s);

/**
 * Latest PR per head branch name. Branches are matched by the remote branch
 * name they track (falls back to the local name).
 */
export async function fetchPrs(mainRoot: string, heads: string[], timeoutMs = 10_000): Promise<Map<string, PrInfo>> {
	const out = new Map<string, PrInfo>();
	const unique = [...new Set(heads)].filter(Boolean);
	if (!unique.length) return out;
	const url = await git(["remote", "get-url", "origin"], mainRoot);
	const remote = url.code === 0 ? parseRemote(url.stdout.trim()) : undefined;
	if (!remote) return out;

	const fields = "number state isDraft title url headRefOid";
	const parts = unique.map(
		(h, i) =>
			`b${i}: pullRequests(headRefName: ${gql(h)}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${fields} } }`,
	);
	const query = `query { repository(owner: ${gql(remote.owner)}, name: ${gql(remote.name)}) { ${parts.join(" ")} } }`;
	const r = await run("gh", ["api", "graphql", "--hostname", remote.host, "-f", `query=${query}`], mainRoot, timeoutMs);
	if (r.code !== 0) return out;
	try {
		const repo = JSON.parse(r.stdout)?.data?.repository ?? {};
		unique.forEach((h, i) => {
			const n = repo[`b${i}`]?.nodes?.[0];
			if (!n) return;
			const state: PrState = n.state === "OPEN" && n.isDraft ? "DRAFT" : n.state;
			out.set(h, { number: n.number, state, title: n.title, url: n.url, headOid: n.headRefOid });
		});
	} catch {
		// ignore malformed output
	}
	return out;
}
