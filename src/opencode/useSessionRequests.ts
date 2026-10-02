import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import {debug as logDebug, error as logError} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {ChatMessage, EventMap, FormAnswer, FormRequest, PermissionDecision, PermissionRequest} from "./types.ts";
import {peekSessionMessages, subscribeSessionMessages} from "./useSessionMessages.ts";
import {planApprovalPending, workApprovalPending} from "./sessionActivity.ts";

/**
 * Pending server→user requests across ALL sessions: permission asks
 * (accessing a folder outside the project, running a gated command, …)
 * and forms (the question tool's "AI asks the user" surface — see
 * api.ts for why questions are forms on this server generation).
 *
 * The state is global, not per-session: the sidebar needs pending counts
 * for sessions that aren't open, and a request that arrives while its
 * session is inactive must still be there when the user switches to it.
 * Seeded once from the two global list endpoints (recovering anything
 * that was pending before the event stream connected), then maintained
 * live from the bus. Until it is answered, the session's execution is
 * blocked server-side — these cards are the only way forward.
 *
 * The plan workflow's pending APPROVAL rides the same badge pipeline
 * (Route A): it is not a wire-level request but a transcript-derived
 * one — the plan_submit executor blocks inside its tool call, so a
 * still-running part IS a pending decision (sessionActivity.
 * planApprovalPending). A module-level store watches the message store
 * for every tracked session and folds those into pendingCounts, giving
 * plan approvals the same sidebar badge as questions.
 */

// The plan workflow's transcript-derived gates ride the same badge
// pipeline (Route A): they are not wire-level requests — the plan_submit
// and work_submit executors block inside their tool calls, so a
// still-running part IS a pending decision (sessionActivity.
// planApprovalPending / workApprovalPending). A module-level store
// watches the message store for every tracked session and folds both
// into pendingCounts, giving plan approvals and work acceptances the
// same sidebar badge as questions.

/** Per-session transcript-derived pending flags, as a stable snapshot for
 * useSyncExternalStore (replaced — never mutated — on change). */
interface PendingFlags {
    plan: boolean;
    work: boolean;
}
const NO_FLAGS: PendingFlags = {plan: false, work: false};
let pendingFlagsSnapshot: ReadonlyMap<string, PendingFlags> = new Map();
const pendingFlagsListeners = new Set<() => void>();
let pendingFlagsWired = false;

/** Recompute one session's gate states from its message store entry
 * (called on every store notification for that session).
 *
 * Deliberately STATUS-ONLY (no agent / decision context): a badge on a
 * RESTART-ORPHANED gate is wanted — it draws the user to the session
 * whose card waits in recovery mode, and it clears when the frozen part
 * finally stops reading as pending (the decision lands / a newer gate
 * replaces it). The card site (ChatView) reads the full context. */
function recomputePendingFlags(sessionId: string): void {
    const messages = peekSessionMessages(sessionId);
    if (!messages) return;
    const flags: PendingFlags = {
        plan: planApprovalPending(messages as ChatMessage[]) !== null,
        work: workApprovalPending(messages as ChatMessage[]) !== null,
    };
    const prev = pendingFlagsSnapshot.get(sessionId) ?? NO_FLAGS;
    if (flags.plan === prev.plan && flags.work === prev.work) return;
    const next = new Map(pendingFlagsSnapshot);
    if (flags.plan || flags.work) next.set(sessionId, flags);
    else next.delete(sessionId);
    pendingFlagsSnapshot = next;
    for (const listener of pendingFlagsListeners) listener();
}

/** Drop a deleted session's entry (its message store entry goes with it). */
function dropPendingFlags(sessionId: string): void {
    if (!pendingFlagsSnapshot.has(sessionId)) return;
    const next = new Map(pendingFlagsSnapshot);
    next.delete(sessionId);
    pendingFlagsSnapshot = next;
    for (const listener of pendingFlagsListeners) listener();
}

/** Read-only peek at ONE session's gate flags (the desktop-notification
 * composer asks WHICH attention kind just appeared; pendingCounts only
 * carries counts). Same shape the badge pipeline folds. */
export function peekGateFlags(sessionId: string): {plan: boolean; work: boolean} {
    return pendingFlagsSnapshot.get(sessionId) ?? NO_FLAGS;
}

/** Install the message-store watcher once per app run. */
function ensurePendingFlagsWiring(): void {
    if (pendingFlagsWired) return;
    pendingFlagsWired = true;
    subscribeSessionMessages((sessionId) => recomputePendingFlags(sessionId));
}

