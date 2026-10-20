import {MESSAGES_PAGE_SIZE} from "./types.ts";
import type {
    ComposerFileRef,
    FormAnswer,
    FormRequest,
    IntegrationInfo,
    MessagesPage,
    OAuthAttempt,
    OAuthAttemptStatus,
    OpencodeAgent,
    OpencodeCommand,
    OpencodeConfigEntry,
    OpencodeModel,
    OpencodePluginInfo,
    OpencodeProject,
    OpencodeProvider,
    OpencodeSession,
    OpencodeServerInfo,
    McpServerInfo,
    PermissionDecision,
    PermissionRequest,
    SessionInboxItem,
    SessionModelRef,
    ShellInfo,
    ShellOutput,
    WorkspaceDiffEntry,
} from "./types.ts";

/** Abort deadline for the upload-shaped requests (prompt POST with base64
 *  attachments, the fs write of a diverted image): the mobile app pushes
 *  them over the frp route, and a dropped tunnel would otherwise park the
 *  fetch forever — see requestRaw's timeout handling. Generous on purpose
 *  (a compressed multi-image prompt is still hundreds of KB on a slow
 *  uplink). */
const UPLOAD_TIMEOUT_MS = 120_000;

/** A composer file reference as it rides the prompt's `files[]` —
 *  `file://` URLs point the server at the real file on disk. */
export function fileRefToPromptFile(ref: ComposerFileRef): {uri: string; name: string} {
    const base = ref.path.split("/").pop() ?? ref.path;
    return {uri: `file://${ref.path}`, name: base};
}

/**
 * Thin typed REST client for the opencode server.
 *
 * Hand-rolled instead of using the SDK's runtime because the installed
 * server (v2.0.x) and the SDK's generated client drift on paths and body
 * encoding — the few endpoints we use are more predictable pinned here, in
 * one file, against the paths verified against the real server:
 *   GET    /api/session                  → list sessions
 *   GET    /api/info                     → server identity (About's version)
 *   POST   /api/session                  → create session
 *   DELETE /api/session/{id}             → delete session
 *   GET    /api/session/{id}/message     → messages (order=asc)
 *   POST   /api/session/{id}/prompt      → send prompt `{text}`
 *   POST   /api/session/{id}/interrupt   → stop a running session
 *   GET    /api/session/{id}/inbox       → pending (undelivered) input rows
 *   DELETE /api/session/{id}/inbox/{iid} → cancel one pending input row
 *
 * The SDK stays as the source of some TypeScript shapes (types-only import).
 *
 * Response envelope: the server wraps payloads as `{"data": ...}`; unwrap
 * when present so callers get the raw payload.
 */

export class OpencodeApi {
    constructor(
        /** Public on purpose: remote consumers need the base URL +
         * authorization — the frp engine derives the local port +
         * password from them (hooks/useServerFrp.ts), and the mobile
         * branch rebuilds the stream on credential rotation. */
        public readonly baseUrl: string,
        public readonly authorization: string,
    ) {}

