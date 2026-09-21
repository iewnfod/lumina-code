import type {
    ChatMessage,
    FormAnswer,
    FormRequest,
    OpencodeAgent,
    OpencodeModel,
    OpencodeProject,
    OpencodeProvider,
    OpencodeSession,
    PermissionDecision,
    PermissionRequest,
    SessionModelRef,
} from "./types.ts";
export type {Session} from "@opencode-ai/sdk/v2/client";
export type {
    ChatMessage,
    OpencodeAgent,
    OpencodeModel,
    OpencodeProject,
    OpencodeProvider,
    OpencodeSession,
} from "./types.ts";

/** The messages endpoint caps `limit` at 200 (400 above that). */
const MESSAGES_PAGE_SIZE = 200;

/** Raw shape of `GET /api/session/{id}/message` — NOT envelope-unwrapped
 *  (the `data` here is the payload itself; unwrapping would lose `cursor`). */
export interface MessagesPage {
    data?: ChatMessage[];
    cursor?: {previous?: string; next?: string};
}

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
        const json = await this.requestRaw<unknown>(path, init);
        if (json !== null && typeof json === "object" && "data" in json) {
            return (json as {data: T}).data;
        }
        return json as T;
    }

    /** Same transport as {@link request} but returns the JSON body as-is —
     *  for endpoints whose real payload contains its own `data` field. */
    private async requestRaw<T>(path: string, init?: RequestInit): Promise<T> {
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
        return (await res.json()) as T;
    }

    listSessions(): Promise<OpencodeSession[]> {
        return this.request<OpencodeSession[]>("/api/session");
    }

    /** Creates a session. The working directory rides as `location.directory`
     *  in the body (v2.0.x OpenAPI): a flat `directory` field — or the
     *  `?directory=` query the newer SDK schema suggests — is silently
     *  ignored, and the session lands in the server process's own cwd. */
    createSession(body: {title?: string; directory?: string} = {}): Promise<OpencodeSession> {
        const payload: {title?: string; location?: {directory: string}} = {};
        if (body.title !== undefined) payload.title = body.title;
        if (body.directory) payload.location = {directory: body.directory};
        return this.request<OpencodeSession>("/api/session", {
            method: "POST",
            body: JSON.stringify(payload),
        });
    }

    deleteSession(sessionId: string): Promise<void> {
        return this.request<void>(`/api/session/${encodeURIComponent(sessionId)}`, {
            method: "DELETE",
        });
    }

    /** Messages page — desc order (newest first) with an optional cursor
     *  toward older pages. `cursor` requests must NOT carry `order`. */
    listMessagesPage(sessionId: string, cursor?: string): Promise<MessagesPage> {
        const query = cursor
            ? `?limit=${MESSAGES_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
            : `?order=desc&limit=${MESSAGES_PAGE_SIZE}`;
        return this.requestRaw<MessagesPage>(
            `/api/session/${encodeURIComponent(sessionId)}/message${query}`,
        );
    }

    /** Sends a prompt; the reply streams in over the event bus. Attachments
     *  ride as data-URI `files` (the server normalizes them inline). */
    sendPrompt(
        sessionId: string,
        text: string,
        files?: {uri: string; name: string}[],
    ): Promise<unknown> {
        return this.request(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
            method: "POST",
            body: JSON.stringify(files?.length ? {text, files} : {text}),
        });
    }

    /** Stop a running session. Returns whether an execution was interrupted. */
    interruptSession(sessionId: string): Promise<boolean> {
        return this.request<{interrupted: boolean}>(
            `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
            {method: "POST"},
        ).then((r) => r?.interrupted ?? false);
    }

    /** Available models (includes each model's thinking-depth variants). */
    listModels(): Promise<OpencodeModel[]> {
        return this.request<OpencodeModel[]>("/api/model");
    }

    /** The server's current default model. */
    getDefaultModel(): Promise<OpencodeModel | null> {
        return this.request<OpencodeModel | null>("/api/model/default");
    }

    /** Agents ("modes"): build/plan/… plus internal subagents (filter those). */
    listAgents(): Promise<OpencodeAgent[]> {
        return this.request<OpencodeAgent[]>("/api/agent");
    }

    /** Active providers (the user's authenticated ones plus the free catalog). */
    listProviders(): Promise<OpencodeProvider[]> {
        return this.request<OpencodeProvider[]>("/api/provider");
    }

    /** Directories the server already knows as projects. */
    listProjects(): Promise<OpencodeProject[]> {
        return this.request<OpencodeProject[]>("/api/project");
    }

    /** The server's own working directory — browsing starts here. */
    getLocation(): Promise<{directory?: string}> {
        return this.request<{directory?: string}>("/api/location");
    }

    /** Point a session at another model (variant = thinking depth). */
    switchModel(sessionId: string, model: SessionModelRef): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/model`,
            {method: "POST", body: JSON.stringify({model})},
        );
    }

    /** Point a session at another agent ("mode"). */
    switchAgent(sessionId: string, agent: string): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/agent`,
            {method: "POST", body: JSON.stringify({agent})},
        );
    }

    // --- Permission requests + forms (verified against server v2.0.11) ---
    //
    // The npm SDK drifts here in two ways worth pinning: the reply body
    // field is `decision` (the SDK says `reply` — the server 400s with
    // `Missing key ["decision"]`), and questions ride the form system
    // (the SDK's /api/question routes 404 on this server generation).

    /** Pending permission requests across ALL sessions — seeds requests
     *  that were pending before the event stream connected. The response
     *  body is `{location, data}` where `data` is the list (NOT envelope-
     *  wrapped; picking `.data` explicitly keeps that unambiguous). */
    listPermissionRequests(): Promise<PermissionRequest[]> {
        return this.requestRaw<{data?: PermissionRequest[]}>("/api/permission/request")
            .then((r) => r?.data ?? []);
    }

    /** Answer a permission request: allow once / always allow / reject. */
    replyPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
            {method: "POST", body: JSON.stringify({decision})},
        );
    }

    /** Pending forms (questions) across ALL sessions — same seed role and
     *  same `{location, data}` shape as {@link listPermissionRequests}. */
    listForms(): Promise<FormRequest[]> {
        return this.requestRaw<{data?: FormRequest[]}>("/api/form")
            .then((r) => r?.data ?? []);
    }

    /** Answer a form: one value per field key. */
    replyForm(sessionId: string, formId: string, answer: FormAnswer): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
            {method: "POST", body: JSON.stringify({answer})},
        );
    }

    /** Cancel (dismiss) a pending form — the waiting tool sees "cancelled". */
    cancelForm(sessionId: string, formId: string): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`,
            {method: "DELETE"},
        );
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