export function useSessionRequests(
    api: OpencodeApi | null,
    subscribe: (handler: OpencodeEventHandler) => () => void,
): {
    /** Pending permission requests (all sessions). */
    permissions: PermissionRequest[];
    /** Pending forms (all sessions). */
    forms: FormRequest[];
    /** Pending count per session ID — for sidebar badges. */
    pendingCounts: ReadonlyMap<string, number>;
    /** Answer a permission request; optimistically removes it. */
    replyPermission: (request: PermissionRequest, decision: PermissionDecision) => Promise<void>;
    /** Answer a form; optimistically removes it. */
    replyForm: (form: FormRequest, answer: FormAnswer) => Promise<void>;
    /** Dismiss a form; optimistically removes it. */
    cancelForm: (form: FormRequest) => Promise<void>;
} {
    const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
    const [forms, setForms] = useState<FormRequest[]>([]);
    const apiRef = useRef(api);
    apiRef.current = api;

    // Seed once connected: anything already pending predates our event
    // stream and would otherwise never surface.
    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        api.listPermissionRequests().then((list) => {
            if (!cancelled) setPermissions(list);
        }).catch((e) => {
            logError(`Failed to load pending permission requests: ${e}`).catch(() => {});
        });
        api.listForms().then((list) => {
            if (!cancelled) setForms(list);
        }).catch((e) => {
            logError(`Failed to load pending forms: ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
        };
    }, [api]);

    // Live maintenance from the event bus.
    useEffect(() => {
        return subscribe((event) => {
            switch (event.type) {
                case "permission.asked": {
                    const d = event.data as EventMap["permission.asked"];
                    setPermissions((prev) =>
                        prev.some((p) => p.id === d.id) ? prev : [...prev, d],
                    );
                    break;
                }
                case "permission.replied": {
                    const d = event.data as EventMap["permission.replied"];
                    setPermissions((prev) => prev.filter((p) => p.id !== d.requestID));
                    break;
                }
                case "form.created": {
                    const d = event.data as EventMap["form.created"];
                    setForms((prev) =>
                        prev.some((f) => f.id === d.form.id) ? prev : [...prev, d.form],
                    );
                    break;
                }
                case "form.replied":
                case "form.cancelled": {
                    const d = event.data as EventMap["form.replied"];
                    setForms((prev) => prev.filter((f) => f.id !== d.id));
                    break;
                }
                case "session.deleted": {
                    // The session is gone; its pending requests can never
                    // be answered (the reply routes 404 with the session).
                    const {sessionID} = event.data as {sessionID: string};
                    setPermissions((prev) => prev.filter((p) => p.sessionID !== sessionID));
                    setForms((prev) => prev.filter((f) => f.sessionID !== sessionID));
                    dropPendingFlags(sessionID);
                    break;
                }
            }
        });
    }, [subscribe]);

    /** Fire-and-track: remove optimistically, restore on failure (the
     *  server also confirms via replied/cancelled events — idempotent).
     *  A 404 is NOT a failure: the request is already settled server-side
     *  (the server's reject/always replies CASCADE over the session's
     *  other pending asks, and grouped identical asks are answered with
     *  several replies), so restoring would fabricate a card with nothing
     *  behind it — a zombie no click can dismiss. */
    const settle = useCallback(
        async (
            remove: () => void,
            restore: () => void,
            action: () => Promise<void>,
            what: string,
        ) => {
            remove();
            try {
                await action();
            } catch (e) {
                if ((e as {status?: number}).status === 404) {
                    logDebug(`${what}: already settled server-side`).catch(() => {});
                    return;
                }
                restore();
                logError(`Failed to ${what}: ${e}`).catch(() => {});
            }
        },
        [],
    );

    const replyPermission = useCallback((request: PermissionRequest, decision: PermissionDecision) => {
        const a = apiRef.current;
        if (!a) return Promise.resolve();
        return settle(
            () => setPermissions((prev) => prev.filter((p) => p.id !== request.id)),
            () => setPermissions((prev) => [...prev, request]),
            () => a.replyPermission(request.sessionID, request.id, decision),
            `reply to permission ${request.id}`,
        );
    }, [settle]);

    const replyForm = useCallback((form: FormRequest, answer: FormAnswer) => {
        const a = apiRef.current;
        if (!a) return Promise.resolve();
        return settle(
            () => setForms((prev) => prev.filter((f) => f.id !== form.id)),
            () => setForms((prev) => [...prev, form]),
            () => a.replyForm(form.sessionID, form.id, answer),
            `reply to form ${form.id}`,
        );
    }, [settle]);

    const cancelForm = useCallback((form: FormRequest) => {
        const a = apiRef.current;
        if (!a) return Promise.resolve();
        return settle(
            () => setForms((prev) => prev.filter((f) => f.id !== form.id)),
            () => setForms((prev) => [...prev, form]),
            () => a.cancelForm(form.sessionID, form.id),
            `cancel form ${form.id}`,
        );
    }, [settle]);

    // The transcript-derived gates (module store above) join the count —
    // same sidebar badge as questions.
    const subscribePendingFlags = useCallback((notify: () => void) => {
        pendingFlagsListeners.add(notify);
        return () => {
            pendingFlagsListeners.delete(notify);
        };
    }, []);
    const pendingFlags = useSyncExternalStore(
        subscribePendingFlags,
        () => pendingFlagsSnapshot,
        () => pendingFlagsSnapshot,
    );
    useEffect(() => {
        ensurePendingFlagsWiring();
    }, []);

    const pendingCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const p of permissions) counts.set(p.sessionID, (counts.get(p.sessionID) ?? 0) + 1);
        for (const f of forms) counts.set(f.sessionID, (counts.get(f.sessionID) ?? 0) + 1);
        for (const [sid, flags] of pendingFlags) {
            counts.set(sid, (counts.get(sid) ?? 0) + (flags.plan ? 1 : 0) + (flags.work ? 1 : 0));
        }
        return counts;
    }, [permissions, forms, pendingFlags]);

    return {permissions, forms, pendingCounts, replyPermission, replyForm, cancelForm};
}
