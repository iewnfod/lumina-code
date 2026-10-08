import {useEffect, useSyncExternalStore} from "react";
import {debug as logDebug, error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import {useConnection} from "./connectionContext.tsx";
import {worktreeBindingOf} from "./worktreeSessions.ts";
import {probeWorktreeDrift, syncWorktreeToBranch} from "./worktreeSync.ts";
import type {WorktreeDriftSnapshot, WorktreeSyncOutcome, WorktreeSyncTarget} from "./worktreeSync.ts";

/**
 * The worktree → local-branch write-back's STATEFUL half: a drift store
 * + sync action keyed by worktree DIRECTORY (the turnEdits module-store
 * pattern), over the pure runner in worktreeSync.ts.
 *
 * One entry per MANAGED worktree directory (worktreeSessions binding —
 * the branch truth), holding the drift snapshot (wt HEAD vs local
 * branch tip + dirty count), the syncing flag and the last sync's
 * outcome. Non-managed directories never get entries — the stats panel
 * section simply doesn't exist for them.
 *
 * Probes run through the server's shell API (4 spawned git commands —
 * see worktreeSync.probeWorktreeDrift), so they are event-driven, not
 * timed: mount (via the hook), stats-panel expand, the active session's
 * run end (busy→idle, wired by WorkspaceStatsCard), and every sync's
 * own re-probe. A sync in flight blocks re-entry and probes alike.
 */
export interface WorktreeSyncEntry {
    status: "loading" | "ready" | "error";
    /** The latest drift snapshot (null while loading / on error). */
    snapshot: WorktreeDriftSnapshot | null;
    /** A write-back is executing — the button's busy state. */
    syncing: boolean;
    /** The LAST completed sync's outcome (null before the first). */
    lastOutcome: WorktreeSyncOutcome | null;
}

interface InternalEntry extends WorktreeSyncEntry {
    /** Supersedes in-flight probes: only the latest one applies. */
    seq: number;
}

const entries = new Map<string, InternalEntry>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

function entryOf(directory: string): InternalEntry {
    let entry = entries.get(directory);
    if (!entry) {
        entry = {status: "loading", snapshot: null, syncing: false, lastOutcome: null, seq: 0};
        entries.set(directory, entry);
    }
    return entry;
}

function targetOf(directory: string): WorktreeSyncTarget | null {
    const binding = worktreeBindingOf(directory);
    return binding ? {worktreeDir: directory, branch: binding.branch, mainDir: binding.mainDir} : null;
}

/** Spawn the drift probe for one directory (force — re-reads even a
 * settled entry). No-op for unmanaged directories, while a sync runs,
 * and when a newer probe is already in flight. */
export function refreshWorktreeSync(api: OpencodeApi | null, directory: string | null): void {
    if (!api || !directory) return;
    if (!worktreeBindingOf(directory)) return;
    const entry = entryOf(directory);
    if (entry.syncing) return;

    const seq = entry.seq + 1;
    entry.seq = seq;
    const target = targetOf(directory);
    if (!target) return;
    if (entry.status !== "loading") {
        entry.status = "loading";
        emit();
    }
    probeWorktreeDrift(api, target, (message) => {
        logDebug(`worktree drift: ${message}`).catch(() => {});
    }).then((probe) => {
        if (entries.get(directory)?.seq !== seq) return;
        if (probe.kind === "ok") {
            entry.status = "ready";
            entry.snapshot = probe.snapshot;
        } else {
            logWarn(`Worktree drift probe failed for ${directory}: ${probe.message}`).catch(() => {});
            entry.status = "error";
            entry.snapshot = null;
        }
        emit();
    }).catch((e) => {
        if (entries.get(directory)?.seq !== seq) return;
        logWarn(`Worktree drift probe threw for ${directory}: ${e}`).catch(() => {});
        entry.status = "error";
        entry.snapshot = null;
        emit();
    });
}

/** Probe only when the directory has no entry yet (mounts). */
export function ensureWorktreeSync(api: OpencodeApi | null, directory: string | null): void {
    if (!api || !directory) return;
    if (!worktreeBindingOf(directory)) return;
    if (entries.has(directory)) return;
    refreshWorktreeSync(api, directory);
}

/** Run the write-back for one managed worktree directory. Resolves the
 * outcome (the store also keeps it as `lastOutcome` and re-probes the
 * drift afterwards). No-op returning null for unmanaged directories or
 * while one is already running. */
export async function syncWorktreeNow(
    api: OpencodeApi | null,
    directory: string | null,
): Promise<WorktreeSyncOutcome | null> {
    if (!api || !directory) return null;
    const target = targetOf(directory);
    if (!target) return null;
    const entry = entryOf(directory);
    if (entry.syncing) return null;

    entry.syncing = true;
    emit();
    const outcome = await syncWorktreeToBranch(api, target, (message) => {
        logDebug(`worktree sync: ${message}`).catch(() => {});
    });
    // The entry may have been replaced wholesale meanwhile; re-read.
    const current = entryOf(directory);
    current.syncing = false;
    current.lastOutcome = outcome;
    if (outcome.kind === "error") {
        logError(`Worktree sync failed for ${directory}: ${outcome.message}`).catch(() => {});
    } else if (outcome.kind === "diverged") {
        logWarn(`Worktree sync refused for ${directory}: branch diverged`).catch(() => {});
    } else {
        logInfo(
            `Worktree sync ${outcome.kind} for ${directory}` +
                (outcome.kind === "synced" ? ` (${outcome.commits} commits, ${outcome.files} files)` : ""),
        ).catch(() => {});
    }
    emit();
    refreshWorktreeSync(api, directory);
    return outcome;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

const NO_ENTRY: WorktreeSyncEntry = {
    status: "loading",
    snapshot: null,
    syncing: false,
    lastOutcome: null,
};

/** The drift + sync state for one directory (null/unmanaged reads as a
 * permanent loading state — callers simply don't render the section).
 * Mounting the hook probes the directory once. */
export function useWorktreeSyncOf(directory: string | null): WorktreeSyncEntry {
    const {api} = useConnection();
    useSyncExternalStore(
        subscribe,
        () => (directory !== null ? entries.get(directory) ?? null : null),
        () => null,
    );
    useEffect(() => {
        ensureWorktreeSync(api, directory);
    }, [api, directory]);
    return (directory !== null ? entries.get(directory) : null) ?? NO_ENTRY;
}
