import {MESSAGES_PAGE_SIZE} from "../types.ts";
import type {
    MessagesPage,
    OpencodeSession,
    OpencodeServerInfo,
    SessionInboxItem,
    SessionStatsInfo,
} from "../types.ts";
import {ApiTransport, UPLOAD_TIMEOUT_MS} from "./transport.ts";

/**
 * The SESSION domain of the opencode REST client — lifecycle, prompts,
 * the pending inbox, message paging, and the edit-last-message revert
 * trio. Everything verified against server v2.0.11 unless noted.
 *
 * Endpoint map (the paths the rest of the app consumes through this
 * domain):
 *   GET    /api/session                  → list sessions
 *   GET    /api/info                     → server identity (About's version)
 *   POST   /api/session                  → create session
 *   DELETE /api/session/{id}             → delete session
 *   GET    /api/session/{id}/message     → messages (order=asc)
 *   POST   /api/session/{id}/prompt      → send prompt `{text}`
 *   POST   /api/session/{id}/interrupt   → stop a running session
 *   GET    /api/session/{id}/inbox       → pending (undelivered) input rows
 *   DELETE /api/session/{id}/inbox/{iid} → cancel one pending input row
 */
export interface SessionApi {
    listSessions(): Promise<OpencodeSession[]>;
    serverInfo(): Promise<OpencodeServerInfo>;
    listActiveSessions(): Promise<Record<string, {type: string}>>;
    sessionStats(opts?: {from?: number; to?: number; tools?: "none" | "summary" | "detail"}): Promise<SessionStatsInfo>;
    createSession(
        body: {title?: string; directory?: string; metadata?: Record<string, unknown>},
    ): Promise<OpencodeSession>;
    deleteSession(sessionId: string): Promise<void>;
    listMessagesPage(sessionId: string, cursor?: string): Promise<MessagesPage>;
    sendPrompt(
        sessionId: string,
        text: string,
        files?: {uri: string; name: string}[],
        delivery?: "steer" | "queue",
    ): Promise<unknown>;
    interruptSession(sessionId: string): Promise<boolean>;
    listSessionInbox(sessionId: string): Promise<SessionInboxItem[]>;
    cancelSessionInbox(sessionId: string, inboxID: string): Promise<void>;
    stageSessionRevert(sessionId: string, messageID: string): Promise<unknown>;
    clearSessionRevert(sessionId: string): Promise<void>;
    commitSessionRevert(sessionId: string): Promise<void>;
}

/** The sessions domain methods (see the interface); composed onto the
 *  OpencodeApi prototype in index.ts. */
export const sessionsApi: SessionApi & ThisType<ApiTransport> = {
    listSessions(): Promise<OpencodeSession[]> {
        return this.request<OpencodeSession[]>("/api/session");
    },

    /** The server's own identity report — the About pane's version source.
     *  Live-verified v2.0.11: auth required (401 without), body is NOT
     *  envelope-wrapped (`request` passes the bare object through). */
    serverInfo(): Promise<OpencodeServerInfo> {
        return this.request<OpencodeServerInfo>("/api/info");
    },

    /** Sessions with an execution in flight — a `{sessionID: {type:
     *  "running"}}` map (empty when idle). Seeds busy state that predates
     *  the event stream: a webview reload / dev rebuild while the server
     *  kept executing misses `session.execution.started`, so the sidebar
     *  dots and stop buttons would otherwise never come back. The map is
     *  process-local — a server restart clears it (nothing is running). */
    listActiveSessions(): Promise<Record<string, {type: string}>> {
        return this.request<Record<string, {type: string}>>("/api/session/active");
    },

    /** Aggregate session stats (`GET /api/experimental/session/stats`,
     *  curl-verified v2.0.11): usage/cost/activity over the server's
     *  local storage for a `from`/`to` window (ms epoch timestamps;
     *  omitting both uses the server's default ~30-day range), grouped
     *  per model in `models[]`. `tools:"none"` skips the tool
     *  reliability aggregation (the Usage pane never shows it).
     *  EXPERIMENTAL route — re-verify on server bumps. */
    sessionStats(opts?: {from?: number; to?: number; tools?: "none" | "summary" | "detail"}): Promise<SessionStatsInfo> {
        const params = new URLSearchParams({tools: opts?.tools ?? "none"});
        if (opts?.from != null) params.set("from", String(opts.from));
        if (opts?.to != null) params.set("to", String(opts.to));
        return this.request<SessionStatsInfo>(`/api/experimental/session/stats?${params.toString()}`);
    },

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
    },

    deleteSession(sessionId: string): Promise<void> {
        return this.request<void>(`/api/session/${encodeURIComponent(sessionId)}`, {
            method: "DELETE",
        });
    },

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
    },

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
    },

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
    },

    // --- Session inbox (verified against server v2.0.11) ---
    //
    // The inbox is the server's PENDING-ONLY input table: every prompt sent
    // while a run is active (a `delivery`-less POST defaults to "steer" in
    // SessionPrompt.prepare) waits here until the runner's step boundary
    // promotes it into the live turn. Rows survive interrupts and app
    // restarts, so "stop means stop" needs an explicit sweep.

    /** List the session's PENDING input rows (steers + queued). An idle
     *  session with rows here is the "interrupted but they survived" state
     *  the sweep cleans up. */
    listSessionInbox(sessionId: string): Promise<SessionInboxItem[]> {
        return this.request<SessionInboxItem[]>(
            `/api/session/${encodeURIComponent(sessionId)}/inbox`,
        ).then((rows) => Array.isArray(rows) ? rows : []);
    },

    /** Cancel one pending inbox item. Already-delivered items are a NO-OP
     *  (204, the projector only deletes rows still marked queue/steer —
     *  delivery consumes rows inside uninterruptible transactions, so a row
     *  is either still cancellable or fully delivered; there is no in-between
     *  a client could race into). A cancelled row emits
     *  `session.inbox.cancelled` on the bus. */
    cancelSessionInbox(sessionId: string, inboxID: string): Promise<void> {
        return this.request<void>(
            `/api/session/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(inboxID)}`,
            {method: "DELETE"},
        );
    },

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
    },

    /** Clear a staged revert and re-apply the files staging had undone. */
    clearSessionRevert(sessionId: string): Promise<void> {
        return this.request<void>(`/api/session/${encodeURIComponent(sessionId)}/revert`, {
            method: "DELETE",
        });
    },

    /** Commit the staged revert: deletes the boundary message and
     *  everything after it (announced as `session.revert.committed`). */
    commitSessionRevert(sessionId: string): Promise<void> {
        return this.request<void>(`/api/session/${encodeURIComponent(sessionId)}/revert/commit`, {
            method: "POST",
        });
    }
};
