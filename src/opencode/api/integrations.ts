import type {
    IntegrationInfo,
    OAuthAttempt,
    OAuthAttemptStatus,
} from "../types.ts";
import {ApiTransport} from "./transport.ts";

/**
 * The INTEGRATION + CREDENTIAL domain of the opencode REST client —
 * provider authentication: API keys, browser OAuth flows, stored
 * credential management. Verified against server v2.0.11.
 */
export interface IntegrationApi {
    listIntegrations(): Promise<IntegrationInfo[]>;
    connectIntegrationKey(
        integrationId: string,
        key: string,
        answer?: Record<string, string>,
    ): Promise<void>;
    startIntegrationOAuth(integrationId: string, methodId: string): Promise<OAuthAttempt>;
    getIntegrationOAuthStatus(integrationId: string, attemptId: string): Promise<OAuthAttemptStatus>;
    cancelIntegrationOAuth(integrationId: string, attemptId: string): Promise<void>;
    deleteCredential(credentialId: string): Promise<void>;
    activateCredential(credentialId: string): Promise<void>;
}

/** The integrations domain methods (see the interface); composed onto the
 *  OpencodeApi prototype in index.ts. */
export const integrationsApi: IntegrationApi & ThisType<ApiTransport> = {
    /** Every authenticatable provider with its auth methods and current
     *  connections. Response is `{location, data}` (NOT envelope-wrapped). */
    listIntegrations(): Promise<IntegrationInfo[]> {
        return this.requestLocationData("/api/integration", [] as IntegrationInfo[]);
    },

    /** Store an API-key credential for an integration — the new credential
     *  auto-activates and its provider goes live immediately (204 reply,
     *  then `credential.updated` on the bus). `answer` carries any extra
     *  form fields the method declares (e.g. Azure's `resourceName`). */
    connectIntegrationKey(
        integrationId: string,
        key: string,
        answer?: Record<string, string>,
    ): Promise<void> {
        const body: {key: string; answer?: Record<string, string>} = {key};
        if (answer) body.answer = answer;
        return this.request<void>(
            `/api/integration/${encodeURIComponent(integrationId)}/connect/key`,
            {method: "POST", body: JSON.stringify(body)},
        );
    },

    /** Start a browser OAuth flow: returns the URL to open in the system
     *  browser; poll {@link getIntegrationOAuthStatus} until it leaves
     *  "pending". The server itself listens on the loopback redirect. */
    startIntegrationOAuth(integrationId: string, methodId: string): Promise<OAuthAttempt> {
        return this.requestRaw<{data?: OAuthAttempt}>(
            `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth`,
            {method: "POST", body: JSON.stringify({methodID: methodId})},
        ).then((r) => {
            if (!r?.data) throw new Error("oauth attempt came back empty");
            return r.data;
        });
    },

    /** Poll an OAuth attempt: "pending" → "complete" | "failed" | "expired". */
    getIntegrationOAuthStatus(integrationId: string, attemptId: string): Promise<OAuthAttemptStatus> {
        return this.requestLocationData<OAuthAttemptStatus>(
            `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}`,
            {status: "pending"},
        );
    },

    /** Abort a pending OAuth attempt (204). */
    cancelIntegrationOAuth(integrationId: string, attemptId: string): Promise<void> {
        return this.request<void>(
            `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}`,
            {method: "DELETE"},
        );
    },

    /** Remove a stored credential (204). Removing the last credential
     *  deactivates the provider. */
    deleteCredential(credentialId: string): Promise<void> {
        return this.request<void>(`/api/credential/${encodeURIComponent(credentialId)}`, {
            method: "DELETE",
        });
    },

    /** Make a stored credential the active one (204) — only meaningful
     *  when an integration holds several. */
    activateCredential(credentialId: string): Promise<void> {
        return this.request<void>(`/api/credential/${encodeURIComponent(credentialId)}/activate`, {
            method: "POST",
        });
    }
};
