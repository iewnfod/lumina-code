/**
 * Sidebar grouping logic (pure) — mapping the flat session list into the
 * folder buckets the sidebar renders. Extracted from SessionBar.tsx so
 * the reduction is node-testable.
 */

export interface SessionInfo {
    id: string;
    name: string;
    /** Working directory the session lives in — tabs group under it. */
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

/** Sessions bucketed by working directory, folders in order of each
 *  folder's most recently updated session (the server's list order). */
export function groupByDirectory(sessions: SessionInfo[]): [string, SessionInfo[]][] {
    const groups = new Map<string, SessionInfo[]>();
    for (const session of sessions) {
        const key = session.directory ?? "";
        const bucket = groups.get(key);
        if (bucket) bucket.push(session);
        else groups.set(key, [session]);
    }
    return Array.from(groups.entries());
}
