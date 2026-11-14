import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import type {OpencodeApi} from "./api/index.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {ChatMessage, WorkspaceDiffEntry} from "./types.ts";
import {peekSessionMessages, subscribeSessionMessages, useSessionMessagesSnapshot} from "./useSessionMessages.ts";
import {
    collectSessionShells,
    collectSessionSubagents,
    collectSessionTodos,
    type GateContext,
    mutationSignature,
    type SessionShellRef,
    type SessionSubagentRef,
    type SessionTodos,
} from "./sessionActivity.ts";
import {getGateDecisionsSnapshot, subscribeGateDecisions} from "./gateDecisions.ts";
import {
    directoryEntryOf,
    diffSnapshotOf,
    directoryKey,
    loadWorkspaceDiff,
    refreshWorkspaceDiff,
    scheduleDiffLoad,
    setDiffApi,
    subscribeDiff,
} from "./workspaceDiffStore.ts";
import {
    deleteSessionEntry,
    EMPTY_SHELLS,
    notifyShellChange,
    peekSessionEntry,
    seedRunningShells,
    sessionEntryOf,
    setShellsApi,
    shellBus,
    snapshotSessionEntries,
    stopShell as stopShellInStore,
} from "./sessionShellsStore.ts";

export {peekWorkspaceDiff} from "./workspaceDiffStore.ts";

/**
 * Stats-card state, split by scope:
 *
 * - WORKSPACE DIFF (`GET /api/vcs/diff?mode=working` — HEAD vs the working
 *   copy of a directory, untracked files included): cached in a
 *   module-level store keyed by DIRECTORY (workspaceDiffStore.ts). This
 *   replaced the per-session diff endpoint, which compares
 *   whole-worktree snapshot trees over the session's TIME WINDOW — any
 *   other session editing the same project leaked into it (sessions in
 *   one directory share one physical worktree and one snapshot
 *   repository), so an idle session would inherit a sibling's edits. The
 *   workspace diff is honest by construction, and all sessions in a
 *   directory share one cache entry — a same-directory session switch
 *   paints instantly with identical numbers.
 * - TERMINALS: the shell list comes from the session's own tool parts
 *   (`metadata.shellID`, background results only); "running" is the
 *   server's live shell list (`GET /api/shell`, running-only) seeded on
 *   activation and patched by the global shell.created/exited bus
 *   events (sessionShellsStore.ts). A completion notification message
 *   (collector: `finished`) always wins over the live set.
 * - SUBAGENTS: child ids from subagent tool parts; "running" is the app's
 *   busy set, which the execution events of child sessions already feed.
 * - Both lists are CURRENT-TURN scoped: completed items spawned before
 *   the last user message are hidden (sessionActivity.currentTurn), so a
 *   long session's early research subagents / test terminals don't bury
 *   the live activity at the bottom of the list. RUNNING items stay
 *   visible whatever their turn.
 *
 * The session-scoped hook reads the message store through a SNAPSHOT
 * binding instead of ChatView's messages — the card must not render the
 * previous session's terminals/subagents for a frame on a switch.
 */

// --- Module wiring: api handle + one bus handler + one message watcher ---
let busUnsubscribe: (() => void) | null = null;

/** Re-pull a directory's workspace diff when a tracked session's messages'
 *  mutation signature moved (edits landed — backgrounded sessions
 *  included, keeping their directory's numbers fresh). */
