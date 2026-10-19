import {useCallback, useEffect, useState} from "react";
import {openUrl} from "@tauri-apps/plugin-opener";
import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "../opencode/api.ts";
import type {IntegrationOAuthMethod, OAuthAttempt} from "../opencode/types.ts";

/** One OAuth flow's tracked state — bound to its integration + method
 *  while pending. */
export interface OAuthFlow {
    integrationId: string;
    method: IntegrationOAuthMethod;
    attempt: OAuthAttempt;
    status: "pending" | "complete" | "failed" | "expired";
}

/**
 * The Model pane's browser-OAuth state machine (one flow at a time):
 * start posts the attempt and opens the URL in the system browser, a
 * 2s poll watches the attempt leave "pending" (a completed flow
 * refreshes the integrations list), and cancel aborts a pending
 * attempt server-side. Extracted from ModelSettings.tsx's shell.
 */
export function useIntegrationOAuth(
    api: OpencodeApi | null,
    onActionError: (message: string | null) => void,
    onBusyChange: (busy: boolean) => void,
    loadIntegrations: () => void,
): {
    oauth: OAuthFlow | null;
    startOAuth: (integrationId: string, method: IntegrationOAuthMethod) => void;
    cancelOAuth: () => void;
} {
    const [oauth, setOauth] = useState<OAuthFlow | null>(null);

    // --- OAuth polling ---
    useEffect(() => {
        if (!api || !oauth || oauth.status !== "pending") return;
        const {integrationId, attempt} = oauth;
        const timer = setInterval(() => {
            api.getIntegrationOAuthStatus(integrationId, attempt.attemptID).then((status) => {
                if (status.status === "pending") return;
                setOauth((cur) =>
                    cur && cur.attempt.attemptID === attempt.attemptID
                        ? {...cur, status: status.status}
                        : cur,
                );
                if (status.status === "complete") {
                    logInfo(`OAuth login complete for ${integrationId}`).catch(() => {});
                    loadIntegrations();
                }
            }).catch((e) => {
                logWarn(`OAuth status poll failed: ${e}`).catch(() => {});
            });
        }, 2000);
        return () => clearInterval(timer);
    }, [api, oauth, loadIntegrations]);

    /** Stop the pending attempt server-side and drop the flow UI. */
    const cancelOAuth = useCallback(() => {
        if (!api || !oauth) return;
        const {integrationId, attempt} = oauth;
        setOauth(null);
        api.cancelIntegrationOAuth(integrationId, attempt.attemptID).catch((e) => {
            logWarn(`Failed to cancel OAuth attempt: ${e}`).catch(() => {});
        });
    }, [api, oauth]);

    const startOAuth = useCallback((integrationId: string, method: IntegrationOAuthMethod) => {
        if (!api) return;
        onActionError(null);
        onBusyChange(true);
        // A superseded pending attempt for the same integration is
        // cancelled fire-and-forget (attempts also expire server-side).
        setOauth((cur) => {
            if (cur && cur.status === "pending" && cur.integrationId === integrationId) {
                api.cancelIntegrationOAuth(integrationId, cur.attempt.attemptID).catch((e) => {
                    logWarn(`Failed to cancel superseded OAuth attempt: ${e}`).catch(() => {});
                });
            }
            return cur;
        });
        api.startIntegrationOAuth(integrationId, method.id).then((attempt) => {
            setOauth({integrationId, method, attempt, status: "pending"});
            openUrl(attempt.url).catch((e) => {
                logWarn(`Failed to open OAuth URL: ${e}`).catch(() => {});
            });
        }).catch((e) => {
            onActionError(String(e));
            logError(`Failed to start OAuth for ${integrationId}: ${e}`).catch(() => {});
        }).finally(() => onBusyChange(false));
    }, [api, onActionError, onBusyChange]);

    return {oauth, startOAuth, cancelOAuth};
}
