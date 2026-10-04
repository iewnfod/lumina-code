/**
 * Pure git-branch parsing helpers for the branch-display chip and the
 * branch-bound (worktree) session feature. All wire behavior encoded here
 * was verified against the pinned server v2.0.11 (see api.ts's
 * vcs/worktree sections for the endpoint-level docs):
 *
 * - the server has NO "current branch" endpoint — `/api/vcs/branch` is a
 *   LIST with no current marker, so the current branch of a directory is
 *   read from the repo's own `.git/HEAD` file (fs/read);
 * - `/api/vcs/branch` lists local branches, the bare REMOTE NAMES
 *   ("origin") and remote branches ("origin/master") interleaved. The
 *   bare remote names are exactly the prefixes of the remote refs and are
 *   shaped away by {@link shapeBranchList} for a picker.
 */

/** What `.git/HEAD` says about a checkout. */
export type GitHeadInfo =
    | {kind: "branch"; name: string}
    | {kind: "detached"; sha: string};

/**
 * Parse the raw text of a `.git/HEAD` file. `ref: refs/heads/<name>` is a
 * normal branch checkout (names may contain slashes: `feature/x`); a bare
 * 40-hex object id is a detached HEAD; anything else (missing file, other
 * ref targets, worktree-metadata oddities) reads as null so callers hide
 * the branch UI instead of guessing.
 */
export function parseGitHead(text: string | null | undefined): GitHeadInfo | null {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (trimmed === "") return null;
    const prefix = "ref: refs/heads/";
    if (trimmed.startsWith(prefix)) {
        const name = trimmed.slice(prefix.length).trim();
        if (name === "" || name.includes("..")) return null;
        return {kind: "branch", name};
    }
    if (/^[0-9a-f]{40}$/i.test(trimmed)) {
        return {kind: "detached", sha: trimmed.toLowerCase()};
    }
    return null;
}

/** Abbreviated commit id for detached-HEAD display (`sha~7`). */
export function shortSha(sha: string): string {
    return sha.slice(0, 7);
}

export interface BranchList {
    /** Local branch names (`refs/heads/*`), sorted. */
    local: string[];
    /** Remote-tracking ref names (`origin/master`), sorted. */
    remote: string[];
}

/**
 * Shape a raw `/api/vcs/branch` list into local vs remote branches,
 * dropping the bare remote names. A bare entry like "origin" is a remote
 * NAME, not a branch: it is detectable purely structurally — some other
 * entry begins with `origin/` (live sample: `["master","origin",
 * "origin/master","cef","origin/cef"]`). Local branch names may themselves
 * contain slashes (`feature/x`), so the "/" split alone is NOT the
 * classifier; the prefix relation is. Deduped, each part sorted.
 */
export function shapeBranchList(entries: readonly string[]): BranchList {
    const names = [...new Set(entries.map((e) => e.trim()).filter((e) => e !== ""))];
    const remoteNames = new Set(
        names.filter((a) => names.some((b) => b.startsWith(a + "/"))),
    );
    const local = new Set<string>();
    const remote = new Set<string>();
    for (const name of names) {
        if (remoteNames.has(name)) continue;
        let matchedRemote = false;
        for (const r of remoteNames) {
            if (name.startsWith(r + "/")) {
                remote.add(name);
                matchedRemote = true;
                break;
            }
        }
        if (!matchedRemote) local.add(name);
    }
    return {
        local: [...local].sort(),
        remote: [...remote].sort(),
    };
}
