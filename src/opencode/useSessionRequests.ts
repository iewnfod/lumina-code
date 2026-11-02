import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import {debug as logDebug, error as logError} from "@tauri-apps/plugin-log";
import {createModuleStore} from "../lib/moduleStore.ts";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {ChatMessage, EventMap, FormAnswer, FormRequest, PermissionDecision, PermissionRequest} from "./types.ts";
import {peekSessionMessages, subscribeSessionMessages, trackedSessionIds} from "./useSessionMessages.ts";
import {collectSessionSubagents, planApprovalPending, workApprovalPending} from "./sessionActivity.ts";

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
const pendingFlagsStore = createModuleStore<ReadonlyMap<string, PendingFlags>>(new Map());
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
    const prev = pendingFlagsStore.get().get(sessionId) ?? NO_FLAGS;
    if (flags.plan === prev.plan && flags.work === prev.work) return;
    const next = new Map(pendingFlagsStore.get());
    if (flags.plan || flags.work) next.set(sessionId, flags);
    else next.delete(sessionId);
    pendingFlagsStore.set(next);
}

/** Drop a deleted session's entry (its message store entry goes with it). */
function dropPendingFlags(sessionId: string): void {
    if (!pendingFlagsStore.get().has(sessionId)) return;
    const next = new Map(pendingFlagsStore.get());
    next.delete(sessionId);
    pendingFlagsStore.set(next);
}

/** Read-only peek at ONE session's gate flags (the desktop-notification
 * composer asks WHICH attention kind just appeared; pendingCounts only
 * carries counts). Same shape the badge pipeline folds. */
export function peekGateFlags(sessionId: string): {plan: boolean; work: boolean} {
    return pendingFlagsStore.get().get(sessionId) ?? NO_FLAGS;
}

/** Install the message-store watcher once per app run. */
function ensurePendingFlagsWiring(): void {
    if (pendingFlagsWired) return;
    pendingFlagsWired = true;
    subscribeSessionMessages((sessionId) => recomputePendingFlags(sessionId));
}

// --- Subagent child asks → their PARENT session (badge merge) ----------------

/** child session id → parent session id. The sidebar lists ROOT sessions
 *  only, so a subagent child's pending ask (its execution blocked
 *  server-side, e.g. an external_directory read) would have no row to
 *  badge — the ask merges into the PARENT's badge instead. The parent's
 *  transcript holds the spawn part whose metadata.sessionID is the child
 *  link (collectSessionSubagents), and that link is in the store before
 *  the child's first ask can arrive (tool.progress precedes any child
 *  tool call). */
const childParents = new Map<string, string>();

/** Rebuild the child→parent map from the tracked message stores. Run
 *  ONLY when pending asks arrive (seed + permission.asked/form.created)
 *  — a linear scan over already-materialized transcripts, never per
 *  streaming delta. Runs BEFORE the ask's setState so the pendingCounts
 *  memo (which does not depend on the map's identity) recomputes with
 *  the fresh mapping in the same render pass. */
function resolveChildParents(): void {
    childParents.clear();
    for (const sessionId of trackedSessionIds()) {
        const messages = peekSessionMessages(sessionId);
        if (!messages) continue;
        for (const ref of collectSessionSubagents(messages as ChatMessage[])) {
            if (!childParents.has(ref.id)) childParents.set(ref.id, sessionId);
        }
    }
}

/** The parent session id behind a subagent child, when known — the
 *  notification composer uses this to name the conversation a child's
 *  ask belongs to (child sessions are not in the root-only list). */
export function peekSessionParent(childId: string): string | undefined {
    return childParents.get(childId);
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
    // stream and would otherwise never surface. The child→parent map
    // resolves first so seed-time child asks merge into their parent's
    // badge in the same commit.
    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        api.listPermissionRequests().then((list) => {
            if (!cancelled) {
                resolveChildParents();
                setPermissions(list);
            }
        }).catch((e) => {
            logError(`Failed to load pending permission requests: ${e}`).catch(() => {});
        });
        api.listForms().then((list) => {
            if (!cancelled) {
                resolveChildParents();
                setForms(list);
            }
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
                    resolveChildParents();
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
                    resolveChildParents();
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
    const pendingFlags = useSyncExternalStore(
        pendingFlagsStore.subscribe,
        pendingFlagsStore.get,
        pendingFlagsStore.get,
    );
    useEffect(() => {
        ensurePendingFlagsWiring();
    }, []);

    const pendingCounts = useMemo(() => {
        const counts = new Map<string, number>();
        const add = (sessionId: string, n: number) => {
            counts.set(sessionId, (counts.get(sessionId) ?? 0) + n);
        };
        // A subagent child's ask counts for the child AND its parent: the
        // child itself has no sidebar row (root sessions only), so the
        // parent's badge is where the user sees it. The map is refreshed
        // right before these arrays change (resolveChildParents), so the
        // memo's missing dependency on it is safe by construction.
        for (const p of permissions) {
            add(p.sessionID, 1);
            const parent = childParents.get(p.sessionID);
            if (parent !== undefined) add(parent, 1);
        }
        for (const f of forms) {
            add(f.sessionID, 1);
            const parent = childParents.get(f.sessionID);
            if (parent !== undefined) add(parent, 1);
        }
        for (const [sid, flags] of pendingFlags) {
            add(sid, (flags.plan ? 1 : 0) + (flags.work ? 1 : 0));
        }
        return counts;
    }, [permissions, forms, pendingFlags]);

    return {permissions, forms, pendingCounts, replyPermission, replyForm, cancelForm};
}
