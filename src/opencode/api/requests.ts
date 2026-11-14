import type {
    FormAnswer,
    FormRequest,
    PermissionDecision,
    PermissionRequest,
    SavedPermission,
} from "../types.ts";
import {ApiTransport} from "./transport.ts";

/**
 * The REQUEST domain of the opencode REST client — permission asks and
 * forms (questions): the server→user blocking channels. Verified against
 * server v2.0.11.
 *
 * The npm SDK drifts here in two ways worth pinning: the reply body
 * field is `decision` (the SDK says `reply` — the server 400s with
 * `Missing key ["decision"]`), and questions ride the form system
 * (the SDK's /api/question routes 404 on this server generation).
 */
export interface RequestApi {
    listPermissionRequests(): Promise<PermissionRequest[]>;
    replyPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void>;
    listForms(): Promise<FormRequest[]>;
    replyForm(sessionId: string, formId: string, answer: FormAnswer): Promise<void>;
    cancelForm(sessionId: string, formId: string): Promise<void>;
    listSavedPermissions(projectID?: string): Promise<SavedPermission[]>;
    removeSavedPermission(id: string): Promise<void>;
}

/** The requests domain methods (see the interface); composed onto the
 *  OpencodeApi prototype in index.ts. */
export const requestsApi: RequestApi & ThisType<ApiTransport> = {
    /** Pending permission requests across ALL sessions — seeds requests
     *  that were pending before the event stream connected. The response
     *  body is `{location, data}` where `data` is the list (NOT envelope-
     *  wrapped; picking `.data` explicitly keeps that unambiguous). */
    listPermissionRequests(): Promise<PermissionRequest[]> {
        return this.requestLocationData("/api/permission/request", [] as PermissionRequest[]);
    },

    /** Answer a permission request: allow once / always allow / reject. */
    replyPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
            {method: "POST", body: JSON.stringify({decision})},
        );
    },

    /** Pending forms (questions) across ALL sessions — same seed role and
     *  same `{location, data}` shape as {@link listPermissionRequests}. */
    listForms(): Promise<FormRequest[]> {
        return this.requestLocationData("/api/form", [] as FormRequest[]);
    },

    /** Answer a form: one value per field key. */
    replyForm(sessionId: string, formId: string, answer: FormAnswer): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
            {method: "POST", body: JSON.stringify({answer})},
        );
    },

    /** Cancel (dismiss) a pending form — the waiting tool sees "cancelled". */
    cancelForm(sessionId: string, formId: string): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`,
            {method: "DELETE"},
        );
    },

    /** Saved permissions — the durable project-scoped allow rules the user
     *  created via "always allow" (spike-verified against server v2.0.11).
     *  QUIRK: the query param's shape decides the scope — NO param returns
     *  only the SERVER'S OWN location's project (useless here), `?projectID=`
     *  EMPTY returns EVERY project's rules, and a real id filters to it. We
     *  therefore always send the param: omitting `projectID` deliberately
     *  requests the full list (the caller filters client-side via the
     *  `projectID` field, which every entry carries). */
    listSavedPermissions(projectID?: string): Promise<SavedPermission[]> {
        return this.request<SavedPermission[]>(
            `/api/permission/saved?projectID=${encodeURIComponent(projectID ?? "")}`,
        );
    },

    /** Revoke one saved permission (no PATCH on this server generation —
     *  delete + re-approve is the only edit path). 204 on success. */
    removeSavedPermission(id: string): Promise<void> {
        return this.request<void>(
            `/api/permission/saved/${encodeURIComponent(id)}`,
            {method: "DELETE"},
        );
    }
};
