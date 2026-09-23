import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {ChatMessage, SessionDiffEntry} from "./types.ts";
import {peekSessionMessages, subscribeSessionMessages} from "./useSessionMessages.ts";
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
 * Session-activity state for the stats card: the whole-session git diff,
 * the session's background terminals (live running set included) and its
 * subagent children.
 *
 * THE STORE OUTLIVES CHATVIEW (module-level, one entry per session — the
 * useSessionMessages pattern): switching tabs must find the activity
 * ALREADY computed, so the card mounts as part of the session surface's
 * initial layout instead of popping in after the entrance animation.
 * Backgrounded sessions stay fresh too — the global shell bus patches
 * their running sets, and a message-store watcher re-pulls a diff
 * (debounced) whenever a session's mutation signature moves — so a
 * session that kept working behind another tab switches in current.
 *
 * - The DIFF is server truth (`GET /api/session/{id}/diff` compares
 *   snapshot trees; a run in flight compares against the working copy, so
 *   the numbers stay live). Anchored to the session's first/last user
 *   message ids — no anchors would diff only the newest turn. Activation
 *   paints the cached entries and revalidates behind them
 *   (stale-while-revalidate); the first-user anchor is loaded once per
 *   session, the last-user anchor falls out of the tracked messages (or
 *   one tiny desc request for never-opened prefetches).
 * - TERMINALS: the shell list comes from the session's own tool parts
 *   (`metadata.shellID`, background results only); "running" is the
 *   server's live shell list (`GET /api/shell`, running-only) seeded on
 *   activation and patched by the global shell.created/exited bus
 *   events. A completion notification message (collector: `finished`)
 *   always wins over the live set.
 * - SUBAGENTS: child ids from subagent tool parts; "running" is the app's
 *   busy set, which the execution events of child sessions already feed.
 */

/** One session's cached activity state. */
interface ActivityEntry {
    /** Whole-session diff entries, or null before the first load. */
    diff: SessionDiffEntry[] | null;
    diffLoading: boolean;
    /** Diff anchor: the session's FIRST user message id, fetched once. */
    firstUserId: string | null;
    anchorLoaded: boolean;
    /** Live RUNNING shell ids (server truth + bus). */
    runningShellIds: ReadonlySet<string>;
    /** Directory the location-scoped shell endpoints are addressed with. */
    directory: string | null;
    /** Guards in-flight diff requests: only the latest one applies. */
    seq: number;
    /** Mutation signature last seen, plus the messages it was computed
     *  on (identity cache — the message store notifies per change). */
    signature: string;
    signatureMessages: readonly ChatMessage[] | null;
    /** Debounced re-pull timer. */
    debounce: ReturnType<typeof setTimeout> | null;
    /** listShells seeded at least once (prefetch guards on this). */
    shellsSeeded: boolean;
}

const EMPTY_SHELLS: ReadonlySet<string> = new Set();
const entries = new Map<string, ActivityEntry>();
const listeners = new Set<(sessionId: string) => void>();

function entryOf(sessionId: string): ActivityEntry {
    let entry = entries.get(sessionId);
    if (!entry) {
        entry = {
            diff: null,
            diffLoading: false,
            firstUserId: null,
            anchorLoaded: false,
            runningShellIds: EMPTY_SHELLS,
            directory: null,
            seq: 0,
            signature: "",
            signatureMessages: null,
            debounce: null,
            shellsSeeded: false,
        };
        entries.set(sessionId, entry);
    }
    return entry;
}

function notify(sessionId: string) {
    for (const listener of listeners) listener(sessionId);
}

/** Snapshot the hook renders from (cached values by reference — the
 *  downstream memos only see new identities when a value really moved). */
function snapshotOf(sessionId: string | null): {
    diff: SessionDiffEntry[] | null;
    diffLoading: boolean;
    runningShellIds: ReadonlySet<string>;
} {
    const entry = sessionId !== null ? entries.get(sessionId) : undefined;
    return {
        diff: entry?.diff ?? null,
        diffLoading: entry?.diffLoading ?? false,
        runningShellIds: entry?.runningShellIds ?? EMPTY_SHELLS,
    };
}

// --- Module wiring: api handle + one bus handler + one message watcher ---
let apiSingleton: OpencodeApi | null = null;
let busUnsubscribe: (() => void) | null = null;

/** The tracked messages' last server-confirmed user message id (the
 *  diff's `to` anchor); null when the session has no prompt yet. */
function lastTrackedUserId(sessionId: string): string | null {
    const list = peekSessionMessages(sessionId);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m.type === "user" && !m.id.startsWith("local-")) return m.id;
    }
    return null;
}

/** Re-pull a session's diff when its messages' mutation signature moved.
 *  The first observation seeds silently — activation and prefetch pull
 *  explicitly — UNLESS the entry still holds no diff and none is loading
 *  (a first-open whose messages arrived after activation's early-out
 *  would otherwise never pull). */
