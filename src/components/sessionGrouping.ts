/**
 * Sidebar grouping logic (pure) — mapping the flat session list into the
 * folder buckets the sidebar renders. Extracted from SessionBar.tsx so
 * the reduction is node-testable.
 */

import {type WorktreeDirs} from "../opencode/worktreeSessions.ts";

export interface SessionInfo {
    id: string;
    name: string;
    /** Working directory the session lives in — it groups under its
     * PROJECT directory (a branch worktree merges into its main repo). */
    directory?: string;
    /** Last update time (epoch ms) — rendered as a relative age. */
    updatedAt?: number;
}

/** Compact relative age: "now", "5m", "3h", "2d" — locale-neutral units. */
export function relativeAge(updatedAt: number, now: number): string {
    const diff = Math.max(0, now - updatedAt);
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

/** The PROJECT directory a working directory belongs to: a MANAGED
 * branch worktree maps to its main repo — the sidebar distinguishes by
 * PROJECT, never by branch, so the worktree's own codename path
 * (".../worktree/abc123/lucky-lagoon") must not fork a second block;
 * anything else is itself, and no directory is "". */
export function projectDirOf(
    directory: string | null | undefined,
    bindings: WorktreeDirs,
): string {
    if (!directory) return "";
    return bindings[directory]?.mainDir ?? directory;
}

/** Sessions bucketed by PROJECT directory (branch-worktree sessions
 * merge into their main repo's group), folders in order of each
 * folder's most recently updated session (the server's list order). */
export function groupByDirectory(
    sessions: SessionInfo[],
    bindings: WorktreeDirs,
): [string, SessionInfo[]][] {
    const groups = new Map<string, SessionInfo[]>();
    for (const session of sessions) {
        const key = projectDirOf(session.directory, bindings);
        const bucket = groups.get(key);
        if (bucket) bucket.push(session);
        else groups.set(key, [session]);
    }
    return Array.from(groups.entries());
}
