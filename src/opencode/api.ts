import type {
    ChatMessage,
    ComposerFileRef,
    FormAnswer,
    FormRequest,
    IntegrationInfo,
    OAuthAttempt,
    OAuthAttemptStatus,
    OpencodeAgent,
    OpencodeCommand,
    OpencodeConfigEntry,
    OpencodeModel,
    OpencodeProject,
    OpencodeProvider,
    OpencodeSession,
    PermissionDecision,
    PermissionRequest,
    SessionModelRef,
    ShellInfo,
    ShellOutput,
    WorkspaceDiffEntry,
} from "./types.ts";
export type {Session} from "@opencode-ai/sdk/v2/client";
export type {
    ChatMessage,
    IntegrationInfo,
    OAuthAttempt,
    OAuthAttemptStatus,
    OpencodeAgent,
    OpencodeCommand,
    OpencodeConfigEntry,
    OpencodeModel,
    OpencodeProject,
    OpencodeProvider,
    OpencodeSession,
    ShellInfo,
    ShellOutput,
    WorkspaceDiffEntry,
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

    /** Raw-file variant of {@link requestRaw} for fs endpoints: the body
     *  is the file's bytes (no JSON, no envelope) and the write side sends
     *  plain text. Error replies are still JSON; thrown errors carry the
     *  HTTP `status` so callers can tell "absent" (404) from failure. */
    private async requestRawText(path: string, init?: RequestInit): Promise<string> {
        const res = await fetch(this.baseUrl + path, {
            ...init,
            headers: {
                Authorization: this.authorization,
                ...init?.headers,
            },
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            const err = new Error(`${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
            (err as Error & {status?: number}).status = res.status;
            throw err;
        }
        return res.text();
    }

    listSessions(): Promise<OpencodeSession[]> {
        return this.request<OpencodeSession[]>("/api/session");
    }

    /** Sessions with an execution in flight — a `{sessionID: {type:
     *  "running"}}` map (empty when idle). Seeds busy state that predates
     *  the event stream: a webview reload / dev rebuild while the server
     *  kept executing misses `session.execution.started`, so the sidebar
     *  dots and stop buttons would otherwise never come back. The map is
     *  process-local — a server restart clears it (nothing is running). */
    listActiveSessions(): Promise<Record<string, {type: string}>> {
        return this.request<Record<string, {type: string}>>("/api/session/active");
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

    // --- Workspace activity (stats card) — verified against server v2.0.11 ---
    //
    // The shells are location-scoped services: a session whose directory
    // differs from the server's own cwd spawns its shells under THAT
    // location, and the list/get/output routes only see them when the
    // request carries the same `location[directory]` query.

    /** Real git diff of the WORKING COPY against HEAD for a directory
     *  (`GET /api/vcs/diff?mode=working`, verified against server v2.0.11):
     *  uncommitted changes including untracked files ("added"). This is the
     *  stats card's Changes truth - the per-session diff endpoint compares
     *  whole-worktree snapshot trees over the session's TIME WINDOW, so any
     *  other session editing the same project leaks into it (see types.ts).
     *  Location-scoped like the shell endpoints; a directory without VCS
     *  fails with 503 - callers catch that and read as "no changes".
     *  `context` defaults to 3 lines like the session endpoint (omitting it
     *  serves full-file patches). */
    vcsDiff(
        directory: string | null,
        opts?: {context?: number},
    ): Promise<WorkspaceDiffEntry[]> {
        const params = new URLSearchParams();
        params.set("mode", "working");
        if (directory) params.set("location[directory]", directory);
        params.set("context", String(opts?.context ?? 3));
        return this.request<WorkspaceDiffEntry[]>(
            `/api/vcs/diff?${params.toString()}`,
        );
    }

    /** RUNNING shell commands only (exited ones drop off the list; read
     * those through {@link getShell}/{@link shellOutput} while the server
     * still retains them). Filter by `metadata.sessionID` for one
     * session's terminals. */
    listShells(directory?: string | null): Promise<ShellInfo[]> {
        const params = new URLSearchParams();
        if (directory) params.set("location[directory]", directory);
        const query = params.toString();
        return this.requestRaw<{data?: ShellInfo[]}>(`/api/shell${query ? `?${query}` : ""}`)
            .then((r) => r?.data ?? []);
    }

    /** One shell's current state (running or retained-exited). */
    getShell(shellId: string, directory?: string | null): Promise<ShellInfo> {
        const params = new URLSearchParams();
        if (directory) params.set("location[directory]", directory);
        const query = params.toString();
        return this.requestRaw<{data?: ShellInfo}>(
            `/api/shell/${encodeURIComponent(shellId)}${query ? `?${query}` : ""}`,
        ).then((r) => {
            if (!r?.data) throw new Error(`shell ${shellId} came back empty`);
            return r.data;
        });
    }

    /** Terminate one shell command (DELETE /api/shell/{id} — server v2.0.x
     * "shell.remove": kill the process and drop its retained output). The
     * completion notification message and `shell.exited` bus event still
     * fire, so message-derived state stays truthful. */
    removeShell(shellId: string, directory?: string | null): Promise<void> {
        const params = new URLSearchParams();
        if (directory) params.set("location[directory]", directory);
        const query = params.toString();
        return this.request<void>(
            `/api/shell/${encodeURIComponent(shellId)}${query ? `?${query}` : ""}`,
            {method: "DELETE"},
        );
    }

    /** One page of a shell's file-backed combined stdout+stderr. Page with
     * the returned cursor; it equals `size` once fully caught up. */
    shellOutput(
        shellId: string,
        opts?: {cursor?: number; limit?: number; directory?: string | null},
    ): Promise<ShellOutput> {
        const params = new URLSearchParams();
        if (opts?.cursor !== undefined) params.set("cursor", String(opts.cursor));
        if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
        if (opts?.directory) params.set("location[directory]", opts.directory);
        const query = params.toString();
        return this.requestRaw<{data?: ShellOutput}>(
            `/api/shell/${encodeURIComponent(shellId)}/output${query ? `?${query}` : ""}`,
        ).then((r) => r?.data ?? {output: "", cursor: 0, size: 0, truncated: false});
    }

    /** Available models (includes each model's thinking-depth variants). */
    listModels(): Promise<OpencodeModel[]> {
        return this.request<OpencodeModel[]>("/api/model");
    }

    /** User-defined slash commands (markdown templates), scoped to a
     *  location: project-local `.opencode/commands/` (and the built-ins,
     *  which only register inside a project) appear when the directory is
     *  passed as the bracket-form `location[directory]` query param — the
     *  same form {@link findFiles} uses. Without it the server answers for
     *  its default location (the server process's own cwd). */
    listCommands(directory?: string | null): Promise<OpencodeCommand[]> {
        if (!directory) return this.request<OpencodeCommand[]>("/api/command");
        const params = new URLSearchParams({"location[directory]": directory});
        return this.request<OpencodeCommand[]>(`/api/command?${params.toString()}`);
    }

    /** Server-side fuzzy file finder — ranked by the server (respects
     *  .gitignore). Verified against server v2.0.11: the SDK's
     *  `/find/file` does not exist there; the real route is
     *  `GET /api/fs/find` with the directory as a bracket-form
     *  `location[directory]` query param, returning `{location, data}`
     *  where `data[].path` is RELATIVE to that location — we return both
     *  forms (short display path + absolute for the file:// URI). */
    findFiles(query: string, directory?: string | null): Promise<{absolute: string; relative: string}[]> {
        const params = new URLSearchParams({query, type: "file"});
        if (directory) params.set("location[directory]", directory);
        return this.requestRaw<{location?: {directory?: string}; data?: {path: string; type?: string}[]}>(
            `/api/fs/find?${params.toString()}`,
        ).then((r) => {
            const base = (directory ?? r?.location?.directory ?? "").replace(/\/+$/, "");
            return (r?.data ?? [])
                .filter((f) => f.type !== "directory")
                .map((f) => ({
                    relative: f.path,
                    absolute: base && !f.path.startsWith("/") ? `${base}/${f.path}` : f.path,
                }));
        });
    }

    /** Execute a slash command inside a session (server expands the
     *  template and runs it like a prompt). Verified against server
     *  v2.0.11: the body is `{name, text}` — `name` is the command and
     *  `text` carries the arguments (the server substitutes them into
     *  $ARGUMENTS, or appends them after the template when it has no
     *  placeholder). The older `{command, arguments}` shape is rejected
     *  with 400 "Missing key [\"name\"]". */
    runSessionCommand(sessionId: string, command: string, args: string): Promise<unknown> {
        return this.request(`/api/session/${encodeURIComponent(sessionId)}/command`, {
            method: "POST",
            body: JSON.stringify({name: command, text: args}),
        });
    }

    /** A composer file reference as it rides the prompt's `files[]` —
     *  `file://` URLs point the server at the real file on disk. */
    static fileRefToPromptFile(ref: ComposerFileRef): {uri: string; name: string} {
        const base = ref.path.split("/").pop() ?? ref.path;
        return {uri: `file://${ref.path}`, name: base};
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

    // --- Integrations & credentials (verified against server v2.0.11) ---

    /** Every authenticatable provider with its auth methods and current
     *  connections. Response is `{location, data}` (NOT envelope-wrapped). */
    listIntegrations(): Promise<IntegrationInfo[]> {
        return this.requestRaw<{data?: IntegrationInfo[]}>("/api/integration")
            .then((r) => r?.data ?? []);
    }

    /** Store an API-key credential for an integration — the new credential
     *  auto-activates and its provider goes live immediately (204 reply,
     *  then `credential.updated` on the bus). `answer` carries any extra
     *  form fields the method declares (e.g. Azure's `resourceName`). */
    connectIntegrationKey(
        integrationId: string,
        key: string,
        answer?: Record<string, string>,
    ): Promise<void> {
        const body: {key: string; answer?: Record<string, string>} = {key};
        if (answer) body.answer = answer;
        return this.request<void>(
            `/api/integration/${encodeURIComponent(integrationId)}/connect/key`,
            {method: "POST", body: JSON.stringify(body)},
        );
    }

    /** Start a browser OAuth flow: returns the URL to open in the system
     *  browser; poll {@link getIntegrationOAuthStatus} until it leaves
     *  "pending". The server itself listens on the loopback redirect. */
    startIntegrationOAuth(integrationId: string, methodId: string): Promise<OAuthAttempt> {
        return this.requestRaw<{data?: OAuthAttempt}>(
            `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth`,
            {method: "POST", body: JSON.stringify({methodID: methodId})},
        ).then((r) => {
            if (!r?.data) throw new Error("oauth attempt came back empty");
            return r.data;
        });
    }

    /** Poll an OAuth attempt: "pending" → "complete" | "failed" | "expired". */
    getIntegrationOAuthStatus(integrationId: string, attemptId: string): Promise<OAuthAttemptStatus> {
        return this.requestRaw<{data?: OAuthAttemptStatus}>(
            `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}`,
        ).then((r) => r?.data ?? {status: "pending"});
    }

    /** Abort a pending OAuth attempt (204). */
    cancelIntegrationOAuth(integrationId: string, attemptId: string): Promise<void> {
        return this.request<void>(
            `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}`,
            {method: "DELETE"},
        );
    }

    /** Remove a stored credential (204). Removing the last credential
     *  deactivates the provider. */
    deleteCredential(credentialId: string): Promise<void> {
        return this.request<void>(`/api/credential/${encodeURIComponent(credentialId)}`, {
            method: "DELETE",
        });
    }

    /** Make a stored credential the active one (204) — only meaningful
     *  when an integration holds several. */
    activateCredential(credentialId: string): Promise<void> {
        return this.request<void>(`/api/credential/${encodeURIComponent(credentialId)}/activate`, {
            method: "POST",
        });
    }

    // --- Config file access for custom providers (v2.0.11 quirks) ---
    //
    // The server only hot-reloads config from DISK, and its
    // `/api/experimental/config` PATCH accepts nothing but `shell` — so
    // custom providers are managed by rewriting the global opencode.json:
    // read raw (fs/read), merge the `provider` entry, write back
    // (experimental fs/write). The server picks the change up within ~2s
    // and emits config.updated / provider.updated / model.updated.

    /** Config documents + discovery directories, lowest → highest
     *  priority. The first entry is the GLOBAL config location. */
    listConfigEntries(): Promise<OpencodeConfigEntry[]> {
        return this.request<OpencodeConfigEntry[]>("/api/config");
    }

    /** Read one file as text, relative to a directory (fs/read is confined
     *  to the location — unlike fs/write). Returns null when the file
     *  doesn't exist (404); other failures throw. Callers MUST NOT treat
     *  a failed read as "absent" — rewriting on that assumption would
     *  clobber a config we failed to read. v2.0.11 quirk: a directory
     *  that doesn't exist yet yields 500, NOT 404 (first-save flows must
     *  catch and treat as absent themselves — see ToolsTab). */
    async readTextFile(directory: string, name: string): Promise<string | null> {
        const params = new URLSearchParams({"location[directory]": directory});
        try {
            return await this.requestRawText(`/api/fs/read/${encodeURIComponent(name)}?${params.toString()}`);
        } catch (e) {
            if ((e as {status?: number}).status === 404) return null;
            throw e;
        }
    }

    /** Write text to an ABSOLUTE path (experimental fs/write is not
     *  location-confined; missing parent directories are created).
     *  Server quirk: the endpoint REJECTS `Content-Type: application/json`
     *  with 415 — the body must ride as octet-stream (verified v2.0.11). */
    writeTextFile(absolutePath: string, content: string): Promise<void> {
        const params = new URLSearchParams({path: absolutePath});
        return this.request<void>(`/api/experimental/fs/write?${params.toString()}`, {
            method: "POST",
            headers: {"Content-Type": "application/octet-stream"},
            body: content,
        });
    }

    /** Binary twin of {@link writeTextFile} for raw bytes (image
     * attachments diverted for the vision tool) — same octet-stream
     * fs/write endpoint. */
    writeBinaryFile(absolutePath: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        const params = new URLSearchParams({path: absolutePath});
        return this.request<void>(`/api/experimental/fs/write?${params.toString()}`, {
            method: "POST",
            headers: {"Content-Type": "application/octet-stream"},
            body: new Blob([bytes]),
        });
    }
}

