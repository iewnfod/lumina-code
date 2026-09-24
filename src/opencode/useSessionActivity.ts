import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import {debug as logDebug, error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {ChatMessage, WorkspaceDiffEntry} from "./types.ts";
import {peekSessionMessages, subscribeSessionMessages, useSessionMessagesSnapshot} from "./useSessionMessages.ts";
import {
    collectSessionShells,
    collectSessionSubagents,
    mutationSignature,
    type SessionShellRef,
    type SessionSubagentRef,
} from "./sessionActivity.ts";

/** Debounce for diff re-pulls while a burst of edits streams in. */
const DIFF_DEBOUNCE_MS = 800;

/**
 * Stats-card state, split by scope:
 *
 * - WORKSPACE DIFF (`GET /api/vcs/diff?mode=working` — HEAD vs the working
 *   copy of a directory, untracked files included): cached in a
 *   module-level store keyed by DIRECTORY. This replaced the per-session
 *   diff endpoint, which compares whole-worktree snapshot trees over the
 *   session's TIME WINDOW — any other session editing the same project
 *   leaked into it (sessions in one directory share one physical worktree
 *   and one snapshot repository), so an idle session would inherit a
 *   sibling's edits. The workspace diff is honest by construction, and all
 *   sessions in a directory share one cache entry — a same-directory
 *   session switch paints instantly with identical numbers.
 * - TERMINALS: the shell list comes from the session's own tool parts
 *   (`metadata.shellID`, background results only); "running" is the
 *   server's live shell list (`GET /api/shell`, running-only) seeded on
 *   activation and patched by the global shell.created/exited bus
 *   events. A completion notification message (collector: `finished`)
 *   always wins over the live set.
 * - SUBAGENTS: child ids from subagent tool parts; "running" is the app's
 *   busy set, which the execution events of child sessions already feed.
 *
 * The consumer is the stats card living OUTSIDE the session swap (App),
 * so the session-scoped hook reads the message store through a SNAPSHOT
 * binding instead of ChatView's messages — the card must not render the
 * previous session's terminals/subagents for a frame on a switch.
 */

/** One directory's cached workspace diff. */
interface DirectoryEntry {
    /** The directory the location-scoped request is addressed with. */
    directory: string | null;
    diff: WorkspaceDiffEntry[] | null;
    diffLoading: boolean;
    /** Guards in-flight requests: only the latest one applies. */
    seq: number;
    /** Debounced re-pull timer. */
    debounce: ReturnType<typeof setTimeout> | null;
}

/** One session's cached activity state (running shells + freshness watch). */
interface SessionEntry {
    /** Live RUNNING shell ids (server truth + bus). */
    runningShellIds: ReadonlySet<string>;
    /** Directory the location-scoped endpoints are addressed with. */
    directory: string | null;
    /** Mutation signature last seen, plus the messages it was computed
     *  on (identity cache — the message store notifies per change). */
    signature: string;
    signatureMessages: readonly ChatMessage[] | null;
    /** listShells seeded at least once (prefetch guards on this). */
    shellsSeeded: boolean;
}

const EMPTY_SHELLS: ReadonlySet<string> = new Set();
const directories = new Map<string, DirectoryEntry>();
const sessions = new Map<string, SessionEntry>();
const diffListeners = new Set<(key: string) => void>();
const shellListeners = new Set<() => void>();

function directoryKey(directory: string | null): string {
    return directory ?? "";
}

function directoryEntryOf(directory: string | null): DirectoryEntry {
    const key = directoryKey(directory);
    let entry = directories.get(key);
    if (!entry) {
        entry = {directory, diff: null, diffLoading: false, seq: 0, debounce: null};
        directories.set(key, entry);
    }
    return entry;
}

function sessionEntryOf(sessionId: string): SessionEntry {
    let entry = sessions.get(sessionId);
    if (!entry) {
        entry = {
            runningShellIds: EMPTY_SHELLS,
            directory: null,
            signature: "",
            signatureMessages: null,
            shellsSeeded: false,
        };
        sessions.set(sessionId, entry);
    }
    return entry;
}

function notifyDiff(directory: string | null) {
    const key = directoryKey(directory);
    for (const listener of diffListeners) listener(key);
}

function notifyShellChange() {
    for (const listener of shellListeners) listener();
}

/** Snapshot the workspace hook renders from (cached by reference — the
 *  downstream memos only see new identities when a value really moved). */
function diffSnapshotOf(directory: string | null): {
    diff: WorkspaceDiffEntry[] | null;
    diffLoading: boolean;
} {
    const entry = directories.get(directoryKey(directory));
    return {
        diff: entry?.diff ?? null,
        diffLoading: entry?.diffLoading ?? false,
    };
}

// --- Module wiring: api handle + one bus handler + one message watcher ---
let apiSingleton: OpencodeApi | null = null;
let busUnsubscribe: (() => void) | null = null;

/** Re-pull a directory's workspace diff when a tracked session's messages'
 *  mutation signature moved (edits landed — backgrounded sessions
 *  included, keeping their directory's numbers fresh). */
function watchSignature(sessionId: string) {
    const entry = sessions.get(sessionId);
    const messages = peekSessionMessages(sessionId);
    if (!entry || !messages || entry.signatureMessages === messages) return;
    const next = mutationSignature(messages);
    const seeded = entry.signatureMessages !== null;
    entry.signatureMessages = messages;
    if (!seeded) {
        entry.signature = next;
        return;
    }
    if (next === entry.signature) return;
    entry.signature = next;
    scheduleDiffLoad(entry.directory);
}

function scheduleDiffLoad(directory: string | null) {
    const entry = directories.get(directoryKey(directory));
    if (!entry) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
        entry.debounce = null;
        void loadWorkspaceDiff(directory);
    }, DIFF_DEBOUNCE_MS);
}

