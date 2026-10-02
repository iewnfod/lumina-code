import type {PermissionDecision, PermissionRequest} from "../../opencode/types.ts";

/** One merged pending ask: N wire-level permission requests that are the
 * SAME question (identical action + resources). The server fires one
 * assert per tool invocation with no cross-call dedup (verified against
 * v2.0.11's FileAccess.authorizeExternal), so parallel reads of the same
 * external directory stack 2+ identical asks — one card answers them
 * all. */
export interface PermissionGroup {
    /** action + resources — identical asks share it. */
    key: string;
    /** The identical requests, first-seen order; [0] renders the card. */
    requests: PermissionRequest[];
}

const SEPARATOR_ACTION = "\u0000";
const SEPARATOR_RESOURCE = "\u0001";

/** Group identical pending asks (same action + same resource list).
 * First-seen order keeps the card stack stable as asks arrive; a new
 * identical ask joins its existing group (no visual change). */
export function groupPermissionRequests(requests: PermissionRequest[]): PermissionGroup[] {
    const groups: PermissionGroup[] = [];
    const byKey = new Map<string, PermissionGroup>();
    for (const request of requests) {
        const key = request.action + SEPARATOR_ACTION + request.resources.join(SEPARATOR_RESOURCE);
        const existing = byKey.get(key);
        if (existing) {
            existing.requests.push(request);
            continue;
        }
        const group: PermissionGroup = {key, requests: [request]};
        byKey.set(key, group);
        groups.push(group);
    }
    return groups;
}

/** Map one group decision to per-request decisions:
 * - `once` / `reject` → the same decision for every request. Reject also
 *   cascades server-side (one reject settles every pending ask of the
 *   session), so later replies 404 — the caller treats that as settled.
 * - `always` → only the FIRST request carries `always`: the server saves
 *   the rule on that reply alone (a sibling `always` would save it
 *   twice), while the rest get `once` — this run is allowed either way,
 *   and the server's always-cascade may already have settled them. */
export function groupReplyPlan(
    requests: PermissionRequest[],
    decision: PermissionDecision,
): {request: PermissionRequest; decision: PermissionDecision}[] {
    return requests.map((request, index) => ({
        request,
        decision: decision === "always" && index > 0 ? "once" : decision,
    }));
}
