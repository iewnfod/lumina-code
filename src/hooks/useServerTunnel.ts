import {useEffect} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import {useConnection} from "../opencode/connectionContext.tsx";
import {useServerConnection} from "../opencode/serverConnection.ts";
import {streamServerEvents} from "../opencode/eventStream.ts";
import {
    TUNNEL_BACKOFF_MS,
    runCommandLoop,
    runEventLoop,
} from "../opencode/tunnelClient.ts";

/**
 * The opencode tunnel's DESKTOP half (mounted ONCE in AppBody, beside
 * useServerSync): while a lumina-server connection is configured AND
 * tunnel-enabled (Settings → Server 的远程访问开关), claims the
 * account's tunnel and serves proxied opencode API calls + forwards
 * the local event bus to the server's fan-out (see
 * opencode/tunnelClient.ts for the protocol).
 *
 * Requires the LOCAL opencode connection (the api handle from the
 * connection context — it carries the base URL + authorization the
 * fulfillment needs). Exits cleanly on any dependency change; errors
 * back off TUNNEL_BACKOFF_MS and re-claim (a server restart drops
 * tunnels in-memory — the loop heals within one backoff window).
 */

export function useServerTunnel(): void {
    const {api} = useConnection();
    const connection = useServerConnection();
    const url = connection?.url ?? "";
    const token = connection?.token ?? "";
    const enabled = connection?.enabled === true && connection.tunnelEnabled === true;

    useEffect(() => {
        if (!enabled || !api || !url || !token) return;
        let cancelled = false;
        let abort: AbortController | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        const deps = () => ({
            serverUrl: url,
            token,
            localBaseUrl: api.baseUrl,
            localAuthorization: api.authorization,
            // BOUND on purpose: WebKitGTK's Window.fetch enforces its
            // receiver ("Can only call Window.fetch on instances of
            // Window"), and an unbound `fetchImpl: fetch` is later invoked
            // as deps.fetchImpl(...) — receiver `deps` — so EVERY tunnel
            // call threw and the desktop never claimed the tunnel (the
            // mobile then saw 503 desktop-offline for all data). Node
            // tests and Chromium don't check the receiver, which is why
            // only the webkit shell hit this.
            fetchImpl: fetch.bind(globalThis),
            log: (m: string) => {
                logInfo(`[server-tunnel] ${m}`).catch(() => {});
            },
            warn: (m: string) => {
                logError(`[server-tunnel] ${m}`).catch(() => {});
            },
            signal: abort!.signal,
        });

        const runOnce = async () => {
            abort = new AbortController();
            // The two loops are independent: commands and event
            // forwarding each heal on their own; the tunnel is owned
            // by the command loop's claim.
            await Promise.all([
                runCommandLoop(deps()).catch((e) => {
                    // Claim/poll failures MUST surface (§3.5): this catch
                    // used to swallow them silently, which is how the
                    // unbound-fetch TypeError above hid for so long.
                    logError(`[server-tunnel] command loop failed: ${e}`).catch(() => {});
                    return "error" as const;
                }),
                runEventLoop(
                    deps(),
                    (onEvent, signal) =>
                        streamServerEvents(api.baseUrl, api.authorization, onEvent, signal),
                ),
            ]).catch(() => {});
            if (cancelled) return;
            retryTimer = setTimeout(() => void runOnce(), TUNNEL_BACKOFF_MS);
        };

        logInfo(`[server-tunnel] starting tunnel to ${url}`).catch(() => {});
        void runOnce();

        return () => {
            cancelled = true;
            abort?.abort();
            if (retryTimer) clearTimeout(retryTimer);
            logInfo("[server-tunnel] stopped").catch(() => {});
        };
    }, [api, url, token, enabled]);
}