function watchSignature(sessionId: string) {
    const entry = peekSessionEntry(sessionId);
    const messages = peekSessionMessages(sessionId);
    if (!entry || !messages || entry.signatureMessages === messages) return;
    const next = mutationSignature(messages as ChatMessage[]);
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

/** Install the api handle + the global bus handler + the message watcher
 *  (once per app run; `subscribe` is stable). */
function ensureWiring(
    api: OpencodeApi,
    subscribe: (handler: OpencodeEventHandler) => () => void,
): void {
    setDiffApi(api);
    setShellsApi(api);
    if (busUnsubscribe) return;
    busUnsubscribe = subscribe((event) => {
        if (event.type === "session.deleted") {
            deleteSessionEntry((event.data as {sessionID?: string} | null)?.sessionID ?? "");
            return;
        }
        if (event.type === "shell.created") {
            const info = (event.data as {info?: {id?: string; metadata?: Record<string, unknown>} | null}).info;
            const sid = info?.id ? (info.metadata?.sessionID ?? undefined) : undefined;
            const id = info?.id;
            if (typeof sid !== "string" || !id) return;
            const entry = peekSessionEntry(sid);
            if (!entry || entry.runningShellIds.has(id)) return;
            entry.runningShellIds = new Set([...entry.runningShellIds, id]);
            notifyShellChange();
        } else if (event.type === "shell.exited") {
            const {id} = event.data as {id?: string};
            if (!id) return;
            for (const entry of snapshotSessionEntries()) {
                if (!entry[1].runningShellIds.has(id)) continue;
                entry[1].runningShellIds = new Set([...entry[1].runningShellIds].filter((x) => x !== id));
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
        return subscribeDiff((changed) => {
            if (changed === key) setSnap(diffSnapshotOf(directory));
        });
    }, [api, directory]);

    const refreshDiff = useCallback(() => {
        refreshWorkspaceDiff(directory);
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
    /** The session's CURRENT agent — the plan fold's restart-recovery
     *  rule reads it (a plan_submit frozen running under "build" counts
     *  as approved; see sessionActivity's GateContext). */
    agent: string | undefined,
): {
    /** The session's background shells (spawn order) with live state. */
    shells: (SessionShellRef & {running: boolean})[];
    /** Subagent children (spawn order) with live state. */
    subagents: (SessionSubagentRef & {running: boolean})[];
    /** The plan-workflow todo list (null when the session has no plan). */
    todos: SessionTodos | null;
    /** Manually stop one of the session's running shells. */
    stopShell: (shellId: string) => void;
} {
    const messages = useSessionMessagesSnapshot(sessionId);

    // Follow the session entry's running-set changes (bus + seeding).
    const subscribeShells = useCallback((notify: () => void) => shellBus.subscribe(notify), []);
    const getRunningShellIds = useCallback(
        () => (sessionId !== null ? peekSessionEntry(sessionId)?.runningShellIds ?? EMPTY_SHELLS : EMPTY_SHELLS),
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
            if (sessionId !== null) stopShellInStore(sessionId, shellId);
        },
        [sessionId],
    );

    const shellRefs = useMemo(() => collectSessionShells(messages as ChatMessage[]), [messages]);
    // Identity-stable derived arrays (useIdentityCached below): `messages`
    // changes identity on every streamed frame, and the card subtree must
    // not re-render per frame. CURRENT-TURN FILTER: completed shells from
    // earlier turns are hidden (research/test leftovers of a long
    // session); RUNNING ones stay whatever their age — a dev server
    // started turns ago is still live, killable activity. A turn-anchored
    // shell that finishes is dropped by the same rule on its recompute.
    const shells = useIdentityCached(
        () => shellRefs.filter((s) => s.currentTurn || runningShellIds.has(s.id)),
        (visible) => visible
            .map((s) => `${s.id}:${s.command}:${s.finished ? "f" : ""}:${s.state ?? ""}:${s.exit ?? ""}:${s.finalText?.length ?? ""}:${runningShellIds.has(s.id) ? "r" : ""}`)
            .join("|"),
        (visible) => visible.map((ref) => ({...ref, running: !ref.finished && runningShellIds.has(ref.id)})),
        [shellRefs, runningShellIds],
    );

    const subagentRefs = useMemo(() => collectSessionSubagents(messages as ChatMessage[]), [messages]);
    // Same current-turn rule as shells: finished children of earlier
    // turns are hidden, running ones (busy set) always stay.
    const subagents = useIdentityCached(
        () => subagentRefs.filter((s) => s.currentTurn || busyIds.has(s.id)),
        (visible) => visible
            .map((s) => `${s.id}:${s.agent ?? ""}:${s.label ?? ""}:${busyIds.has(s.id) ? "r" : ""}`)
            .join("|"),
        (visible) => visible.map((ref) => ({...ref, running: busyIds.has(ref.id)})),
        [subagentRefs, busyIds],
    );

    // The plan-workflow todo list is a PURE transcript derivation (no
    // endpoints, no running-set store) — same identity-cache discipline
    // as above so streamed frames don't re-render the card per delta.
    // The key must cover EVERY field consumers read: `archived` once
    // lived outside it, so the flip to archived (work_submit completing)
    // returned the stale cached object and the chip stayed "awaiting
    // review" forever — the files were archived, the UI wasn't.
    // The gate context (agent + locally recorded restart-recovery
    // verdicts) keeps the panel coherent with the approval cards: a
    // frozen running gate reads as approved once the agent switched to
    // build, and a recorded verdict settles its chip (sessionActivity's
    // GateContext).
    const gateDecisions = useSyncExternalStore(subscribeGateDecisions, getGateDecisionsSnapshot);
    const gateCtx = useMemo<GateContext>(
        () => ({
            agent,
            decided: sessionId !== null ? new Map(Object.entries(gateDecisions[sessionId] ?? {})) : undefined,
        }),
        [agent, gateDecisions, sessionId],
    );
    const todos = useIdentityCached(
        () => collectSessionTodos(messages as ChatMessage[], gateCtx),
        (derived) => derived
            ? `${derived.title}|${derived.pendingApproval ? "p" : ""}|${derived.archived ? "a" : ""}|${derived.reportSubmitted ? "r" : ""}|${derived.items
                  .map((i) => `${i.title}:${i.status}:${i.reason ?? ""}`)
                  .join("|")}`
            : "",
        (derived) => derived,
        [messages, gateCtx],
    );

    return useMemo(
        () => ({shells, subagents, todos, stopShell: stopShellCb}),
        [shells, subagents, todos, stopShellCb],
    );
}

/** Identity-cache for a derived value: `messages` changes identity on
 *  every streamed frame, and consumers (memoized card rows) must not
 *  re-render per frame — when `keyOf(derive())` is unchanged, the
 *  previously returned value is returned again. The key must cover
 *  EVERY field consumers read (a missing field once froze a stale
 *  "awaiting review" chip after archival — see the todos note). Local
 *  to this file (three call sites; not a general API). */
function useIdentityCached<T, V>(
    derive: () => T,
    keyOf: (derived: T) => string,
    shape: (derived: T) => V,
    deps: unknown[],
): V {
    const cacheRef = useRef<{key: string; value: V} | null>(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(() => {
        const derived = derive();
        const key = keyOf(derived);
        if (cacheRef.current?.key === key) return cacheRef.current.value;
        const value = shape(derived);
        cacheRef.current = {key, value};
        return value;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
}