    private async request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
        const json = await this.requestRaw<unknown>(path, init, timeoutMs);
        if (json !== null && typeof json === "object" && "data" in json) {
            return (json as {data: T}).data;
        }
        return json as T;
    }

    /** Same transport as {@link request} but returns the JSON body as-is —
     * for endpoints whose real payload contains its own `data` field.
     * Error replies are still JSON; thrown errors carry the HTTP `status`
     * (same as {@link requestRawText}) so callers can tell "no longer
     * pending" (404) from failure. */
    private async requestRaw<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
        // Optional abort deadline for the big UPLOAD-shaped requests (the
        // prompt POST with base64 attachments, the fs write of a diverted
        // image): on the mobile frp route a dropped tunnel parks the fetch
        // forever, which reads to the user as an endless send instead of
        // a failure. Aborts become a readable Error; every other path —
        // including the !ok throw below — still clears the timer.
        const controller = timeoutMs != null ? new AbortController() : null;
        const timer = controller != null ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            const res = await fetch(this.baseUrl + path, {
                ...init,
                ...(controller != null ? {signal: controller.signal} : {}),
                headers: {
                    Accept: "application/json",
                    ...(init?.body !== undefined ? {"Content-Type": "application/json"} : {}),
                    Authorization: this.authorization,
                    ...init?.headers,
                },
            });
            if (!res.ok) await this.httpError(res);
            if (res.status === 204) return undefined as T;
            return (await res.json()) as T;
        } catch (e) {
            if (controller?.signal.aborted) {
                throw new Error(`request timed out after ${timeoutMs}ms: ${path}`);
            }
            throw e;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
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
        if (!res.ok) await this.httpError(res);
        return res.text();
    }

    /** Raw-bytes twin of {@link requestRawText}: same fs transport, but
     *  the body resolves to a Blob instead of text. Thrown errors carry
     *  the HTTP `status` like its siblings. NOTE: unlike requestRaw this
     *  has NO timeout parameter — reads over the frp route currently
     *  run unbounded (matches the pre-existing behavior; adding a
     *  deadline would be a behavior change, deliberately not done in
     *  the api consolidation refactor). */
    private async requestRawBlob(path: string, init?: RequestInit): Promise<Blob> {
        const res = await fetch(this.baseUrl + path, {
            ...init,
            headers: {
                Authorization: this.authorization,
                ...init?.headers,
            },
        });
        if (!res.ok) await this.httpError(res);
        return res.blob();
    }

    /** The one non-2xx error constructor (shared by every transport
     *  method): a readable message carrying the HTTP `status` property —
     *  consumers branch on it (404 = absent, 409 = busy, 503 = no VCS).
     *  The body's first 200 chars ride along when parseable. */
    private async httpError(res: Response): Promise<never> {
        const detail = await res.text().catch(() => "");
        const err = new Error(`${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
        (err as Error & {status?: number}).status = res.status;
        throw err;
    }

    /** `location[directory]=…` query string (the BRACKET form — v2.0.x
     *  silently ignores a flat `directory` param on every location-scoped
     *  route), optionally seeded with extra params. Returns "" | "?…"
     *  ready to append to the path. */
    private locationQuery(directory?: string | null, extra?: Record<string, string>): string {
        const params = new URLSearchParams(extra);
        if (directory) params.set("location[directory]", directory);
        const query = params.toString();
        return query ? `?${query}` : "";
    }

    /** GET a `{location, data}`-shaped response — a second envelope
     *  style the server uses alongside `{"data": …}` (see the class
     *  header); `request` would mis-parse it, so pick `.data` explicitly
     *  and fall back when it is missing. Empty-but-required replies stay
     *  hand-rolled at their call sites (each throws its own message). */
    private async requestLocationData<T>(path: string, fallback: T, init?: RequestInit): Promise<T> {
        const r = await this.requestRaw<{data?: T}>(path, init);
        return r?.data ?? fallback;
    }

    listSessions(): Promise<OpencodeSession[]> {
        return this.request<OpencodeSession[]>("/api/session");
    }

    /** The server's own identity report — the About pane's version source.
     *  Live-verified v2.0.11: auth required (401 without), body is NOT
     *  envelope-wrapped (`request` passes the bare object through). */
    serverInfo(): Promise<OpencodeServerInfo> {
        return this.request<OpencodeServerInfo>("/api/info");
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
     *  ignored, and the session lands in the server process's own cwd.
     *  `metadata` IS accepted (curl-verified on v2.0.11: echoed on the
     *  create response and present in GET /api/session payloads) — the
     *  auto-whitelist channel for Lumina Code's own clients, see
     *  sessionRegistry.ts's CLIENT_SOURCE. NOTE metadata is
     *  CREATE-ONLY: PATCH /api/session/{id} answers 204 but silently
     *  DROPS a metadata field (only `title` sticks — live-verified),
     *  which is why cross-client membership for ALREADY-EXISTING
     *  sessions rides the shared whitelist file instead
     *  (sessionWhitelistSync.ts). */
    createSession(
        body: {title?: string; directory?: string; metadata?: Record<string, unknown>} = {},
    ): Promise<OpencodeSession> {
        const payload: {
            title?: string;
            location?: {directory: string};
            metadata?: Record<string, unknown>;
        } = {};
        if (body.title !== undefined) payload.title = body.title;
        if (body.directory) payload.location = {directory: body.directory};
        if (body.metadata !== undefined) payload.metadata = body.metadata;
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
     *  toward older pages. `cursor` requests must NOT carry `order`.
     *
     *  CURSOR QUIRK (verified against v2.0.11): `cursor.next` is non-null
     *  on every page with rows — even a short one whose anchor is already
     *  the session's oldest message; only a ZERO-row page nulls it. So
     *  "page came back shorter than the requested limit" is the real
     *  exhaustion signal; messageStore's page merges apply that rule. */
    listMessagesPage(sessionId: string, cursor?: string): Promise<MessagesPage> {
        const query = cursor
            ? `?limit=${MESSAGES_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
            : `?order=desc&limit=${MESSAGES_PAGE_SIZE}`;
        return this.requestRaw<MessagesPage>(
            `/api/session/${encodeURIComponent(sessionId)}/message${query}`,
        );
    }

    /** Sends a prompt; the reply streams in over the event bus. Attachments
     *  ride as data-URI `files` (the server normalizes them to bare base64
     *  `data` fields in the stored message/inbox row). Deadline-bounded:
     *  the base64 body is the largest request the client makes, and the
     *  mobile frp route must not park it forever.
     *
     *  `delivery` (curl-verified v2.0.11; the payload schema is
     *  `{id, …promptFields, metadata, delivery, resume}`): omitted → the
     *  server normalizes to `"steer"`. `"queue"` is the SERVER-NATIVE
     *  queued prompt — the row parks in the persisted session inbox while
     *  a run is active (steer-mode drain never sees queue rows, so the
     *  current run is untouched), and the POST's wake is remembered as
     *  `pendingWake="input"` so the run's natural end automatically drains
     *  queue rows as fresh turns — the server performs the flush, and the
     *  queue is durable + visible to every client of this server (the
     *  mobile app reads the same rows; see promptQueue.ts). On an idle
     *  session a `"queue"` POST executes immediately (wake → input drain).
     *  The response body IS the inbox row shape (id/delivery/payload),
     *  live-verified. */
    sendPrompt(
        sessionId: string,
        text: string,
        files?: {uri: string; name: string}[],
        delivery?: "steer" | "queue",
    ): Promise<unknown> {
        return this.request(
            `/api/session/${encodeURIComponent(sessionId)}/prompt`,
            {
                method: "POST",
                body: JSON.stringify({
                    text,
                    ...(files?.length ? {files} : {}),
                    ...(delivery ? {delivery} : {}),
                }),
            },
            UPLOAD_TIMEOUT_MS,
        );
    }

    /** Stop a running session. Returns whether an execution was interrupted.
     *
     * v2.0.11 caveat (source-verified): the interrupt kills ONLY the
     * in-flight execution fiber — prompts sent mid-run ("send now") are
     * parked in the session's PERSISTED inbox as pending `steer` rows until
     * a step boundary promotes them, and the interrupt does NOT touch them.
     * They restart the run (a POST landing after the interrupt rings the
     * doorbell again at settle) or resurface inside the NEXT turn's first
     * promotion. Callers that mean "stop everything" must also sweep the
     * inbox — see {@link listSessionInbox}/{@link cancelSessionInbox} and
     * useSessionMessages' interrupt. */
    interruptSession(sessionId: string): Promise<boolean> {
        return this.request<{interrupted: boolean}>(
            `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
            {method: "POST"},
        ).then((r) => r?.interrupted ?? false);
    }

    // --- Session inbox (verified against server v2.0.11) ---
    //
    // The inbox is the server's PENDING-ONLY input table: every prompt sent
    // while a run is active (a `delivery`-less POST defaults to "steer" in
    // SessionPrompt.prepare) waits here until the runner's step boundary
    // promotes it into the live turn. Rows survive interrupts and app
    // restarts, so "stop means stop" needs an explicit sweep.

    /** List the session's PENDING input rows (steers + queued). An idle
     * session with rows here is the "interrupted but they survived" state
     * the sweep cleans up. */
    listSessionInbox(sessionId: string): Promise<SessionInboxItem[]> {
        return this.request<SessionInboxItem[]>(
            `/api/session/${encodeURIComponent(sessionId)}/inbox`,
        ).then((rows) => Array.isArray(rows) ? rows : []);
    }

    /** Cancel one pending inbox item. Already-delivered items are a NO-OP
     * (204, the projector only deletes rows still marked queue/steer —
     * delivery consumes rows inside uninterruptible transactions, so a row
     * is either still cancellable or fully delivered; there is no in-between
     * a client could race into). A cancelled row emits
     * `session.inbox.cancelled` on the bus. */
    cancelSessionInbox(sessionId: string, inboxID: string): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(inboxID)}`,
            {method: "DELETE"},
        );
    }

    // --- Session revert (verified against server v2.0.11) ---
    //
    // Revert is the server's "edit a sent message" primitive (the TUI's
    // message action does the same): stage a boundary at a message, then
    // commit deletes that message AND everything after it (the projector
    // removes seq >= boundary — the boundary itself dies too), so the
    // client re-sends the edited text as a fresh prompt.
    //
    // Staging has a FILE side effect: unless `files: false` is passed, it
    // immediately restores every file the assistant turns AFTER the
    // boundary touched to their pre-turn snapshot states (the TUI stages
    // without the flag — "undo messages and file changes"). Clearing a
    // staged revert re-applies those files. Staging while the session is
    // executing fails with 409 BusyError — only idle sessions can revert.

    /** Stage a revert boundary at a message (deleting happens on commit;
     *  the file undo happens NOW — see the block comment above). */
    stageSessionRevert(sessionId: string, messageID: string): Promise<unknown> {
        return this.request(`/api/session/${encodeURIComponent(sessionId)}/revert/stage`, {
            method: "POST",
            body: JSON.stringify({messageID}),
        });
    }

    /** Clear a staged revert and re-apply the files staging had undone. */
    clearSessionRevert(sessionId: string): Promise<void> {
        return this.request<void>(`/api/session/${encodeURIComponent(sessionId)}/revert`, {
            method: "DELETE",
        });
    }

    /** Commit the staged revert: deletes the boundary message and
     *  everything after it (announced as `session.revert.committed`). */
    commitSessionRevert(sessionId: string): Promise<void> {
        return this.request<void>(`/api/session/${encodeURIComponent(sessionId)}/revert/commit`, {
            method: "POST",
        });
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
     *  v2.0.11 QUIRK: the FIRST call a server instance serves for a
     *  location returns [] while the VCS backend lazily initializes
     *  (restart → 1st query empty, 2nd+ real, verified live); consumers
     *  must re-check an empty FIRST result once (see
     *  useSessionActivity.ts DIFF_WARMUP_RETRY_MS).
     *  `context` defaults to 3 lines like the session endpoint (omitting it
     *  serves full-file patches). */
    vcsDiff(
        directory: string | null,
        opts?: {context?: number},
    ): Promise<WorkspaceDiffEntry[]> {
        const query = this.locationQuery(directory, {
            mode: "working",
            context: String(opts?.context ?? 3),
        });
        return this.request<WorkspaceDiffEntry[]>(`/api/vcs/diff${query}`);
    }

    /** Per-TURN file diff of a session (`GET /api/session/{id}/diff?from=…`,
     *  verified against server v2.0.11 — route table + handler source read
     *  from the pinned binary): the files ONE turn changed, computed by the
     *  server's own snapshot machinery (the same snapshots revert uses), so
     *  the counts are authoritative — subagent and bash edits the model
     *  made mid-turn are included, which no client-side fold over tool
     *  inputs can promise. `from` must be a USER message id; a turn runs
     *  from the first prompt after the session was last idle until its
     *  next idle marker, so prompts steered in while busy belong to the
     *  SAME turn (their run footers all see the whole turn's totals).
     *  Same FileDiff.Info shape as {@link vcsDiff}. Fails on snapshot-less
     *  sessions (project without git, or `snapshot: false` in config) —
     *  callers read that as "no summary". `context=3` keeps the payload
     *  small; omitting it serves full-file patches. */
    sessionTurnDiff(
        sessionId: string,
        from: string,
        opts?: {context?: number},
    ): Promise<WorkspaceDiffEntry[]> {
        const query = this.locationQuery(null, {
            from,
            context: String(opts?.context ?? 3),
        });
        return this.request<WorkspaceDiffEntry[]>(
            `/api/session/${encodeURIComponent(sessionId)}/diff${query}`,
        );
    }

    // --- Branches & worktrees — verified against server v2.0.11 ---
    //
    // The server's worktree API (SDK calls it "experimental", served under
    // /api/worktree on this build) is the isolation primitive behind
    // branch-bound sessions: every session sharing one directory shares
    // ONE physical worktree, so concurrent sessions on different branches
    // need one linked worktree per branch. Binary/curl-verified behavior
    // encoded below:
    //   - every route takes `projectID` (resolve via GET /api/project,
    //     matching canonical + vcs:"git" — see worktreeSessions.ts);
    //   - create with `branch` checks out a worktree DETACHED at that
    //     branch's tip commit (not the branch ref — commits inside won't
    //     advance any branch);
    //   - `branch` must be an EXISTING rev ("无效引用" 400 otherwise);
    //     there is no create-branch flag;
    //   - remove refuses a worktree with modifications/untracked files
    //     unless `force` — but a detached COMMIT doesn't dirty the tree,
    //     so force:false does NOT protect those from deletion.

    /** Branch name list of a directory (`GET /api/vcs/branch`, verified
     *  against server v2.0.11). RAW entries interleaved: local branches,
     *  bare remote names ("origin") and remote refs ("origin/master") —
     *  shape with gitInfo.shapeBranchList. There is NO current-branch
     *  marker on this endpoint (read `.git/HEAD` via {@link readTextFile}
     *  for that). Shares the v2.0.11 warmup race with {@link vcsDiff}:
     *  the FIRST call per location can return [] while the VCS backend
     *  initializes — re-check an empty first answer once (callers own the
     *  retry policy, DIFF_WARMUP_RETRY_MS style). */
    listBranches(directory: string | null): Promise<string[]> {
        return this.request<string[]>(`/api/vcs/branch${this.locationQuery(directory)}`);
    }

    /** Worktree entries of a project (`GET /api/worktree?projectID=`),
     *  the project's MAIN worktree (the repo itself) included. */
    listWorktrees(projectID: string): Promise<{directory: string; strategy?: string}[]> {
        return this.request<{directory: string; strategy?: string}[]>(
            `/api/worktree?projectID=${encodeURIComponent(projectID)}`,
        );
    }

    /** Create a linked worktree (`POST /api/worktree`, server v2.0.11):
     *  checks out under `~/.local/share/opencode/worktree/<pid6>/<name>`
     *  (a random name when omitted), DETACHED at `branch`'s tip (or the
     *  project's HEAD without one). Returns the new directory. */
    createWorktree(input: {
        projectID: string;
        branch?: string;
        name?: string;
    }): Promise<{directory: string}> {
        return this.request<{directory: string}>("/api/worktree", {
            method: "POST",
            body: JSON.stringify(input),
        });
    }

    /** Remove a linked worktree (DELETE /api/worktree). `force:false` is
     *  refused (400) while the worktree has modifications or untracked
     *  files — see the caveat above on detached commits. */
    removeWorktree(input: {
        projectID: string;
        directory: string;
        force: boolean;
    }): Promise<void> {
        return this.request<void>("/api/worktree", {
            method: "DELETE",
            body: JSON.stringify(input),
        });
    }

    /** RUNNING shell commands only (exited ones drop off the list; read
     * those through {@link getShell}/{@link shellOutput} while the server
     * still retains them). Filter by `metadata.sessionID` for one
     * session's terminals. */
    listShells(directory?: string | null): Promise<ShellInfo[]> {
        return this.requestLocationData(`/api/shell${this.locationQuery(directory)}`, [] as ShellInfo[]);
    }

    /** One shell's current state (running or retained-exited). */
    getShell(shellId: string, directory?: string | null): Promise<ShellInfo> {
        return this.requestRaw<{data?: ShellInfo}>(
            `/api/shell/${encodeURIComponent(shellId)}${this.locationQuery(directory)}`,
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
        return this.request<void>(
            `/api/shell/${encodeURIComponent(shellId)}${this.locationQuery(directory)}`,
            {method: "DELETE"},
        );
    }

    /** One page of a shell's file-backed combined stdout+stderr. Page with
     * the returned cursor; it equals `size` once fully caught up. */
    shellOutput(
        shellId: string,
        opts?: {cursor?: number; limit?: number; directory?: string | null},
    ): Promise<ShellOutput> {
        const extra: Record<string, string> = {};
        if (opts?.cursor !== undefined) extra.cursor = String(opts.cursor);
        if (opts?.limit !== undefined) extra.limit = String(opts.limit);
        return this.requestLocationData<ShellOutput>(
            `/api/shell/${encodeURIComponent(shellId)}/output${this.locationQuery(opts?.directory, extra)}`,
            {output: "", cursor: 0, size: 0, truncated: false},
        );
    }

    /** Spawn a shell command (POST /api/shell — server v2.0.11
     * "shell.create", curl-verified). The body's `command` is a SINGLE
     * command string executed through the USER'S LOGIN SHELL (observed
     * fish on this machine) — an argv-style `args` field is silently
     * IGNORED (verified: `{"command":"git","args":["--version"]}` ran
     * bare `git`), so compose one shell-neutral line and rely on nothing
     * beyond `&&` (fish 3+ supports it; no `$?`/pipes-capture bashisms).
     * `cwd` overrides the working directory (the shell record keeps it
     * in `data.cwd`); the id-addressed get/output routes below then work
     * WITHOUT a location param. Returns the RUNNING shell. */
    spawnShell(command: string, cwd: string): Promise<ShellInfo> {
        return this.requestRaw<{data?: ShellInfo}>("/api/shell", {
            method: "POST",
            body: JSON.stringify({command, cwd}),
        }).then((r) => {
            if (!r?.data) throw new Error(`spawn "${command}" came back empty`);
            return r.data;
        });
    }

    /** Poll a spawned shell until it exits and resolve `{exit, output}` —
     * the exit code comes from the shell RECORD (`data.exit`), not from
     * echoing `$?` inside the command (that would be a bashism; see
     * {@link spawnShell}). 250ms cadence, 60s cap: past it the shell is
     * killed via {@link removeShell} (dropping its retained output) and
     * the promise rejects. Exited shells drop off the list endpoint but
     * stay readable here until the server evicts them. */
    awaitShell(shellId: string, directory?: string | null): Promise<{exit: number; output: string}> {
        const poll = (attempt: number): Promise<{exit: number; output: string}> =>
            this.getShell(shellId, directory).then((info) => {
                if (info.status === "exited") {
                    return this.shellOutput(shellId, {directory}).then((out) => ({
                        exit: info.exit ?? -1,
                        output: out.output,
                    }));
                }
                if (attempt >= 240) {
                    return this.removeShell(shellId, directory)
                        .catch(() => {})
                        .then(() => {
                            throw new Error(`shell ${shellId} did not exit within 60s`);
                        });
                }
                return new Promise((resolve) => setTimeout(resolve, 250)).then(() => poll(attempt + 1));
            });
        return poll(0);
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
        return this.request<OpencodeCommand[]>(`/api/command${this.locationQuery(directory)}`);
    }

    /** Server-side fuzzy file finder — ranked by the server (respects
     *  .gitignore). Verified against server v2.0.11: the SDK's
     *  `/find/file` does not exist there; the real route is
     *  `GET /api/fs/find` with the directory as a bracket-form
     *  `location[directory]` query param, returning `{location, data}`
     *  where `data[].path` is RELATIVE to that location — we return both
     *  forms (short display path + absolute for the file:// URI). */
    findFiles(query: string, directory?: string | null): Promise<{absolute: string; relative: string}[]> {
        const search = this.locationQuery(directory, {query, type: "file"});
        return this.requestRaw<{location?: {directory?: string}; data?: {path: string; type?: string}[]}>(
            `/api/fs/find${search}`,
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
        return this.requestLocationData("/api/permission/request", [] as PermissionRequest[]);
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
        return this.requestLocationData("/api/form", [] as FormRequest[]);
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
        return this.requestLocationData("/api/integration", [] as IntegrationInfo[]);
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
        return this.requestLocationData<OAuthAttemptStatus>(
            `/api/integration/${encodeURIComponent(integrationId)}/connect/oauth/${encodeURIComponent(attemptId)}`,
            {status: "pending"},
        );
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

    /** All LOADED plugins (`GET /api/plugin`, server v2.0.11). Includes
     *  the server's own `opencode.*` builtins (source.type "builtin" —
     *  filter for the user-manageable rows); a plugin disabled through a
     *  `plugins` remove directive is simply absent from the list. */
    listPlugins(directory?: string): Promise<OpencodePluginInfo[]> {
        return this.requestLocationData(`/api/plugin${this.locationQuery(directory)}`, [] as OpencodePluginInfo[]);
    }

    /** Every MCP server of the effective config with its live status
     *  (`GET /api/mcp`) — disabled ones included (status "disabled").
     *  Hot-reloads on config writes; `mcp.status.changed` signals flips. */
    listMcpServers(directory?: string): Promise<McpServerInfo[]> {
        return this.requestLocationData(`/api/mcp${this.locationQuery(directory)}`, [] as McpServerInfo[]);
    }

    /** Read one file as text, relative to a directory (fs/read is confined
     *  to the location — unlike fs/write). Returns null when the file
     *  doesn't exist (404); other failures throw. Callers MUST NOT treat
     *  a failed read as "absent" — rewriting on that assumption would
     *  clobber a config we failed to read. v2.0.11 quirk: a directory
     *  that doesn't exist yet yields 500, NOT 404 (first-save flows must
     *  catch and treat as absent themselves — see ToolsTab). */
    /** Shared 404→null tolerance of the fs/read pair: absent files read
     *  as null; every other failure rethrows. Callers MUST NOT treat a
     *  failed read as "absent" — rewriting on that assumption would
     *  clobber a config we failed to read. */
    private async readOrNull<T>(run: () => Promise<T>): Promise<T | null> {
        try {
            return await run();
        } catch (e) {
            if ((e as {status?: number}).status === 404) return null;
            throw e;
        }
    }

    async readTextFile(directory: string, name: string): Promise<string | null> {
        const path = `/api/fs/read/${encodeURIComponent(name)}${this.locationQuery(directory)}`;
        return this.readOrNull(() => this.requestRawText(path));
    }

    /** Binary twin of {@link readTextFile} (same location-confined
     * fs/read): one file's raw bytes as a Blob — attachment previews
     * (diverted images, file:// mentions). Returns null on 404; other
     * failures throw. Server quirk (per the v2 SDK schema): fs/read
     * answers with the file's bytes (200: Blob | File), not a JSON
     * envelope. */
    async readFileBlob(directory: string, name: string): Promise<Blob | null> {
        const path = `/api/fs/read/${encodeURIComponent(name)}${this.locationQuery(directory)}`;
        return this.readOrNull(() => this.requestRawBlob(path));
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
     * fs/write endpoint, deadline-bounded like the prompt POST (same
     * mobile-route rationale). */
    writeBinaryFile(absolutePath: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
        const params = new URLSearchParams({path: absolutePath});
        return this.request<void>(`/api/experimental/fs/write?${params.toString()}`, {
            method: "POST",
            headers: {"Content-Type": "application/octet-stream"},
            body: new Blob([bytes]),
        }, UPLOAD_TIMEOUT_MS);
    }
}