async function loadWorkspaceDiff(directory: string | null): Promise<void> {
    const api = apiSingleton;
    const entry = directories.get(directoryKey(directory));
    if (!api || !entry) return;
    const seq = ++entry.seq;
    entry.diffLoading = true;
    notifyDiff(directory);
    try {
        const list = await api.vcsDiff(directory);
        if (seq !== entry.seq) return;
        entry.diff = list;
    } catch (e) {
        if (seq !== entry.seq) return;
        const msg = String(e);
        if (/503|service/i.test(msg)) {
            // The directory has no VCS (not a git repo): no Changes
            // section there — expected, not worth a warn.
            logDebug(`No VCS behind the workspace diff: ${msg}`).catch(() => {});
            entry.diff = [];
        } else {
            logError(`Failed to load workspace diff: ${msg}`).catch(() => {});
        }
    } finally {
        if (seq === entry.seq) {
            entry.diffLoading = false;
            notifyDiff(directory);
        }
    }
}

/** Seed the running set from the server's live shell list (activation and
 *  once per prefetch). Location-scoped — the entry's directory rides along. */
function seedRunningShells(sessionId: string): void {
    const api = apiSingleton;
    const entry = sessions.get(sessionId);
    if (!api || !entry) return;
    entry.shellsSeeded = true;
    api.listShells(entry.directory).then((list) => {
        const current = sessions.get(sessionId);
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
function stopShell(sessionId: string, shellId: string): void {
    const api = apiSingleton;
    const entry = sessions.get(sessionId);
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
            const current = sessions.get(sessionId);
            if (!current || current.runningShellIds.has(shellId)) return;
            current.runningShellIds = new Set([...current.runningShellIds, shellId]);
            notifyShellChange();
        }).catch((e2) => {
            logError(`Failed to re-read terminal ${shellId} after a failed stop: ${e2}`).catch(() => {});
        });
    });
}

/** Install the api handle + the global bus handler + the message watcher
 *  (once per app run; `subscribe` is stable). */
