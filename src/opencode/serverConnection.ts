import {useSyncExternalStore} from "react";
import {info as logInfo} from "@tauri-apps/plugin-log";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * The desktop's self-hosted lumina-server connection (Settings → Server):
 * the credential store + the small typed REST client for its API.
 *
 * Relay model: the agent ALWAYS runs locally; when a connection is
 * configured AND enabled, the sync engine (opencode/serverSync.ts)
 * mirrors the local session list and message snapshots UP to this
 * server so other devices can browse them. Nothing here touches the
 * local OpenCode connection.
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
    /** Sync active. Connection stays configured when switched off. */
    enabled: boolean;
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
            typeof parsed.username !== "string" ||
            typeof parsed.enabled !== "boolean"
        ) {
            return null;
        }
        if (normalizeServerUrl(parsed.url) === null) return null;
        return parsed as ServerConnection;
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

/** Flip the sync enablement (connection stays configured). No-op when
 * not configured. */
export function setServerSyncEnabled(enabled: boolean): void {
    const current = store.get();
    if (!current || current.enabled === enabled) return;
    store.set({...current, enabled});
    logInfo(`Server sync ${enabled ? "enabled" : "disabled"} (${current.url})`).catch(() => {});
}

/** Forget the connection locally (call after revoking server-side). */
export function clearServerConnection(): void {
    if (store.set(null)) {
        logInfo("Server connection cleared").catch(() => {});
    }
}

/** Read the current connection outside React (the sync engine runs from
 * event handlers, not render). */
export function peekServerConnection(): ServerConnection | null {
    return store.get();
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

    /** Push the desktop's FULL session list (idempotent upsert; the
     * server tombstones this account's sessions missing from the list). */
    pushSessions(
        sessions: {
            id: string;
            title: string;
            directory: string;
            model: string;
            agent: string;
            updatedAt: string;
        }[],
    ): Promise<{upserted: number; tombstoned: number}> {
        return this.request("/api/sync/sessions", {
            method: "POST",
            body: JSON.stringify({sessions}),
        });
    }

    /** Replace one session's message snapshot. */
    pushSessionMessages(
        sessionId: string,
        messages: unknown[],
    ): Promise<{count: number}> {
        return this.request(`/api/sync/sessions/${encodeURIComponent(sessionId)}/messages`, {
            method: "POST",
            body: JSON.stringify({messages}),
        });
    }
}

/** A convenience factory over the CURRENT stored connection (the sync
 * engine's entry point); null when not configured. */
export function serverApiFromStore(): LuminaServerApi | null {
    const conn = store.get();
    return conn ? new LuminaServerApi(conn.url, conn.token) : null;
}
