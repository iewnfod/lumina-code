import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api/index.ts";
import {createKeyedStore, createListeners} from "../lib/moduleStore.ts";

/**
 * The SESSION-SHELLS store — one entry per session holding the live
 * RUNNING shell id set (server truth + the shell bus) plus the
 * message-watcher freshness fields the diff store's re-pull keys on.
 * The wiring layer (useSessionActivity.ts) connects it to the bus; the
 * hooks live there too.
 */

/** One session's cached activity state (running shells + freshness watch). */
export interface SessionActivityEntry {
    /** Live RUNNING shell ids (server truth + bus). */
    runningShellIds: ReadonlySet<string>;
    /** Directory the location-scoped endpoints are addressed with. */
    directory: string | null;
    /** Mutation signature last seen, plus the messages it was computed
     *  on (identity cache — the message store notifies per change). */
    signature: string;
    signatureMessages: readonly unknown[] | null;
    /** listShells seeded at least once (prefetch guards on this). */
    shellsSeeded: boolean;
}

export const EMPTY_SHELLS: ReadonlySet<string> = new Set();
const sessions = createKeyedStore<string, SessionActivityEntry>(() => ({
    runningShellIds: EMPTY_SHELLS,
    directory: null,
    signature: "",
    signatureMessages: null,
    shellsSeeded: false,
}));

export const shellBus = createListeners();

export function notifyShellChange() {
    shellBus.notify();
}

let apiSingleton: OpencodeApi | null = null;

/** The wiring layer installs the current api handle (an identity change
 *  is a reconnect — requests must go through the CURRENT client). */
export function setShellsApi(api: OpencodeApi | null): void {
    apiSingleton = api;
}

export function sessionEntryOf(sessionId: string): SessionActivityEntry {
    return sessions.entryOf(sessionId);
}

export function peekSessionEntry(sessionId: string): SessionActivityEntry | undefined {
    return sessions.peek(sessionId);
}

export function deleteSessionEntry(sessionId: string): void {
    sessions.delete(sessionId);
}

export function snapshotSessionEntries(): IterableIterator<[string, SessionActivityEntry]> {
    return sessions.snapshot().entries();
}

/** Seed the running set from the server's live shell list (activation and
 *  once per prefetch). Location-scoped — the entry's directory rides along. */
export function seedRunningShells(sessionId: string): void {
    const api = apiSingleton;
    const entry = sessions.peek(sessionId);
    if (!api || !entry) return;
    entry.shellsSeeded = true;
    api.listShells(entry.directory).then((list) => {
        const current = sessions.peek(sessionId);
        if (!current) return; // session dropped while the request was out
        current.runningShellIds = new Set(
            list
                .filter((s) => (s.metadata?.sessionID ?? undefined) === sessionId)
                .map((s) => s.id),
        );
        notifyShellChange();
    }).catch((e) => {
        logError(`Failed to load running shells: ${e}`).catch(() => {});
    });
}

/** Manually stop one shell (DELETE /api/shell/{id}). Optimistic: the id
 *  leaves the running set immediately — the server confirms via
 *  `shell.exited` and the completion notification message. A failed DELETE
 *  restores server truth (the optimistic flip must be undoable — §3.3). */
export function stopShell(sessionId: string, shellId: string): void {
    const api = apiSingleton;
    const entry = sessions.peek(sessionId);
    if (!api || !entry || !entry.runningShellIds.has(shellId)) return;
    entry.runningShellIds = new Set([...entry.runningShellIds].filter((id) => id !== shellId));
    notifyShellChange();
    const directory = entry.directory;
    api.removeShell(shellId, directory).then(() => {
        logInfo(`Terminal ${shellId} stopped`).catch(() => {});
    }).catch((e) => {
        logError(`Failed to stop terminal ${shellId}: ${e}`).catch(() => {});
        api.getShell(shellId, directory).then((shell) => {
            if (shell.status !== "running") return;
            const current = sessions.peek(sessionId);
            if (!current || current.runningShellIds.has(shellId)) return;
            current.runningShellIds = new Set([...current.runningShellIds, shellId]);
            notifyShellChange();
        }).catch((e2) => {
            logError(`Failed to re-read terminal ${shellId} after a failed stop: ${e2}`).catch(() => {});
        });
    });
}
