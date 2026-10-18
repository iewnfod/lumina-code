import {useSyncExternalStore} from "react";
import {invoke} from "@tauri-apps/api/core";
import {info as logInfo} from "@tauri-apps/plugin-log";
import {isMobileApp} from "../lib/platform.ts";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * The desktop's self-hosted lumina-server connection (Settings → Server):
 * the credential store + the small typed REST client for its API.
 *
 * The server is the CREDENTIAL EXCHANGE for remote access (frp direct
 * route): when a connection is configured AND remote access is enabled,
 * the engine (hooks/useServerFrp.ts) registers the local opencode
 * password + route id with it; mobile clients fetch both and connect
 * straight to this machine's opencode through the server's frps. No
 * session content is mirrored anymore — the agent, transcripts and
 * files stay on this machine.
 *
 * The token is the server's opaque credential (`lum_…`) stored in the
 * webview's localStorage (Tauri app-data dir, on this machine only) —
 * acceptable for v1; the server-side token can be revoked any time from
 * the web console's account page.
 */

export interface ServerConnection {
    /** Server base URL, normalized (origin only, no trailing slash). */
    url: string;
    /** The bearer credential issued by /api/auth/login. */
    token: string;
    /** Account username (display + diagnostics). */
    username: string;
    /** Remote access (frp direct route for mobile clients). Opt-in:
     * it publishes this machine's opencode password to the server.
     * Absent on legacy entries = false (an old `tunnelEnabled: true`
     * carried the same intent and migrates in). */
    remoteEnabled: boolean;
    /** This desktop's frp route id (minted by the server on first
     * registration, persisted so re-registration keeps the route).
     * Absent until the first successful register. */
    frpRouteId?: string;
}

/** Normalize a user-entered server address: require http(s), take the
 * origin, strip any trailing slash. Returns null when unusable. Pure,
 * node-testable. */
export function normalizeServerUrl(raw: string): string | null {
    const trimmed = raw.trim();
    if (!/^https?:\/\//i.test(trimmed)) return null;
    try {
        const url = new URL(trimmed);
        return url.origin;
    } catch {
        return null;
    }
}

function parseConnection(raw: string | null): ServerConnection | null {
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<ServerConnection>;
        if (
            typeof parsed.url !== "string" ||
            typeof parsed.token !== "string" ||
            typeof parsed.username !== "string"
        ) {
            return null;
        }
        if (normalizeServerUrl(parsed.url) === null) return null;
        // Legacy entries predate the remote-access flag — read as off
        // (the old `tunnelEnabled` carried the same intent, so it
        // migrates in the merge).
        return {
            url: parsed.url,
            token: parsed.token,
            username: parsed.username,
            remoteEnabled: parsed.remoteEnabled === true || (parsed as {tunnelEnabled?: unknown}).tunnelEnabled === true,
            frpRouteId: typeof parsed.frpRouteId === "string" ? parsed.frpRouteId : undefined,
        };
    } catch {
        return null;
    }
}

const store = createPersistedStore<ServerConnection | null>({
    key: "lumina-code:server-connection",
    label: "server connection",
    read: parseConnection,
    write: (value) => (value === null ? null : JSON.stringify(value)),
    eq: (a, b) => a === b,
});

/** The configured connection (reactive); null = not set up. */
export function useServerConnection(): ServerConnection | null {
    return useSyncExternalStore(store.subscribe, store.get);
}

/** Store + persist a connection (after a successful login). */
export function setServerConnection(next: ServerConnection): void {
    if (store.set(next)) {
        logInfo(`Server connection configured: ${next.url} as ${next.username}`).catch(() => {});
    }
}

/** Flip the remote-access route (mobile clients connecting directly to
 * this machine's opencode through the server's frps). No-op when not
 * configured. */
export function setServerRemoteEnabled(enabled: boolean): void {
    const current = store.get();
    if (!current || current.remoteEnabled === enabled) return;
    store.set({...current, remoteEnabled: enabled});
    logInfo(`Remote access ${enabled ? "enabled" : "disabled"} (${current.url})`).catch(() => {});
}

/** Persist the frp route id the server assigned (called by the remote
 * engine after a successful registration). */
export function setServerFrpRouteId(routeId: string): void {
    const current = store.get();
    if (!current || current.frpRouteId === routeId) return;
    store.set({...current, frpRouteId: routeId});
}

/** Forget the connection locally (call after revoking server-side). */
export function clearServerConnection(): void {
    if (store.set(null)) {
        logInfo("Server connection cleared").catch(() => {});
    }
}

/**
 * Extract the error message a lumina-server reply carries
 * (`{error: "…"}`), falling back to a status line. Pure.
 */
function serverErrorMessage(status: number, body: string): string {
    try {
        const parsed = JSON.parse(body) as {error?: unknown};
        if (typeof parsed?.error === "string" && parsed.error) return parsed.error;
    } catch {
        // non-JSON body — fall through to the status line
    }
    return `${status}`;
}

