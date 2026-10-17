import {useSyncExternalStore} from "react";
import {info as logInfo} from "@tauri-apps/plugin-log";
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

/** Extract the error message a lumina-server reply carries
 * (`{error: "…"}`), falling back to the status line. Pure. */
export async function serverErrorMessage(res: Response): Promise<string> {
    const detail = await res
        .json()
        .then((body: {error?: unknown}) =>
            typeof body?.error === "string" ? body.error : "",
        )
        .catch(() => "");
    return detail || `${res.status} ${res.statusText}`;
}

/**
 * Typed client for lumina-server's REST API (the OpencodeApi pattern:
 * hand-rolled fetch, envelope-free — lumina-server returns plain JSON).
 * Errors carry the HTTP `status` on the thrown Error, like OpencodeApi.
 */
export class LuminaServerApi {
    constructor(
        private baseUrl: string,
        private token: string,
    ) {}

    private async request<T>(path: string, init?: RequestInit): Promise<T> {
        const res = await fetch(this.baseUrl + path, {
            ...init,
            headers: {
                Accept: "application/json",
                ...(init?.body !== undefined ? {"Content-Type": "application/json"} : {}),
                Authorization: `Bearer ${this.token}`,
                ...init?.headers,
            },
        });
        if (!res.ok) {
            const err = new Error(await serverErrorMessage(res));
            (err as Error & {status?: number}).status = res.status;
            throw err;
        }
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
    }

    /** Exchange credentials for a device token. Static: called before a
     * client instance exists. Throws with `.status` on failure. */
    static async login(
        url: string,
        username: string,
        password: string,
    ): Promise<{token: string; username: string}> {
        const res = await fetch(`${url}/api/auth/login`, {
            method: "POST",
            headers: {"Content-Type": "application/json", Accept: "application/json"},
            body: JSON.stringify({username, password}),
        });
        if (!res.ok) {
            const err = new Error(await serverErrorMessage(res));
            (err as Error & {status?: number}).status = res.status;
            throw err;
        }
        const body = (await res.json()) as {token?: string; user?: {username?: string}};
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
     * means the operator did not configure LUMINA_FRPS_TOKEN. */
    frpConfig(): Promise<{enabled: boolean; bindPort?: number; token?: string}> {
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
