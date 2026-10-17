import {useEffect} from "react";
import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {useConnection} from "../opencode/connectionContext.tsx";
import {
    LuminaServerApi,
    setServerFrpRouteId,
    useServerConnection,
} from "../opencode/serverConnection.ts";
import {setFrpStatus} from "../opencode/frpStatus.ts";

/**
 * The remote-access engine (mounted ONCE in AppBody): the frp direct
 * route's desktop half, replacing the old tunnel loops.
 *
 * While a lumina-server connection is configured AND remote access is
 * enabled, it (re)registers the LOCAL opencode password with the
 * server (minting/persisting the route id) and supervises the frpc
 * sidecar via the Rust frp_start/frp_stop commands. Mobile clients
 * then connect straight to this machine's opencode through
 * `/t/<routeId>/` on the server — nothing else is relayed.
 *
 * The effect re-runs whenever the LOCAL opencode handle changes (a
 * restart picks a new port + password): both the server-side registry
 * and the frpc config must be refreshed. Failures log and retry on a
 * slow timer — remote access must never degrade the local app.
 *
 * Every phase transition is mirrored into opencode/frpStatus.ts (the
 * Server pane's live connection row), and Rust's frp-status "exited"
 * (the frpc process dying unexpectedly) reconnects on the same retry
 * cadence — frpc only retries its CONNECTION internally; a dead process
 * needs the engine to bring it back.
 */

/** Registration heartbeat: refreshes the route's updatedAt (the
 * mobile's "desktop last seen" hint). frpc reconnects to frps on its
 * own; this only matters for the credential record's freshness. */
const HEARTBEAT_MS = 5 * 60_000;
/** Retry cadence when the server round-trip or frpc start failed. */
const RETRY_MS = 30_000;

/** Extract the opencode password from the client's Basic authorization
 * header (the single place that knows how the desktop's own credential
 * is shaped — the Rust side hands it to the frontend only there). */
function passwordOf(authorization: string): string | null {
    if (!authorization.startsWith("Basic ")) return null;
    try {
        const decoded = atob(authorization.slice("Basic ".length));
        const sep = decoded.indexOf(":");
        return sep === -1 ? null : decoded.slice(sep + 1);
    } catch {
        return null;
    }
}