/**
 * One wire call → {status, body}. TRANSPORT is platform-split:
 *
 * - DESKTOP: the Rust `lumina_request` command (src-tauri/src/
 *   lumina_http.rs — reqwest, proxies disabled). The desktop↔server
 *   channel must not ride the webview's network stack, whose
 *   libsoup/GnuTLS path proved unreliable on proxy-fronted networks
 *   (live-observed 2026-10-18: every webview fetch to the server failed
 *   with an opaque `TypeError: Load failed` while curl/bare-libsoup
 *   succeeded on the same host).
 * - MOBILE: the webview's own fetch. There the webview stack IS the OS
 *   network stack (Chromium on Android / NSURLSession on iOS — proxy-
 *   and TLS-sane, no libsoup in sight) and already carries ALL the
 *   app's opencode traffic through this very server origin
 *   (useOpencode's remote branch); the mobile crate deliberately
 *   registers no HTTP command. The server's middleware answers the
 *   cross-origin preflight for exactly these webview origins.
 */
async function serverExchange(
    baseUrl: string,
    token: string,
    method: string,
    path: string,
    body: string | null,
): Promise<{status: number; body: string}> {
    if (isMobileApp()) {
        let res: Response;
        try {
            res = await fetch(`${baseUrl}${path}`, {
                method,
                headers: {
                    Accept: "application/json",
                    ...(token ? {Authorization: `Bearer ${token}`} : {}),
                    ...(body !== null ? {"Content-Type": "application/json"} : {}),
                },
                body: body ?? undefined,
            });
        } catch (e) {
            // Transport-level failure (network/TLS) — no HTTP status.
            throw new Error(String(e));
        }
        return {status: res.status, body: await res.text()};
    }
    try {
        return await invoke("lumina_request", {baseUrl, token, method, path, body});
    } catch (e) {
        // Transport-level failure (network/proxy/TLS) — no HTTP status.
        throw new Error(String(e));
    }
}

/** Shared non-2xx mapping: a `{error}` body becomes the message, the
 * HTTP `status` rides the thrown Error (same contract as OpencodeApi). */
function httpError(status: number, body: string): Error {
    const err = new Error(serverErrorMessage(status, body));
    (err as Error & {status?: number}).status = status;
    return err;
}

/** Typed client for lumina-server's REST API. Errors carry the HTTP
 * `status` on the thrown Error, like OpencodeApi.
 */
export class LuminaServerApi {
    constructor(
        private baseUrl: string,
        private token: string,
    ) {}

    private async request<T>(
        path: string,
        init?: {method?: string; body?: string},
    ): Promise<T> {
        const reply = await serverExchange(
            this.baseUrl,
            this.token,
            init?.method ?? "GET",
            path,
            // Callers pass the pre-serialized body (the old fetch
            // RequestInit semantics) — send it through untouched.
            init?.body !== undefined ? init.body : null,
        );
        if (reply.status < 200 || reply.status >= 300) {
            throw httpError(reply.status, reply.body);
        }
        if (reply.status === 204) return undefined as T;
        return JSON.parse(reply.body) as T;
    }

    /** Exchange credentials for a device token. Static: called before a
     * client instance exists. Throws with `.status` on failure. */
    static async login(
        url: string,
        username: string,
        password: string,
    ): Promise<{token: string; username: string}> {
        const reply = await serverExchange(
            url,
            "",
            "POST",
            "/api/auth/login",
            JSON.stringify({username, password}),
        );
        if (reply.status < 200 || reply.status >= 300) {
            throw httpError(reply.status, reply.body);
        }
        const body = JSON.parse(reply.body) as {token?: string; user?: {username?: string}};
        if (typeof body.token !== "string" || !body.token) {
            throw new Error("server sent no token");
        }
        return {token: body.token, username: body.user?.username ?? username};
    }

    /** Validate the token + fetch the account (also the connectivity
     * probe the sync engine uses on connect). */
    me(): Promise<{user: {username: string; role: string}}> {
        return this.request("/api/auth/me");
    }

    /** Revoke this token server-side. Local failures still let the
     * caller clear the local connection. */
    logout(): Promise<{ok: boolean}> {
        return this.request("/api/auth/logout", {method: "POST"});
    }

    /** What the desktop needs to point frpc at the server's frps:
     * the control-channel bind port + shared token. `enabled: false`
     * means the operator did not configure LUMINA_FRPS_TOKEN.
     * `control`, when present (LUMINA_FRPS_CONTROL set server-side):
     * the WebSocket ride — frpc dials `wss://host:port/~!frp` through
     * nginx instead of raw TCP (Cloudflare-fronted deployments; the
     * dial path is FIXED in frp 0.71.x). Absent = legacy direct
     * `host:bindPort`. */
    frpConfig(): Promise<{
        enabled: boolean;
        bindPort?: number;
        token?: string;
        control?: {host: string; port: number; secure: boolean};
    }> {
        return this.request("/api/frp/config");
    }

    /** Publish the CURRENT opencode password (registration +
     * heartbeat). Re-using the previously assigned routeId keeps the
     * route stable; the server mints a fresh one otherwise. */
    frpRegister(password: string, routeId?: string): Promise<{routeId: string}> {
        return this.request("/api/frp/routes", {
            method: "PUT",
            body: JSON.stringify({password, routeId}),
        });
    }

    /** The mobile's direct-access credential: the account's current
     * desktop route + password (404 with `.status` when the account
     * never registered a desktop). */
    frpConnect(): Promise<{routeId: string; password: string; updatedAt: string}> {
        return this.request("/api/frp/connect");
    }
}
