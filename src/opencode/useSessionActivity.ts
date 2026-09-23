import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {ChatMessage, SessionDiffEntry} from "./types.ts";
import {
    collectSessionShells,
    collectSessionSubagents,
    fileMutationCount,
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
 * - The DIFF is server truth (`GET /api/session/{id}/diff` compares
 *   snapshot trees; a run in flight compares against the working copy, so
 *   the numbers stay live). Anchored to the session's first/last user
 *   message ids — no anchors would diff only the newest turn. Re-pulled
 *   (debounced) whenever a file-mutating tool lands or a user message
 *   arrives, which the message list's cheap change signature detects.
 * - TERMINALS: the shell list comes from the session's own tool parts
 *   (`metadata.shellID`, background results only); "running" is the
 *   server's live shell list (`GET /api/shell`, running-only) seeded on
 *   session switch and patched by the global shell.created/exited bus
 *   events. A completion notification message (collector: `finished`)
 *   always wins over the live set.
 * - SUBAGENTS: child ids from subagent tool parts; "running" is the app's
 *   busy set, which the execution events of child sessions already feed.
 */
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
} {
    const [diff, setDiff] = useState<SessionDiffEntry[] | null>(null);
    const [diffLoading, setDiffLoading] = useState(false);
    /** Live RUNNING shell ids for THIS session (server truth + bus). */
    const [runningShellIds, setRunningShellIds] = useState<ReadonlySet<string>>(new Set());

    const apiRef = useRef(api);
    apiRef.current = api;
    const sessionRef = useRef(sessionId);
    sessionRef.current = sessionId;
    const dirRef = useRef(directory);
    dirRef.current = directory;

    // --- Diff anchors: the session's first/last user message ids. The
    // first lives on the oldest page (one tiny order=asc request, cached
    // per session); the last is whatever the loaded messages hold. Both
    // are read through refs so a load started earlier never restarts per
    // streamed frame.
    const firstUserRef = useRef<{session: string; id: string | null} | null>(null);
    const lastUserIdRef = useRef<string | null>(null);
    lastUserIdRef.current = useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.type === "user" && !m.id.startsWith("local-")) return m.id;
        }
        return null;
    }, [messages]);
    /** Guards in-flight diff requests: only the latest one applies. */
    const diffSeqRef = useRef(0);

    const loadDiff = useCallback(async () => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid || lastUserIdRef.current === null) return;
        const seq = ++diffSeqRef.current;
        setDiffLoading(true);
        try {
            if (firstUserRef.current?.session !== sid) {
                const id = await a.firstUserMessageId(sid).catch((e) => {
                    logError(`Failed to load diff anchor: ${e}`).catch(() => {});
                    return null;
                });
                if (seq !== diffSeqRef.current) return;
                firstUserRef.current = {session: sid, id};
            }
            const entries = await a.sessionDiff(sid, {
                from: firstUserRef.current?.id ?? undefined,
                to: lastUserIdRef.current ?? undefined,
            });
            if (seq !== diffSeqRef.current) return;
            setDiff(entries);
        } catch (e) {
            if (seq === diffSeqRef.current) logError(`Failed to load session diff: ${e}`).catch(() => {});
        } finally {
            if (seq === diffSeqRef.current) setDiffLoading(false);
        }
    }, []);

    // Reset + first load on session switch.
    useEffect(() => {
        diffSeqRef.current++; // abandon anything still in flight
        setDiff(null);
        setRunningShellIds(new Set());
        signatureSeenRef.current = false;
        if (sessionId) void loadDiff();
    }, [api, sessionId, loadDiff]);

    // Change signature: file-mutating tool count + the last user message
    // id. Its VALUE only moves when an edit landed or a prompt arrived —
    // streamed frames never bump it — so the debounced re-pull below runs
    // only on real changes. The first observation per session just seeds
    // the watcher (the switch effect above already pulled).
    const mutationSignature = useMemo(() => `${fileMutationCount(messages)}:${lastUserIdRef.current ?? ""}`, [messages]);
    const signatureSeenRef = useRef(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (!api || !sessionId) return;
        if (!signatureSeenRef.current) {
            signatureSeenRef.current = true;
            return;
        }
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            debounceRef.current = null;
            void loadDiff();
        }, DIFF_DEBOUNCE_MS);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
    }, [api, sessionId, mutationSignature, loadDiff]);

    const refreshDiff = useCallback(() => {
        void loadDiff();
    }, [loadDiff]);

    // --- Live shell running set: seed from the server on session switch,
    // then patch from the global shell bus events.
    useEffect(() => {
        if (!api || !sessionId) return;
        let cancelled = false;
        api.listShells(dirRef.current).then((list) => {
            if (cancelled) return;
            const ids = new Set(
                list
                    .filter((s) => (s.metadata?.sessionID ?? undefined) === sessionId)
                    .map((s) => s.id),
            );
            setRunningShellIds((prev) => (ids.size === 0 && prev.size === 0 ? prev : ids));
        }).catch((e) => {
            logError(`Failed to load running shells: ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
        };
    }, [api, sessionId]);

    useEffect(() => {
        return subscribe((event) => {
            if (event.type === "shell.created") {
                const info = (event.data as {info?: {id?: string; metadata?: Record<string, unknown>} | null}).info;
                const sid = sessionRef.current;
                const id = info?.id;
                if (!sid || !id || (info?.metadata?.sessionID ?? undefined) !== sid) return;
                setRunningShellIds((prev) => {
                    if (prev.has(id)) return prev;
                    const next = new Set(prev);
                    next.add(id);
                    return next;
                });
            } else if (event.type === "shell.exited") {
                const {id} = event.data as {id?: string};
                if (!id) return;
                setRunningShellIds((prev) => {
                    if (!prev.has(id)) return prev;
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
            }
        });
    }, [subscribe]);

    const shellRefs = useMemo(() => collectSessionShells(messages), [messages]);
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
        for (const entry of diff ?? []) {
            added += entry.additions;
            removed += entry.deletions;
        }
        return {added, removed, files: diff?.length ?? 0};
    }, [diff]);

    // Stable bundle so the memoized card skips re-rendering on frames that
    // changed nothing here.
    return useMemo(
        () => ({diff, diffLoading, diffTotals, shells, subagents, refreshDiff}),
        [diff, diffLoading, diffTotals, shells, subagents, refreshDiff],
    );
}
