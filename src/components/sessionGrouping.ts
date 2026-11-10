/**
 * Sidebar grouping logic (pure) — mapping the flat session list into the
 * folder buckets the sidebar renders. Extracted from SessionBar.tsx so
 * the reduction is node-testable.
 */

import {type WorktreeDirs} from "../opencode/worktreeSessions.ts";
import type {AppMode} from "../opencode/appMode.ts";

export interface SessionInfo {
    id: string;
    name: string;
    /** Working directory the session lives in — it groups under its
     * PROJECT directory (a branch worktree merges into its main repo). */
    directory?: string;
    /** Last update time (epoch ms) — rendered as a relative age. */
    updatedAt?: number;
    /** Which sidebar half the session belongs to (appMode.ts): the
     *  creation-time metadata stamp, derived by the App mapping. */
    mode: AppMode;
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

/** PINNED-FIRST ordering within one folder: pinned sessions rise to
 * the top (stable among themselves and among the rest — the server's
 * recency order is preserved within each half). Pinned rows also
 * bypass the folder's default reveal cap (the sidebar derives its
 * visible count from pinnedCount + cap). */
export function orderSessions(
    sessions: readonly SessionInfo[],
    pinned: ReadonlySet<string>,
): SessionInfo[] {
    const pinnedRows: SessionInfo[] = [];
    const rest: SessionInfo[] = [];
    for (const session of sessions) {
        (pinned.has(session.id) ? pinnedRows : rest).push(session);
    }
    return pinnedRows.length === 0 ? [...sessions] : [...pinnedRows, ...rest];
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

/** The sidebar's VISIBLE row order flattened to one list — exactly what
 *  SessionBar renders (renderGroups): the daily half's plain list runs
 *  straight through orderSessions; the dev half concatenates its
 *  groupByDirectory buckets, each pinned-first ordered inside. The
 *  next/prev session keyboard shortcut cycles THIS order so the jumps
 *  match what is on screen. */
export function flatSessionOrder(
    sessions: SessionInfo[],
    bindings: WorktreeDirs,
    pinned: ReadonlySet<string>,
    plain: boolean,
): SessionInfo[] {
    if (plain) return orderSessions(sessions, pinned);
    const flat: SessionInfo[] = [];
    for (const [, bucket] of groupByDirectory(sessions, bindings)) {
        flat.push(...orderSessions(bucket, pinned));
    }
    return flat;
}

/** The next (or previous) session id in a flat order, WRAPPING around
 *  the ends. A null active id lands on the first (direction 1) / last
 *  (direction -1) entry — the welcome screen's entry point. Empty
 *  order → null (nothing to switch to). */
export function cycleSessionId(
    order: readonly Pick<SessionInfo, "id">[],
    activeId: string | null,
    direction: 1 | -1,
): string | null {
    if (order.length === 0) return null;
    if (activeId === null) return order[direction === 1 ? 0 : order.length - 1].id;
    const index = order.findIndex((s) => s.id === activeId);
    if (index === -1) return order[direction === 1 ? 0 : order.length - 1].id;
    const next = (index + direction + order.length) % order.length;
    return order[next].id;
}