function ensureWiring(
    api: OpencodeApi,
    subscribe: (handler: OpencodeEventHandler) => () => void,
): void {
    apiSingleton = api;
    if (busUnsubscribe) return;
    busUnsubscribe = subscribe((event) => {
        if (event.type === "session.deleted") {
            sessions.delete((event.data as {sessionID?: string} | null)?.sessionID ?? "");
            return;
        }
        if (event.type === "shell.created") {
            const info = (event.data as {info?: {id?: string; metadata?: Record<string, unknown>} | null}).info;
            const sid = info?.id ? (info.metadata?.sessionID ?? undefined) : undefined;
            const id = info?.id;
            if (typeof sid !== "string" || !id) return;
            const entry = sessions.get(sid);
            if (!entry || entry.runningShellIds.has(id)) return;
            entry.runningShellIds = new Set([...entry.runningShellIds, id]);
            notifyShellChange();
        } else if (event.type === "shell.exited") {
            const {id} = event.data as {id?: string};
            if (!id) return;
            for (const entry of sessions.values()) {
                if (!entry.runningShellIds.has(id)) continue;
                entry.runningShellIds = new Set([...entry.runningShellIds].filter((x) => x !== id));
                notifyShellChange();
            }
        }
    });
    // Module-lifetime wiring (never torn down — the busUnsubscribe
    // guard above owns the once-per-run semantics).
    subscribeSessionMessages((sessionId) => watchSignature(sessionId));
}

/**
 * Hover prefetch: warm a session's activity before it is opened, so even
 * a first switch-in this app run paints the stats card from cache. Cheap
 * and idempotent — entries that already hold data are left alone. The
 * directory scopes the location-aware endpoints and keys the diff cache.
 */
export function prefetchSessionActivity(
    api: OpencodeApi,
    subscribe: (handler: OpencodeEventHandler) => () => void,
    sessionId: string,
    directory: string | null,
): void {
    ensureWiring(api, subscribe);
    const entry = sessionEntryOf(sessionId);
    entry.directory = directory;
    if (!entry.shellsSeeded) seedRunningShells(sessionId);
    const dirEntry = directoryEntryOf(directory);
    if (dirEntry.diff === null && !dirEntry.diffLoading) void loadWorkspaceDiff(directory);
}

/** The workspace diff of one directory, live (SWR: cached entries paint
 *  immediately, activation revalidates behind them). */
export function useWorkspaceDiff(
    api: OpencodeApi | null,
    subscribe: (handler: OpencodeEventHandler) => () => void,
    directory: string | null,
): {
    /** Working-copy diff entries, or null before the first load. */
    diff: WorkspaceDiffEntry[] | null;
    diffLoading: boolean;
    diffTotals: {added: number; removed: number; files: number};
    /** Force a re-pull (e.g. the changes section was opened). */
    refreshDiff: () => void;
} {
    // Seeded from the store at FIRST RENDER so a directory switched back
    // to mounts with its diff (the card enters with content, not a shell).
    const [snap, setSnap] = useState(() => diffSnapshotOf(directory));

    useEffect(() => {
        if (!api) return;
        ensureWiring(api, subscribe);
    }, [api, subscribe]);

    // Render the directory's entry and follow its changes; activate it:
    // the cached diff paints immediately, then revalidates behind it.
    useEffect(() => {
        if (!api) return;
        directoryEntryOf(directory);
        setSnap(diffSnapshotOf(directory));
        const key = directoryKey(directory);
        const listener = (changed: string) => {
            if (changed === key) setSnap(diffSnapshotOf(directory));
        };
        diffListeners.add(listener);
        void loadWorkspaceDiff(directory);
        return () => {
            diffListeners.delete(listener);
        };
    }, [api, directory]);

    const refreshDiff = useCallback(() => {
        if (directories.has(directoryKey(directory))) void loadWorkspaceDiff(directory);
    }, [directory]);

    const diffTotals = useMemo(() => {
        let added = 0;
        let removed = 0;
        for (const entry of snap.diff ?? []) {
            added += entry.additions;
            removed += entry.deletions;
        }
        return {added, removed, files: snap.diff?.length ?? 0};
    }, [snap.diff]);

    return useMemo(
        () => ({diff: snap.diff, diffLoading: snap.diffLoading, diffTotals, refreshDiff}),
        [snap.diff, snap.diffLoading, diffTotals, refreshDiff],
    );
}

