import {useSyncExternalStore} from "react";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * Sidebar folders the user has COLLAPSED (the dev half's project groups,
 * keyed by directory path) — persisted across restarts over
 * lib/persistedStore.ts (the useSidebarWidth pattern: a module store read
 * by SessionBar, absence = all expanded, the fresh-install default).
 *
 * SessionBar is the only consumer: its folder-header toggles and the
 * active-session re-expand effect both write through setCollapsedFolders
 * (so a restored open session's folder un-collapses on load — the open
 * tab can't vanish, and the eq short-circuit keeps an unchanged set from
 * writing). Entries for directories that no longer group any session are
 * inert (no folder renders under them) and simply ride along — no
 * pruning pass.
 */

const store = createPersistedStore<ReadonlySet<string>>({
    key: "lumina-code:collapsed-folders",
    label: "collapsed sidebar folders",
    // Malformed storage (hand-edited file, partial JSON) degrades to the
    // default — all expanded — never throws.
    read: (raw) => {
        if (raw === null) return new Set<string>();
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) return new Set<string>();
            return new Set(parsed.filter((d): d is string => typeof d === "string"));
        } catch {
            return new Set<string>();
        }
    },
    // The empty set (nothing collapsed) persists as absence.
    write: (dirs) => (dirs.size === 0 ? null : JSON.stringify([...dirs])),
    // Set identity churns on every toggle; semantic equality is size +
    // membership both ways.
    eq: (a, b) => a.size === b.size && [...a].every((d) => b.has(d)),
});

/** The collapsed-folder set; consumed by SessionBar's dev grouping. */
export function useCollapsedFolders(): ReadonlySet<string> {
    return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Synchronous read for non-React sites (toggle's read-modify-write). */
export function getCollapsedFolders(): ReadonlySet<string> {
    return store.get();
}

/** Rewrite the collapsed set (folder toggle / active-session re-expand).
 * Never throws; persistence failures log while the value still updates. */
export function setCollapsedFolders(next: ReadonlySet<string>): void {
    store.set(next);
}
