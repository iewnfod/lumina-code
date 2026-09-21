import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {
    EventMap,
    FormAnswer,
    FormRequest,
    PermissionDecision,
    PermissionRequest,
} from "./types.ts";

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
 */
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
                    break;
                }
            }
        });
    }, [subscribe]);

    /** Fire-and-track: remove optimistically, restore on failure (the
     *  server also confirms via replied/cancelled events — idempotent). */
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

    const pendingCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const p of permissions) counts.set(p.sessionID, (counts.get(p.sessionID) ?? 0) + 1);
        for (const f of forms) counts.set(f.sessionID, (counts.get(f.sessionID) ?? 0) + 1);
        return counts;
    }, [permissions, forms]);

    return {permissions, forms, pendingCounts, replyPermission, replyForm, cancelForm};
}