function watchSignature(sessionId: string) {
    const entry = entries.get(sessionId);
    const messages = peekSessionMessages(sessionId);
    if (!entry || !messages || entry.signatureMessages === messages) return;
    const next = mutationSignature(messages);
    const seeded = entry.signatureMessages !== null;
    entry.signatureMessages = messages;
    if (!seeded) {
        entry.signature = next;
        if (entry.diff === null && !entry.diffLoading) scheduleLoad(sessionId);
        return;
    }
    if (next === entry.signature) return;
    entry.signature = next;
    scheduleLoad(sessionId);
}

function scheduleLoad(sessionId: string) {
    const entry = entries.get(sessionId);
    if (!entry) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
        entry.debounce = null;
        void loadDiff(sessionId);
    }, DIFF_DEBOUNCE_MS);
}

async function loadDiff(sessionId: string): Promise<void> {
    const entry = entries.get(sessionId);
    const api = apiSingleton;
    if (!entry || !api) return;
    const tracked = peekSessionMessages(sessionId) != null;
    const trackedLast = lastTrackedUserId(sessionId);
    if (tracked && trackedLast === null) return; // tracked but no prompt yet — nothing to diff
    const seq = ++entry.seq;
    entry.diffLoading = true;
    notify(sessionId);
    try {
        if (!entry.anchorLoaded) {
            const id = await api.firstUserMessageId(sessionId).catch((e) => {
                logError(`Failed to load diff anchor: ${e}`).catch(() => {});
                return null;
            });
            if (seq !== entry.seq) return;
            entry.firstUserId = id;
            entry.anchorLoaded = true;
        }
        // `to` anchor: the tracked messages' last user message, or (for a
        // never-opened prefetch) one tiny desc request.
        let to = trackedLast;
        if (to === null) {
            to = await api.lastUserMessageId(sessionId).catch((e) => {
                logError(`Failed to load diff anchor: ${e}`).catch(() => {});
                return null;
            });
            if (seq !== entry.seq) return;
        }
        if (to === null) {
            entry.diff = []; // no prompt at all — nothing changed
            return;
        }
        const list = await api.sessionDiff(sessionId, {
            from: entry.firstUserId ?? undefined,
            to,
        });
        if (seq !== entry.seq) return;
        entry.diff = list;
    } catch (e) {
        if (seq === entry.seq) logError(`Failed to load session diff: ${e}`).catch(() => {});
    } finally {
        if (seq === entry.seq) {
            entry.diffLoading = false;
            notify(sessionId);
        }
    }
}

/** Seed the running set from the server's live shell list (activation and
 *  once per prefetch). Location-scoped — the entry's directory rides along. */
