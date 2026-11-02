import {useCallback, useEffect, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {error, info, warn} from "@tauri-apps/plugin-log";
import {OpencodeApi} from "./api.ts";
import {streamServerEvents, type OpencodeEvent} from "./eventStream.ts";
import {isMobileApp, remoteCorsOrigins} from "../lib/platform.ts";
import {peekMobileConnection} from "./mobileConnection.ts";
import {LuminaServerApi} from "./serverConnection.ts";
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
    | {state: "connected"; baseUrl: string; version: string | null}
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

        // The About pane's version read: the handshake value is the SPAWN
        // side's parse (and null on the frp path — no local binary), so
        // once connected we ask the server ITSELF via GET /api/info and
        // refine the status in place. Cosmetic on the local shell (same
        // number), the honest source on remote.
        const settleServerVersion = (client: OpencodeApi) => {
            client.serverInfo().then((info) => {
                if (cancelled) return;
                setStatus((prev) => (prev.state === "connected" ? {...prev, version: info.version} : prev));
            }).catch((e) => {
                warn(`Server info query failed (version stays handshake-reported): ${e}`).catch(() => {});
            });
        };

        (async () => {
            try {
                if (isMobileApp()) {
                    // REMOTE MODE (mobile v2): no local server is spawned
                    // — the full desktop tree talks DIRECTLY to the
                    // desktop's opencode through the server's frp route
                    // (`<server>/t/<routeId>/` — nginx strips the prefix,
                    // frps routes by Host, the desktop's frpc pipes to
                    // 127.0.0.1). The credential comes from the server's
                    // credential exchange: GET /api/frp/connect returns
                    // the account's current route id + the desktop's
                    // opencode password (registered by the desktop's
                    // remote-access engine, hooks/useServerFrp.ts).
                    const conn = peekMobileConnection();
                    if (!conn) {
                        setStatus({state: "error", message: "Not signed in"});
                        return;
                    }
                    const server = new LuminaServerApi(conn.url, conn.token);

                    // Credential acquisition loop: a 404 (the desktop
                    // never registered) or 503 (server without frps)
                    // renders an honest error but keeps retrying — the
                    // desktop may come online at any moment.
                    const fetchConnect = async (): Promise<{routeId: string; password: string}> => {
                        for (;;) {
                            if (cancelled) throw new Error("cancelled");
                            try {
                                return await server.frpConnect();
                            } catch (e) {
                                const status = (e as {status?: number}).status;
                                if (!cancelled) {
                                    setStatus({
                                        state: "error",
                                        message:
                                            status === 404
                                                ? "No desktop registered for this account (enable remote access in the desktop's Server settings)"
                                                : String(e),
                                    });
                                }
                                await new Promise((r) => setTimeout(r, 5000));
                            }
                        }
                    };
                    const first = await fetchConnect();

                    const build = (connect: {routeId: string; password: string}) => {
                        const baseUrl = `${conn.url}/t/${connect.routeId}`;
                        const authorization = `Basic ${btoa(`opencode:${connect.password}`)}`;
                        return new OpencodeApi(baseUrl, authorization);
                    };
                    const openStream = (client: OpencodeApi) => {
                        abortStream?.abort();
                        abortStream = new AbortController();
                        streamServerEvents(
                            client.baseUrl,
                            client.authorization,
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
                            if (!cancelled) error(`Remote event stream ended: ${e}`).catch(() => {});
                        });
                    };

                    const client = build(first);
                    openStream(client);
                    setApi(client);
                    setStatus({state: "connected", baseUrl: client.baseUrl, version: null});
                    settleServerVersion(client);
                    info(`Connected via frp route ${first.routeId} at ${conn.url}`).catch(() => {});

                    // LIVENESS + CREDENTIAL GATE. Phase 1 (fast poll,
                    // 2s): the one-shot seeds that fire on the api flip
                    // above can fail while the desktop is still offline
                    // (frps 404s the unrouted path) and nothing retries
                    // them — probe the data path and RE-ISSUE the api
                    // handle on recovery so every api-keyed seed
                    // (useSessions, useModelCatalog) re-runs off the new
                    // identity. Phase 2 (slow watch, 30s): a 401 means
                    // the desktop restarted and rotated its opencode
                    // password — re-fetch the connect info, rebuild the
                    // handle + stream, reseed. Non-401 blips stay
                    // connected (the stream's own heal covers them).
                    const gate = async () => {
                        for (let attempt = 0; ; attempt++) {
                            if (cancelled) return;
                            try {
                                await client.listSessions();
                                if (attempt === 0) {
                                    info("Remote route is live").catch(() => {});
                                } else {
                                    info("Remote route recovered — re-issuing api handle to re-seed global state").catch(() => {});
                                    setApi(build(first));
                                }
                                break;
                            } catch (e) {
                                if (attempt === 0) {
                                    error(`Remote session list failed (desktop offline?); will retry: ${e}`).catch(() => {});
                                }
                                await new Promise((r) => setTimeout(r, 2000));
                            }
                        }
                        for (;;) {
                            await new Promise((r) => setTimeout(r, 30_000));
                            if (cancelled) return;
                            try {
                                await client.listSessions();
                            } catch (e) {
                                if (cancelled) return;
                                if ((e as {status?: number}).status !== 401) continue;
                                info("Remote credentials rotated — re-fetching frp connect info").catch(() => {});
                                try {
                                    const fresh = build(await server.frpConnect());
                                    openStream(fresh);
                                    setApi(fresh);
                                    reseedAllSessions(fresh);
                                    setStatus({state: "connected", baseUrl: fresh.baseUrl, version: null});
                                    settleServerVersion(fresh);
                                    return; // healed; later drops are the stream's own heal
                                } catch (re) {
                                    error(`frp connect re-fetch failed: ${re}`).catch(() => {});
                                }
                            }
                        }
                    };
                    void gate();
                    return;
                }

                // The webview origins are forwarded to the repeatable
                // `--cors` flag: our own origin plus the REMOTE mobile
                // origins that reach this server through the frp route.
                const conn = await invoke<OpencodeConnection>("opencode_start", {
                    origins: [window.location.origin, ...remoteCorsOrigins()],
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
                settleServerVersion(client);
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
