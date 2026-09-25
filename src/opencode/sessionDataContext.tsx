import {createContext, useContext, useMemo, type ReactNode} from "react";
import {useConnection} from "./connectionContext.tsx";
import {useSessions} from "./useSessions.ts";
import {useSessionRequests} from "./useSessionRequests.ts";
import {useSessionMessages, useSessionSeeded} from "./useSessionMessages.ts";
import {useSessionActivity, useWorkspaceDiff} from "./useSessionActivity.ts";
import type {FormAnswer, FormRequest, PermissionDecision, PermissionRequest} from "./types.ts";

/**
 * The session-data context — the SESSION-domain third of the context
 * split (connection / catalog / session data). It owns everything a
 * render component used to fetch for itself, so views stop caring
 * whether data comes from the module-level caches or off the wire:
 *
 * - the sidebar's session list (useSessions, hosted ONCE here — it was
 *   a single-instance hook inside useSessionFlow before),
 * - pending server→user asks across all sessions (useSessionRequests),
 * - per-session transcripts (the message store binding below),
 * - the stats card's two scopes (workspace diff + session activity).
 *
 * The module-level stores stay the caching layer, untouched: this
 * context is the React seam over them, not a second cache. Readiness
 * (useSessionSeeded / ensureSessionSeeded in useSessionMessages.ts) is
 * what App's sequential surface choreography keys its entrance phase
 * on — the reason this provider exists: the swap sequencer at App
 * level must be able to warm and await a session's data without
 * mounting the session's view first.
 */

interface SessionDataContextValue {
    sessions: ReturnType<typeof useSessions>["sessions"];
    /** True once the first session list has landed. */
    sessionsLoaded: boolean;
    busyIds: ReadonlySet<string>;
    createSession: ReturnType<typeof useSessions>["create"];
    removeSession: ReturnType<typeof useSessions>["remove"];
    patchSession: ReturnType<typeof useSessions>["patch"];
    /** Pending server→user asks across ALL sessions (permission
     *  requests + forms) — a pending ask blocks that session's
     *  execution server-side. */
    permissions: PermissionRequest[];
    forms: FormRequest[];
    /** Per-session pending count (sidebar badges). */
    pendingCounts: ReadonlyMap<string, number>;
    replyPermission: (request: PermissionRequest, decision: PermissionDecision) => Promise<void>;
    replyForm: (form: FormRequest, answer: FormAnswer) => Promise<void>;
    cancelForm: (form: FormRequest) => Promise<void>;
}

const SessionDataContext = createContext<SessionDataContextValue | null>(null);

export function SessionDataProvider({children}: {children: ReactNode}) {
    const {api, subscribe} = useConnection();
    const {sessions, loaded, busyIds, create, remove, patch} = useSessions(api, subscribe);
    const {
        permissions,
        forms,
        pendingCounts,
        replyPermission,
        replyForm,
        cancelForm,
    } = useSessionRequests(api, subscribe);

    const value = useMemo(
        () => ({
            sessions,
            sessionsLoaded: loaded,
            busyIds,
            createSession: create,
            removeSession: remove,
            patchSession: patch,
            permissions,
            forms,
            pendingCounts,
            replyPermission,
            replyForm,
            cancelForm,
        }),
        [
            sessions,
            loaded,
            busyIds,
            create,
            remove,
            patch,
            permissions,
            forms,
            pendingCounts,
            replyPermission,
            replyForm,
            cancelForm,
        ],
    );

    return <SessionDataContext.Provider value={value}>{children}</SessionDataContext.Provider>;
}

export function useSessionData(): SessionDataContextValue {
    const ctx = useContext(SessionDataContext);
    if (!ctx) throw new Error("useSessionData requires SessionDataProvider");
    return ctx;
}

/** One session's transcript, live — the context-consuming form of the
 *  message-store binding (api/subscribe come from the connection
 *  context; the store itself is unchanged). Mounting this is still
 *  what seeds an unseeded session, so read-only consumers that must
 *  not trigger fetches use useSessionMessagesSnapshot instead. */
export function useSessionTranscript(sessionId: string | null) {
    const {api, subscribe} = useConnection();
    return useSessionMessages(api, subscribe, sessionId);
}

/** The pending asks pinned above ONE session's composer (already
 *  filtered — the raw lists span every session for the sidebar). */
export function usePendingRequests(sessionId: string | null): {
    permissions: PermissionRequest[];
    forms: FormRequest[];
} {
    const {permissions, forms} = useSessionData();
    return useMemo(
        () => ({
            permissions: sessionId === null ? [] : permissions.filter((p) => p.sessionID === sessionId),
            forms: sessionId === null ? [] : forms.filter((f) => f.sessionID === sessionId),
        }),
        [permissions, forms, sessionId],
    );
}

/** Context-consuming forms of the stats scopes (WorkspaceStatsCard's
 *  data owner used to take api/subscribe as props). */
export function useWorkspaceDiffOf(directory: string | null) {
    const {api, subscribe} = useConnection();
    return useWorkspaceDiff(api, subscribe, directory);
}

export function useSessionActivityOf(
    sessionId: string,
    busyIds: ReadonlySet<string>,
    directory: string | null,
) {
    const {api, subscribe} = useConnection();
    return useSessionActivity(api, subscribe, sessionId, busyIds, directory);
}

/** Re-exported for the choreography's convenience: readiness lives with
 *  the message store. (ensureSessionSeeded takes api explicitly — it is
 *  called from event handlers, not render.) */
export {useSessionSeeded};