function seedRunningShells(sessionId: string): void {
    const api = apiSingleton;
    const entry = entries.get(sessionId);
    if (!api || !entry) return;
    entry.shellsSeeded = true;
    api.listShells(entry.directory).then((list) => {
        const current = entries.get(sessionId);
        if (!current) return; // session dropped while the request was out
        current.runningShellIds = new Set(
            list
                .filter((s) => (s.metadata?.sessionID ?? undefined) === sessionId)
                .map((s) => s.id),
        );
        notify(sessionId);
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
    const entry = entries.get(sessionId);
    if (!api || !entry || !entry.runningShellIds.has(shellId)) return;
    entry.runningShellIds = new Set([...entry.runningShellIds].filter((id) => id !== shellId));
    notify(sessionId);
    const directory = entry.directory;
    api.removeShell(shellId, directory).then(() => {
        logInfo(`Terminal ${shellId} stopped`).catch(() => {});
    }).catch((e) => {
        logError(`Failed to stop terminal ${shellId}: ${e}`).catch(() => {});
        api.getShell(shellId, directory).then((shell) => {
            if (shell.status !== "running") return;
            const current = entries.get(sessionId);
            if (!current || current.runningShellIds.has(shellId)) return;
            current.runningShellIds = new Set([...current.runningShellIds, shellId]);
            notify(sessionId);
        }).catch((e2) => {
            logError(`Failed to re-read terminal ${shellId} after a failed stop: ${e2}`).catch(() => {});
        });
    });
}

function dropEntry(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (!entry) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entries.delete(sessionId);
    notify(sessionId);
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
            dropEntry((event.data as {sessionID?: string} | null)?.sessionID ?? "");
            return;
        }
        if (event.type === "shell.created") {
            const info = (event.data as {info?: {id?: string; metadata?: Record<string, unknown>} | null}).info;
            const sid = info?.id ? (info.metadata?.sessionID ?? undefined) : undefined;
            const id = info?.id;
            if (typeof sid !== "string" || !id) return;
            const entry = entries.get(sid);
            if (!entry || entry.runningShellIds.has(id)) return;
            entry.runningShellIds = new Set([...entry.runningShellIds, id]);
            notify(sid);
        } else if (event.type === "shell.exited") {
            const {id} = event.data as {id?: string};
            if (!id) return;
            for (const [sid, entry] of entries) {
                if (!entry.runningShellIds.has(id)) continue;
                entry.runningShellIds = new Set([...entry.runningShellIds].filter((x) => x !== id));
                notify(sid);
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
 * and idempotent — an entry that already holds data is left alone. The
 * directory scopes the location-aware shell endpoints.
 */
export function prefetchSessionActivity(
    api: OpencodeApi,
    subscribe: (handler: OpencodeEventHandler) => () => void,
    sessionId: string,
    directory: string | null,
): void {
    ensureWiring(api, subscribe);
    const entry = entryOf(sessionId);
    entry.directory = directory;
    if (!entry.shellsSeeded) seedRunningShells(sessionId);
    if (entry.diff === null && !entry.diffLoading) void loadDiff(sessionId);
}

export function useSessionActivity(
    api: OpencodeApi | null,
    subscribe: (handler: OpencodeEventHandler) => () => void,
    sessionId: string | null,
    messages: ChatMessage[],
    busyIds: ReadonlySet<string>,
    directory: string | null,
): {
    /** Whole-session diff entries, or null before the first load. */
    diff: SessionDiffEntry[] | null;
    diffLoading: boolean;
    diffTotals: {added: number; removed: number; files: number};
    /** The session's background shells (spawn order) with live state. */
    shells: (SessionShellRef & {running: boolean})[];
    /** Subagent children (spawn order) with live state. */
    subagents: (SessionSubagentRef & {running: boolean})[];
    /** Force a diff re-pull (e.g. the changes section was opened). */
    refreshDiff: () => void;
    /** Manually stop one of the session's running shells. */
    stopShell: (shellId: string) => void;
} {
    // Mirror of the active session's entry — seeded from the store at
    // FIRST RENDER so a switched-back session mounts with its activity.
    const [snap, setSnap] = useState(() => snapshotOf(sessionId));

    useEffect(() => {
        if (!api) return;
        ensureWiring(api, subscribe);
    }, [api, subscribe]);

    // Render the active session's entry and follow its changes; activate
    // it: cached diff paints immediately (SWR), then revalidate behind it
    // and re-seed the running shell set from server truth.
    useEffect(() => {
        if (sessionId === null) return;
        const entry = entryOf(sessionId);
        entry.directory = directory;
        setSnap(snapshotOf(sessionId));
        const listener = (sid: string) => {
            if (sid === sessionId) setSnap(snapshotOf(sid));
        };
        listeners.add(listener);
        void loadDiff(sessionId);
        seedRunningShells(sessionId);
        return () => {
            listeners.delete(listener);
        };
    }, [api, sessionId, directory]);

    const refreshDiff = useCallback(() => {
        if (sessionId !== null) void loadDiff(sessionId);
    }, [sessionId]);

    const stopShellCb = useCallback(
        (shellId: string) => {
            if (sessionId !== null) stopShell(sessionId, shellId);
        },
        [sessionId],
    );

    const shellRefs = useMemo(() => collectSessionShells(messages), [messages]);
    // Identity-stable derived arrays: `messages` changes identity on every
    // streamed frame, and the card subtree must not re-render per frame —
    // when the computed key is unchanged, the previous array is returned.
    const shellsCacheRef = useRef<{key: string; value: (SessionShellRef & {running: boolean})[]} | null>(null);
    const shells = useMemo(() => {
        const key = shellRefs
            .map((s) => `${s.id}:${s.command}:${s.finished ? "f" : ""}:${s.state ?? ""}:${s.exit ?? ""}:${s.finalText?.length ?? ""}:${snap.runningShellIds.has(s.id) ? "r" : ""}`)
            .join("|");
        if (shellsCacheRef.current?.key === key) return shellsCacheRef.current.value;
        const value = shellRefs.map((ref) => ({...ref, running: !ref.finished && snap.runningShellIds.has(ref.id)}));
        shellsCacheRef.current = {key, value};
        return value;
    }, [shellRefs, snap.runningShellIds]);

    const subagentRefs = useMemo(() => collectSessionSubagents(messages), [messages]);
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

    const diffTotals = useMemo(() => {
        let added = 0;
        let removed = 0;
        for (const entry of snap.diff ?? []) {
            added += entry.additions;
            removed += entry.deletions;
        }
        return {added, removed, files: snap.diff?.length ?? 0};
    }, [snap.diff]);

    // Stable bundle so the memoized card skips re-rendering on frames that
    // changed nothing here.
    return useMemo(
        () => ({
            diff: snap.diff,
            diffLoading: snap.diffLoading,
            diffTotals,
            shells,
            subagents,
            refreshDiff,
            stopShell: stopShellCb,
        }),
        [snap.diff, snap.diffLoading, diffTotals, shells, subagents, refreshDiff, stopShellCb],
    );
}