/** The ACTIVE session's background terminals and subagent children, live.
 * Reads the message store through a snapshot binding (the card outlives
 * same-directory session switches — no stale frame from the previous
 * session) and the module-level running-set store seeded on activation
 * and patched by the shell bus. */
export function useSessionActivity(
    api: OpencodeApi | null,
    subscribe: (handler: OpencodeEventHandler) => () => void,
    sessionId: string | null,
    busyIds: ReadonlySet<string>,
    directory: string | null,
): {
    /** The session's background shells (spawn order) with live state. */
    shells: (SessionShellRef & {running: boolean})[];
    /** Subagent children (spawn order) with live state. */
    subagents: (SessionSubagentRef & {running: boolean})[];
    /** Manually stop one of the session's running shells. */
    stopShell: (shellId: string) => void;
} {
    const messages = useSessionMessagesSnapshot(sessionId);

    // Follow the session entry's running-set changes (bus + seeding).
    const subscribeShells = useCallback((notify: () => void) => {
        shellListeners.add(notify);
        return () => shellListeners.delete(notify);
    }, []);
    const getRunningShellIds = useCallback(
        () => (sessionId !== null ? sessions.get(sessionId)?.runningShellIds ?? EMPTY_SHELLS : EMPTY_SHELLS),
        [sessionId],
    );
    const runningShellIds = useSyncExternalStore(subscribeShells, getRunningShellIds, getRunningShellIds);

    useEffect(() => {
        if (!api) return;
        ensureWiring(api, subscribe);
    }, [api, subscribe]);

    // Activate: re-seed the running shell set from server truth.
    useEffect(() => {
        if (sessionId === null) return;
        const entry = sessionEntryOf(sessionId);
        entry.directory = directory;
        seedRunningShells(sessionId);
    }, [sessionId, directory]);

    const stopShellCb = useCallback(
        (shellId: string) => {
            if (sessionId !== null) stopShell(sessionId, shellId);
        },
        [sessionId],
    );

    const shellRefs = useMemo(() => collectSessionShells(messages as ChatMessage[]), [messages]);
    // Identity-stable derived arrays: `messages` changes identity on every
    // streamed frame, and the card subtree must not re-render per frame —
    // when the computed key is unchanged, the previous array is returned.
    const shellsCacheRef = useRef<{key: string; value: (SessionShellRef & {running: boolean})[]} | null>(null);
    const shells = useMemo(() => {
        const key = shellRefs
            .map((s) => `${s.id}:${s.command}:${s.finished ? "f" : ""}:${s.state ?? ""}:${s.exit ?? ""}:${s.finalText?.length ?? ""}:${runningShellIds.has(s.id) ? "r" : ""}`)
            .join("|");
        if (shellsCacheRef.current?.key === key) return shellsCacheRef.current.value;
        const value = shellRefs.map((ref) => ({...ref, running: !ref.finished && runningShellIds.has(ref.id)}));
        shellsCacheRef.current = {key, value};
        return value;
    }, [shellRefs, runningShellIds]);

    const subagentRefs = useMemo(() => collectSessionSubagents(messages as ChatMessage[]), [messages]);
    const subagentsCacheRef = useRef<{key: string; value: (SessionSubagentRef & {running: boolean})[]} | null>(null);
    const subagents = useMemo(() => {
        const key = subagentRefs
            .map((s) => `${s.id}:${s.agent ?? ""}:${s.label ?? ""}:${busyIds.has(s.id) ? "r" : ""}`)
            .join("|");
        if (subagentsCacheRef.current?.key === key) return subagentsCacheRef.current.value;
        const value = subagentRefs.map((ref) => ({...ref, running: busyIds.has(ref.id)}));
        subagentsCacheRef.current = {key, value};
        return value;
    }, [subagentRefs, busyIds]);

    return useMemo(
        () => ({shells, subagents, stopShell: stopShellCb}),
        [shells, subagents, stopShellCb],
    );
}
