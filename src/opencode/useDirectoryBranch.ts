import {useEffect, useSyncExternalStore} from "react";
import {debug as logDebug} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import {parseGitHead, shortSha} from "./gitInfo.ts";
import {
    subscribeWorktreeDirs,
    worktreeBindingOf,
} from "./worktreeSessions.ts";

/**
 * The title bar's per-directory git branch, cached in a module-level store
 * keyed by directory (the useSessionActivity directory-map pattern) so a
 * same-directory session switch paints instantly and backgrounded
 * directories don't re-fetch.
 *
 * Resolution order:
 * 1. A MANAGED WORKTREE directory (worktreeSessions record) reads its
 *    binding's branch — authoritative, no fetch: the server checks
 *    worktrees out DETACHED at the branch tip, so their `.git/HEAD` is a
 *    sha and the record is the only branch truth.
 * 2. Otherwise the repo's own `.git/HEAD` through fs/read — the server
 *    has no current-branch endpoint (`/api/vcs/branch` is a markerless
 *    list). REPO ROOTS ONLY: a session in a repo subdirectory has no
 *    `.git/HEAD` next to it (404) and the chip honestly hides.
 *
 * The branch of a MAIN worktree can change under us (the user checks out
 * in their own terminal), so entries refresh on directory change AND on
 * window focus regain. Worktree bindings are immutable, so bound
 * directories never re-fetch — but a NEWLY recorded binding (a branch
 * session just created) re-resolves through the store subscription.
 */

interface BranchEntry {
    /** Display label (branch name or `sha~7`); null = no repo / unknown. */
    branch: string | null;
    loading: boolean;
    /** Guards in-flight requests: only the latest one applies. */
    seq: number;
}

const entries = new Map<string, BranchEntry>();
const listeners = new Set<() => void>();

function entryOf(directory: string): BranchEntry {
    let entry = entries.get(directory);
    if (!entry) {
        entry = {branch: null, loading: false, seq: 0};
        entries.set(directory, entry);
    }
    return entry;
}

function notify() {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function snapshot(): ReadonlyMap<string, BranchEntry> {
    return entries;
}

/** Resolve one directory's branch into the store (idempotent; safe to
 *  call per render — an in-flight or settled entry is left alone). */
export function ensureDirectoryBranch(api: OpencodeApi, directory: string): void {
    const entry = entryOf(directory);
    if (entry.loading) return;

    // Managed worktree: the binding IS the branch (detached HEAD).
    const binding = worktreeBindingOf(directory);
    if (binding) {
        if (entry.branch !== binding.branch) {
            entry.branch = binding.branch;
            notify();
        }
        return;
    }

    const seq = entry.seq + 1;
    entry.seq = seq;
    entry.loading = true;
    notify();
    api.readTextFile(directory, ".git/HEAD")
        .then((text) => {
            if (entry.seq !== seq) return;
            const info = parseGitHead(text);
            const branch = info === null ? null
                : info.kind === "branch" ? info.name
                : shortSha(info.sha);
            if (entry.branch !== branch || entry.loading) {
                entry.branch = branch;
                entry.loading = false;
                notify();
            }
        })
        .catch((e) => {
            if (entry.seq !== seq) return;
            // Read failures (500 on odd paths, transport drops) read as
            // "unknown" — the chip hides rather than guessing.
            logDebug(`Branch probe failed for ${directory}: ${e}`).catch(() => {});
            if (entry.branch !== null || entry.loading) {
                entry.branch = null;
                entry.loading = false;
                notify();
            }
        });
}

/** Force a re-resolve (focus regain): clears the in-flight guard so the
 *  fetch runs even for a settled main-worktree entry. */
function refreshDirectoryBranch(api: OpencodeApi, directory: string): void {
    if (worktreeBindingOf(directory)) {
        ensureDirectoryBranch(api, directory);
        return;
    }
    const entry = entryOf(directory);
    if (entry.loading) return;
    entry.seq = entry.seq + 1; // supersedes any settled value
    entry.loading = false;
    ensureDirectoryBranch(api, directory);
}

/** The directory's branch label (null = hide the chip). Loads on mount /
 *  directory change; refreshes on window focus and on worktree-record
 *  changes. */
export function useDirectoryBranch(
    api: OpencodeApi | null,
    directory: string | null,
): string | null {
    useSyncExternalStore(subscribe, snapshot);

    useEffect(() => {
        if (!api || !directory) return;
        ensureDirectoryBranch(api, directory);
        // New bindings (a branch session just created) re-resolve; the
        // subscription also fires the useSyncExternalStore above.
        const onBindings = () => ensureDirectoryBranch(api, directory);
        const unsubscribe = subscribeWorktreeDirs(onBindings);
        const onFocus = () => refreshDirectoryBranch(api, directory);
        window.addEventListener("focus", onFocus);
        return () => {
            unsubscribe();
            window.removeEventListener("focus", onFocus);
        };
    }, [api, directory]);

    return directory ? entries.get(directory)?.branch ?? null : null;
}
