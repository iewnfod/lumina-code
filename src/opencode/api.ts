import type {ChatMessage, OpencodeSession} from "./types.ts";
export type {Session} from "@opencode-ai/sdk/v2/client";
export type {ChatMessage, OpencodeSession} from "./types.ts";

/**
 * Thin typed REST client for the opencode server.
 *
 * Hand-rolled instead of using the SDK's runtime because the installed
 * server (v2.0.x) and the SDK's generated client drift on paths and body
 * encoding — the few endpoints we use are more predictable pinned here, in
 * one file, against the paths verified against the real server:
 *   GET    /api/session                  → list sessions
 *   POST   /api/session                  → create session
 *   DELETE /api/session/{id}             → delete session
 *   GET    /api/session/{id}/message     → messages (order=asc)
 *   POST   /api/session/{id}/prompt      → send prompt `{text}`
 *   POST   /api/session/{id}/interrupt   → stop a running session
 *
 * The SDK stays as the source of some TypeScript shapes (types-only import).
 *
 * Response envelope: the server wraps payloads as `{"data": ...}`; unwrap
 * when present so callers get the raw payload.
 */

export class OpencodeApi {
    constructor(
        private baseUrl: string,
        private authorization: string,
    ) {}

    private async request<T>(path: string, init?: RequestInit): Promise<T> {
        const res = await fetch(this.baseUrl + path, {
            ...init,
            headers: {
                Accept: "application/json",
                ...(init?.body !== undefined ? {"Content-Type": "application/json"} : {}),
                Authorization: this.authorization,
                ...init?.headers,
            },
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
        }
        if (res.status === 204) return undefined as T;
        const json: unknown = await res.json();
        if (json !== null && typeof json === "object" && "data" in json) {
            return (json as {data: T}).data;
        }
        return json as T;
    }

    listSessions(): Promise<OpencodeSession[]> {
        return this.request<OpencodeSession[]>("/api/session");
    }

    createSession(body: {title?: string} = {}): Promise<OpencodeSession> {
        return this.request<OpencodeSession>("/api/session", {
            method: "POST",
            body: JSON.stringify(body),
        });
    }

    deleteSession(sessionId: string): Promise<void> {
        return this.request<void>(`/api/session/${encodeURIComponent(sessionId)}`, {
            method: "DELETE",
        });
    }

    /** Messages oldest-first. Cursor pagination available if ever needed. */
    listMessages(sessionId: string): Promise<ChatMessage[]> {
        return this.request<ChatMessage[]>(
            `/api/session/${encodeURIComponent(sessionId)}/message?order=asc&limit=200`,
        );
    }

    /** Sends a prompt; the reply streams in over the event bus. */
    sendPrompt(sessionId: string, text: string): Promise<unknown> {
        return this.request(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
            method: "POST",
            body: JSON.stringify({text}),
        });
    }

    /** Stop a running session. Returns whether an execution was interrupted. */
    interruptSession(sessionId: string): Promise<boolean> {
        return this.request<{interrupted: boolean}>(
            `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
            {method: "POST"},
        ).then((r) => r?.interrupted ?? false);
    }
}

/**
 * Envelope of one SSE bus frame: `data: {"id","type","data"}` (the payload
 * field is `data`, and the server sends `: heartbeat` comment lines to keep
 * the connection alive).
 */
export interface OpencodeEvent {
    type: string;
    data: unknown;
}

/**
 * SSE over fetch (the server requires an Authorization header, which the
 * native EventSource cannot send). Reconnects with a small backoff until the
 * abort signal fires; each parsed frame is handed to `onEvent`.
 */
export async function streamServerEvents(
    baseUrl: string,
    authorization: string,
    onEvent: (event: OpencodeEvent) => void,
    signal: AbortSignal,
): Promise<void> {
    let retryDelayMs = 500;
    while (!signal.aborted) {
        try {
            const res = await fetch(baseUrl + "/api/event", {
                headers: {Accept: "text/event-stream", Authorization: authorization},
                signal,
            });
            if (!res.ok || !res.body) throw new Error(`event stream failed: ${res.status}`);
            retryDelayMs = 500; // reset after a successful connection

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const {done, value} = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, {stream: true});
                // Frames are separated by a blank line; comment lines
                // (heartbeats) start with ':'.
                let boundary: number;
                while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                    const frame = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const data = frame
                        .split("\n")
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n");
                    if (!data) continue;
                    try {
                        onEvent(JSON.parse(data) as OpencodeEvent);
                    } catch {
                        // Ignore malformed frames.
                    }
                }
            }
        } catch (e) {
            if (signal.aborted) return;
            // Transient failure (server restarting, network hiccup) — retry.
            console.warn(`[opencode] event stream error: ${e}; retrying in ${retryDelayMs}ms`);
        }
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, retryDelayMs));
        retryDelayMs = Math.min(retryDelayMs * 2, 10_000);
    }
}
