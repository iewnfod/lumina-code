import {useCallback, useEffect, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {error, info} from "@tauri-apps/plugin-log";
import {OpencodeApi} from "./api.ts";
import {streamServerEvents, type OpencodeEvent} from "./eventStream.ts";
import {isMobileApp} from "../lib/platform.ts";
import {peekMobileConnection} from "./mobileConnection.ts";
import {reseedAllSessions} from "./useSessionMessages.ts";

/**
 * The OpenCode connection layer.
 *
 * The Rust side owns the server lifecycle (spawn `opencode serve` on a free
 * loopback port with a password we set, wait for readiness, kill on app
 * exit — see src-tauri/src/opencode.rs). This hook starts it, builds the API
 * client + auth token from the returned connection, and opens the event
 * stream (fetch-based SSE because the server requires an Authorization
 * header; see api.ts).
 */

/** Mirrors src-tauri/src/opencode.rs `OpencodeConnection`. */
interface OpencodeConnection {
    baseUrl: string;
    port: number;
    pid: number;
    version: string;
    password: string;
}

/** Mirrors src-tauri/src/opencode.rs `OpencodeStatus`. */
interface OpencodeStatusPayload {
    state: "starting" | "running" | "exited" | "error";
    message: string;
}

export type OpencodeStatus =
    | {state: "connecting"}
    | {state: "connected"; baseUrl: string; version: string}
    | {state: "error"; message: string};

export type OpencodeEventHandler = (event: OpencodeEvent) => void;

export function useOpencode(): {
    status: OpencodeStatus;
    api: OpencodeApi | null;
    /** Register a server-event handler; returns its unsubscribe fn. */
    subscribe: (handler: OpencodeEventHandler) => () => void;
} {
    const [status, setStatus] = useState<OpencodeStatus>({state: "connecting"});
    const [api, setApi] = useState<OpencodeApi | null>(null);
    const handlersRef = useRef(new Set<OpencodeEventHandler>());

    const subscribe = useCallback((handler: OpencodeEventHandler) => {
        handlersRef.current.add(handler);
        return () => {
            handlersRef.current.delete(handler);
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        let abortStream: AbortController | null = null;
        let unlistenStatus: (() => void) | undefined;

        (async () => {
            try {
                if (isMobileApp()) {
                    // REMOTE MODE (mobile v2): no local server is spawned
                    // — the full desktop tree talks to the DESKTOP's
                    // opencode through the lumina-server tunnel
                    // (/api/tunnel/opencode/**, server/tunnel.ts). The
                    // credential is the mobile's lumina DEVICE token
                    // (Bearer); the desktop injects the real opencode
                    // Basic auth when fulfilling. A missing connection
                    // (signed out) or an offline tunnel surfaces as the
                    // error status the App renders.
                    const conn = peekMobileConnection();
                    if (!conn) {
                        setStatus({state: "error", message: "Not signed in"});
                        return;
                    }
                    const baseUrl = `${conn.url}/api/tunnel/opencode`;
                    const authorization = `Bearer ${conn.token}`;
                    const client = new OpencodeApi(baseUrl, authorization);

                    abortStream = new AbortController();
                    streamServerEvents(
                        baseUrl,
                        authorization,
                        (event) => {
                            for (const handler of handlersRef.current) handler(event);
                        },
                        abortStream.signal,
                        () => {
                            // Reconnect heal: bus frames eaten by the
                            // disconnect are gone for good — re-seed every
                            // tracked session from the settled truth.
                            reseedAllSessions(client);
                        },
                    ).catch((e) => {
                        if (!cancelled) error(`Tunnel event stream ended: ${e}`).catch(() => {});
                    });

                    setApi(client);
                    setStatus({state: "connected", baseUrl, version: "tunnel"});
                    info(`Connected via tunnel at ${conn.url}`).catch(() => {});

                    client.listSessions().then((sessions) => {
                        info(`Tunnel reports ${sessions?.length ?? 0} existing session(s)`).catch(() => {});
                    }).catch((e) => {
                        // The common mobile failure: desktop offline
                        // (503) — the status stays connected so the UI
                        // renders and can show the error inline.
                        error(`Tunnel session list failed (desktop offline?): ${e}`).catch(() => {});
                    });
                    return;
                }

                // The webview origin is forwarded to `opencode serve --cors`
                // so browser-side fetch + SSE pass the server's CORS check.
                const conn = await invoke<OpencodeConnection>("opencode_start", {
                    origin: window.location.origin,
                });
                if (cancelled) return;

                const authorization = `Basic ${btoa(`opencode:${conn.password}`)}`;
                const client = new OpencodeApi(conn.baseUrl, authorization);

                // Event bus: dispatch every frame to the registered handlers.
                abortStream = new AbortController();
                streamServerEvents(
                    conn.baseUrl,
                    authorization,
                    (event) => {
                        for (const handler of handlersRef.current) handler(event);
                    },
                    abortStream.signal,
                ).catch((e) => {
                    if (!cancelled) error(`Event stream ended: ${e}`).catch(() => {});
                });

                setApi(client);
                setStatus({state: "connected", baseUrl: conn.baseUrl, version: conn.version});
                info(`Connected to OpenCode v${conn.version} at ${conn.baseUrl}`).catch(() => {});

                // One read to validate the API path; the chat view consumes
                // the rest later.
                client.listSessions().then((sessions) => {
                    info(`OpenCode reports ${sessions?.length ?? 0} existing session(s)`).catch(() => {});
                }).catch((e) => {
                    error(`Failed to list OpenCode sessions: ${e}`).catch(() => {});
                });
            } catch (e) {
                if (!cancelled) {
                    setStatus({state: "error", message: String(e)});
                    error(`OpenCode connection failed: ${e}`).catch(() => {});
                }
            }
        })();

        // Async server exits (crash, unexpected termination) surface here.
        listen<OpencodeStatusPayload>("opencode-status", (e) => {
            if (e.payload.state === "exited" || e.payload.state === "error") {
                setStatus({state: "error", message: e.payload.message});
                setApi(null);
            }
        }).then((un) => {
            if (cancelled) un();
            else unlistenStatus = un;
        }).catch((e) => {
            error(`Failed to listen for opencode-status: ${e}`).catch(() => {});
        });

        return () => {
            cancelled = true;
            abortStream?.abort();
            unlistenStatus?.();
            // Note: the server itself is NOT stopped here — its lifecycle is
            // owned by Rust (killed on app exit), so React StrictMode's
            // mount/unmount/mount cycle cannot tear it down mid-flight.
        };
    }, []);

    return {status, api, subscribe};
}
