import {useEffect} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import {LuminaServerApi, useServerConnection} from "../opencode/serverConnection.ts";
import {RELAY_MAX_ATTEMPTS, createRelayLedger} from "../opencode/relay.ts";
import {ensureSessionSeeded} from "../opencode/useSessionMessages.ts";
import {useConnection} from "../opencode/connectionContext.tsx";

/**
 * The relay consumer (mounted ONCE in AppBody, beside useServerSync):
 * while a lumina-server connection is enabled, long-polls the relay
 * inbox for prompts aimed at THIS desktop's sessions and injects them
 * into the LOCAL OpenCode via the plain prompt endpoint.
 *
 * Deliberately plain: relayed prompts are text only — no vision-divert
 * re-run, no slash-command expansion (the mobile composer is a plain
 * box; richer sends stay desktop-side). The injected turn's messages
 * flow back to the server through the SYNC ENGINE: the target session
 * is ensureSessionSeeded here so its store entry exists (a session this
 * app instance never opened would otherwise have no bus tracking and
 * never mirror).
 *
 * Delivery is at-least-once (dedupe by id, ≤2 attempts — a poison
 * prompt is acked and dropped with an error log instead of clogging
 * the queue). Failures of the whole loop back off 5s and re-arm.
 */

const POLL_BACKOFF_MS = 5_000;

export function useServerRelay(): void {
    const {api} = useConnection();
    const connection = useServerConnection();
    const url = connection?.url ?? "";
    const token = connection?.token ?? "";
    const enabled = connection?.enabled === true;

    useEffect(() => {
        if (!enabled || !api || !url || !token) return;
        let cancelled = false;

        const client = new LuminaServerApi(url, token);
        const ledger = createRelayLedger();

        const deliver = async (
            prompt: {id: number; sessionId: string; from: string; text: string},
        ): Promise<void> => {
            const attempt = ledger.attempt(prompt.id);
            try {
                // Track the session even if this app never opened it —
                // otherwise the reply never mirrors.
                ensureSessionSeeded(api, prompt.sessionId);
                await api.sendPrompt(prompt.sessionId, prompt.text);
                logInfo(
                    `[server-relay] delivered prompt #${prompt.id} from ${prompt.from} to ${prompt.sessionId}`,
                ).catch(() => {});
            } catch (e) {
                if (attempt < RELAY_MAX_ATTEMPTS) {
                    // Not acked → the next poll re-delivers.
                    logError(`[server-relay] inject failed (will retry): ${e}`).catch(() => {});
                    return;
                }
                logError(
                    `[server-relay] dropping poison prompt #${prompt.id} after ${attempt} attempts: ${e}`,
                ).catch(() => {});
            }
            await client.ackRelayPrompt(prompt.id).catch((e) => {
                // An un-acked prompt re-delivers; the dedupe handles it.
                logError(`[server-relay] ack failed (#${prompt.id}): ${e}`).catch(() => {});
            });
            ledger.forget(prompt.id);
        };

        const loop = async () => {
            while (!cancelled) {
                try {
                    const {prompts} = await client.pollRelayPrompts();
                    if (cancelled) return;
                    for (const prompt of prompts) {
                        if (cancelled) return;
                        await deliver(prompt);
                    }
                } catch (e) {
                    // Network error / token revoked / server down —
                    // back off and re-arm.
                    if (!cancelled) {
                        logError(`[server-relay] poll failed: ${e}`).catch(() => {});
                        await new Promise((resolve) => setTimeout(resolve, POLL_BACKOFF_MS));
                    }
                }
            }
        };
        void loop();

        return () => {
            cancelled = true;
        };
    }, [api, url, token, enabled]);
}