export function useServerFrp(): void {
    const {api} = useConnection();
    const connection = useServerConnection();
    const url = connection?.url ?? "";
    const token = connection?.token ?? "";
    const enabled = connection?.remoteEnabled === true;
    const routeId = connection?.frpRouteId ?? "";

    useEffect(() => {
        if (!enabled) {
            setFrpStatus("off");
            // Off: stop any running sidecar. Idempotent — frp_stop
            // is silent when nothing was started.
            invoke("frp_stop").catch((e) => {
                logWarn(`[server-frp] stop failed: ${e}`).catch(() => {});
            });
            return;
        }
        if (!api || !url || !token) {
            // Enabled but the prerequisites are not up yet (typically the
            // local opencode handle at app boot) — the effect re-runs when
            // they arrive, so this reads as "connecting", not "off".
            setFrpStatus("starting");
            invoke("frp_stop").catch((e) => {
                logWarn(`[server-frp] stop failed: ${e}`).catch(() => {});
            });
            return;
        }

        let cancelled = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let retry: ReturnType<typeof setTimeout> | null = null;
        // The route id as THIS effect run knows it — the store copy is
        // updated for persistence, but heartbeats must re-send the id
        // the registration actually uses (sending none would mint a
        // fresh route and strand the frpc proxy on the old one).
        let currentRoute = routeId;

        const password = passwordOf(api.authorization);
        const localPort = Number(new URL(api.baseUrl).port);
        if (password === null || !Number.isFinite(localPort) || localPort <= 0) {
            logError("[server-frp] cannot derive opencode password/port from the local connection").catch(() => {});
            setFrpStatus(
                "error",
                "cannot derive opencode password/port from the local connection",
            );
            return;
        }

        const attempt = async () => {
            if (cancelled) return;
            setFrpStatus("starting");
            try {
                const client = new LuminaServerApi(url, token);
                const config = await client.frpConfig();
                if (cancelled) return;
                if (!config.enabled || config.bindPort === undefined || !config.token) {
                    // Operator-side config gap, not transient — no retry.
                    logWarn(
                        `[server-frp] ${url} has no frps configured (LUMINA_FRPS_TOKEN unset) — remote access unavailable`,
                    ).catch(() => {});
                    setFrpStatus("unavailable");
                    return;
                }
                const route = await client.frpRegister(password, currentRoute || undefined);
                currentRoute = route.routeId;
                if (cancelled) return;
                setServerFrpRouteId(route.routeId);
                // Control channel: the WebSocket ride when the server
                // fronts frps through an HTTP proxy (LUMINA_FRPS_CONTROL
                // — Cloudflare deployments MUST use it; frp's raw TCP
                // frame gets cut at the edge), else the legacy direct
                // `host:bindPort`.
                const frpsHost = config.control?.host ?? new URL(url).hostname;
                const frpsPort = config.control?.port ?? config.bindPort;
                await invoke("frp_start", {
                    addr: frpsHost,
                    port: frpsPort,
                    token: config.token,
                    routeId: route.routeId,
                    localPort,
                    secure: config.control?.secure === true,
                });
                if (cancelled) return;
                setFrpStatus("running");
                logInfo(
                    `[server-frp] route ${route.routeId} live (frps ${frpsHost}:${frpsPort}${config.control ? (config.control.secure ? " wss" : " ws") : ""})`,
                ).catch(() => {});
                // attempt() can re-run after an unexpected frpc exit —
                // drop any heartbeat a previous success armed first.
                if (heartbeat !== null) clearInterval(heartbeat);
                heartbeat = setInterval(() => {
                    new LuminaServerApi(url, token)
                        .frpRegister(password, currentRoute || undefined)
                        .catch((e) => {
                            logWarn(`[server-frp] heartbeat failed: ${e}`).catch(() => {});
                        });
                }, HEARTBEAT_MS);
            } catch (e) {
                if (cancelled) return;
                logError(`[server-frp] start failed (retrying in ${RETRY_MS / 1000}s): ${e}`).catch(() => {});
                setFrpStatus("retrying", String(e));
                retry = setTimeout(() => {
                    retry = null;
                    void attempt();
                }, RETRY_MS);
            }
        };
        void attempt();

        // Rust-side frpc lifecycle: the monitor thread surfaces unexpected
        // process exits (the route going away is the mobile's "desktop
        // offline"). frpc's loginFailExit=false only retries the CONNECTION
        // inside a live process — a dead one needs the engine to bring it
        // back, on the same retry cadence (frp_start is idempotent and its
        // internal stop does NOT emit, so this cannot self-trigger).
        let unlistenStatus: (() => void) | undefined;
        listen<{state: string; message: string}>("frp-status", (e) => {
            if (cancelled || e.payload.state !== "exited") return;
            setFrpStatus("exited", e.payload.message);
            if (retry === null) {
                retry = setTimeout(() => {
                    retry = null;
                    void attempt();
                }, RETRY_MS);
            }
        })
            .then((un) => {
                // Registration may resolve after cleanup ran — drop it
                // immediately so a late frp_stop exit cannot leak in.
                if (cancelled) {
                    un();
                } else {
                    unlistenStatus = un;
                }
            })
            .catch((e) => {
                logError(`[server-frp] failed to listen for frp-status: ${e}`).catch(() => {});
            });

        return () => {
            cancelled = true;
            if (heartbeat !== null) clearInterval(heartbeat);
            if (retry !== null) clearTimeout(retry);
            // Unlisten BEFORE frp_stop: our own deliberate stop emits an
            // "exited" that must not overwrite the status the next effect
            // run (or the off branch) is about to write.
            unlistenStatus?.();
            invoke("frp_stop").catch((e) => {
                logWarn(`[server-frp] stop failed: ${e}`).catch(() => {});
            });
        };
        // url/token/enabled are the connection's identity; `api` is the
        // local opencode handle (its identity encodes port + password).
        // routeId deliberately NOT a dep — it changes inside this effect.
    }, [api, url, token, enabled]);
}
