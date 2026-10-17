import {useEffect} from "react";
import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {invoke} from "@tauri-apps/api/core";
import {useConnection} from "../opencode/connectionContext.tsx";
import {
    LuminaServerApi,
    setServerFrpRouteId,
    useServerConnection,
} from "../opencode/serverConnection.ts";

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
        if (!enabled || !api || !url || !token) {
            // Off/disabled: stop any running sidecar. Idempotent — frp_stop
            // is silent when nothing was started.
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
            return;
        }

        const attempt = async () => {
            try {
                const client = new LuminaServerApi(url, token);
                const config = await client.frpConfig();
                if (!config.enabled || config.bindPort === undefined || !config.token) {
                    // Operator-side config gap, not transient — no retry.
                    logWarn(
                        `[server-frp] ${url} has no frps configured (LUMINA_FRPS_TOKEN unset) — remote access unavailable`,
                    ).catch(() => {});
                    return;
                }
                const route = await client.frpRegister(password, currentRoute || undefined);
                currentRoute = route.routeId;
                if (cancelled) return;
                setServerFrpRouteId(route.routeId);
                await invoke("frp_start", {
                    addr: new URL(url).hostname,
                    port: config.bindPort,
                    token: config.token,
                    routeId: route.routeId,
                    localPort,
                });
                if (cancelled) return;
                logInfo(`[server-frp] route ${route.routeId} live (frps ${new URL(url).hostname}:${config.bindPort})`).catch(() => {});
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
                retry = setTimeout(() => void attempt(), RETRY_MS);
            }
        };
        void attempt();

        return () => {
            cancelled = true;
            if (heartbeat !== null) clearInterval(heartbeat);
            if (retry !== null) clearTimeout(retry);
            invoke("frp_stop").catch((e) => {
                logWarn(`[server-frp] stop failed: ${e}`).catch(() => {});
            });
        };
        // url/token/enabled are the connection's identity; `api` is the
        // local opencode handle (its identity encodes port + password).
        // routeId deliberately NOT a dep — it changes inside this effect.
    }, [api, url, token, enabled]);
}
