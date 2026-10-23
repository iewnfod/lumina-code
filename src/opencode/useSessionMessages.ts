import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from "react";
import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {fileRefToPromptFile, OpencodeApi} from "./api.ts";
import {createKeyedStore} from "../lib/moduleStore.ts";
import {appendUserMessage, applyEvent, applyOlderPage, applySeedPage, backfillSubagentLink, dropFromBoundary, needsSubagentBackfill} from "./messageStore.ts";
import {dropPendingCommands, recordPendingCommand} from "./pendingCommands.ts";
import {
    adoptQueuedRow,
    appendOptimisticQueued,
    appendQueuedRow,
    dropQueuedRow,
    getQueuedPrompts,
    inboxRowToQueued,
    markQueuedFailed,
    markSweepCancels,
    planQueueRewrite,
    type QueuedPrompt,
    queuedRowToPromptFiles,
    seedSessionQueue,
} from "./promptQueue.ts";
import {clearSessionStopping, isSessionStopping, markSessionStopping} from "./sessionStopping.ts";
import {attachmentNoteLine, splitAttachmentNote} from "./visionAttachments.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import {nextLocalId} from "./chatMessages.ts";
import type {
    ChatMessage,
    ChatUserMessage,
    ComposerAttachment,
    ComposerFileRef,
    EventMap,
    PendingCommand,
    SessionInboxItem,
    UserMessageFile,
} from "./types.ts";

/**
 * Messages of ONE session, live — the React binding over a module-level
 * store that keeps one list per session.
 *
 * The store outlives ChatView unmounts on purpose: streamed reasoning /
 * text deltas exist ONLY on the event bus (the opencode server persists
 * a part when it ends, carrying "" until then — see messageStore.ts), so
 * a session switched away from must keep accumulating frames in the
 * background. Switching back renders the kept list instantly and
 * reconciles with the newest server page via a merge that never
 * truncates streamed content.
 *
 * Older pages stream in on demand (`loadOlder`, cursor-based); event-bus
 * updates apply clone-on-write so untouched message identities stay
 * stable, which is what lets ChatView's memoized rows skip re-render.
 */

interface SessionEntry {
    messages: ChatMessage[];
    /** Cursor toward the next-older page (desc-sequence `cursor.next`),
     *  already null once a SHORT page marked the beginning reached — the
     *  server itself never nulls it before a zero-row reply. */
    cursor: string | null;
    /** The newest page has landed at least once. */
    seeded: boolean;
    /** Guards in-flight page requests: only the latest one applies. */
    seq: number;
}

/** Per-session store; survives session switches and webview reloads of
 *  the conversation view. Entries drop on `session.deleted`. */
const entries = createKeyedStore<string, SessionEntry>(() => ({messages: [], cursor: null, seeded: false, seq: 0}));
// The subscription carries the SESSION ID (subscribers filter for their
// own session — a payload shape createListeners does not model), so the
// broadcast stays hand-rolled on purpose.
const listeners = new Set<(sessionId: string) => void>();

function entryOf(sessionId: string): SessionEntry {
    return entries.entryOf(sessionId);
}

function notify(sessionId: string) {
    for (const listener of listeners) listener(sessionId);
}

/** Append an optimistic user bubble to a session's store entry and
 *  notify — shared by send() and the edit-resend flow. */
function appendOptimisticBubble(sessionId: string, optimistic: ChatUserMessage): void {
    const entry = entries.peek(sessionId);
    if (!entry) return;
    entry.messages = [...entry.messages, optimistic];
    notify(sessionId);
}

/** Mark an optimistic bubble's delivery as FAILED — the bubble stays in
 * the transcript as a visible failed row (the retry UI hangs off it);
 * dropping it outright reads as "my message vanished", the worst failure
 * mode on a flaky mobile link. */
function markOptimisticFailed(sessionId: string, id: string): void {
    const current = entries.peek(sessionId);
    if (!current) return;
    let touched = false;
    current.messages = current.messages.map((m) => {
        if (m.id !== id || m.type !== "user" || m.sendFailed) return m;
        touched = true;
        return {...m, sendFailed: true};
    });
    if (touched) notify(sessionId);
}

/** Composer staging → the wire's UserMessageFile[] (attachments inline +
 *  file refs as file:// URIs) — the same conversion the direct send and
 *  the queue path both need for their optimistic rows. */
function composerWireFiles(files?: ComposerAttachment[], fileRefs?: ComposerFileRef[]): UserMessageFile[] {
    return [
        ...(files ?? []).map((f) => ({name: f.name, mime: f.mime, uri: f.uri})),
        ...(fileRefs ?? []).map((r) => fileRefToPromptFile(r)),
    ];
}

/** The stopping fence shared by every send-shaped action: true while this
 *  session's stop is unwinding — the caller drops the action (stop means
 *  stop; a POST landing in the window would be swept or RESTART the run
 *  as a successor execution, v2.0.11 — see send's full note). */
function stopInFlight(sid: string, what: string): boolean {
    if (!isSessionStopping(sid)) return false;
    logInfo(`${what} suppressed: session stop is in flight`).catch(() => {});
    return true;
}

/** Append a FAILED prompt row straight into a session's store — the
 * welcome-screen first send (useSessionFlow.sendFirst) has no optimistic
 * bubble of its own (there is no transcript mounted yet), and a lost
 * first message on a flaky mobile link must still be retryable from the
 * transcript instead of vanishing into an empty session. */
export function appendFailedPrompt(
    sessionId: string,
    message: {text: string; files: UserMessageFile[]; command?: PendingCommand},
): void {
    const entry = entryOf(sessionId);
    const localId = nextLocalId();
    entry.messages = [...entry.messages, {
        id: localId,
        type: "user",
        text: message.text,
        localKey: localId,
        files: message.files,
        ...(message.command ? {command: {name: message.command.name, arguments: message.command.arguments}} : {}),
        sendFailed: true,
    }];
    notify(sessionId);
}

/** Drop a local (optimistic/failed) bubble by id — the RETRY path's
 * cleanup: a retried failed row is dropped and re-sent through the
 * normal send (whose own optimistic bubble takes over). Also the
 * failure path for optimistic rows that must NOT linger. */
export function dropOptimisticBubble(sessionId: string, id: string): void {
    const current = entries.peek(sessionId);
    if (!current) return;
    current.messages = current.messages.filter((m) => m.id !== id);
    notify(sessionId);
}

// --- The "stop and send" optimistic bubble -------------------------------------
// ⚡ must feel INSTANT: the click flies the message into the transcript as a
// local bubble (the queue row is dropped locally in the same breath), the
// stopping run unwinds underneath it, and the flush effect's IMMEDIATE POST
// adopts the bubble through messageStore's normal enqueued path (text
// match). One bubble per session — the batch's LEADING row only (later ⚡
// rows re-park in the fresh run as queue rows).

/** session → the leading expedited row's pending bubble id. */
const expediteBubbles = new Map<string, string>();

/** Stamp the ⚡ optimistic bubble for the batch's leading row (the click
 *  handler calls this the moment ⚡ is pressed — the message must be in
 *  the transcript before the stop even starts unwinding). */
export function appendExpeditedBubble(sessionId: string, row: QueuedPrompt): void {
    if (expediteBubbles.has(sessionId)) return; // a leader is already in flight
    const entry = entryOf(sessionId);
    const localId = nextLocalId();
    entry.messages = appendUserMessage(entry.messages, {
        id: localId,
        type: "user",
        text: row.text,
        localKey: localId,
        files: row.files,
        ...(row.command ? {command: row.command} : {}),
    });
    expediteBubbles.set(sessionId, localId);
    notify(sessionId);
}

/** Settle the ⚡ bubble once the flush effect's outcome is known:
 *  - "sent": the immediate POST landed — the enqueued frame adopts the
 *    bubble (id swap in messageStore); only the bookkeeping clears.
 *  - "failed": the POST died — mark the bubble sendFailed (transcript
 *    retry affordance). Returns false when NO bubble was pending (the
 *    caller may fall back to appendFailedPrompt).
 *  - "abandoned": the batch evaporated (pruned empty — e.g. the row was
 *    naturally drained before the stop) — drop the bubble; the real
 *    message arrives through the delivered/seed path or the prompt is
 *    gone with the batch. */
export function settleExpeditedBubble(sessionId: string, outcome: "sent" | "failed" | "abandoned"): boolean {
    const bubbleId = expediteBubbles.get(sessionId);
    if (bubbleId === undefined) return false;
    expediteBubbles.delete(sessionId);
    if (outcome === "failed") markOptimisticFailed(sessionId, bubbleId);
    else if (outcome === "abandoned") dropOptimisticBubble(sessionId, bubbleId);
    return true;
}

/** Pull the newest server page and merge it into a session's store —
 * shared by the mount seed and the model-switch refresh. `entry.seq`
 * supersedes overlapping requests, so only the latest one applies. Also
 * re-seeds the queued-prompt mirror (the server's inbox IS the queue's
 * truth — this is the path that heals a remote client's queue after an
 * SSE gap, and what makes the queue visible on a device that never
 * composed it). */
function requestSeed(api: OpencodeApi, sessionId: string): void {
    const entry = entryOf(sessionId);
    const seq = ++entry.seq;
    void seedSessionQueue(api, sessionId);
    api.listMessagesPage(sessionId).then((page) => {
        if (seq !== entry.seq) return; // superseded by a newer request
        const merged = applySeedPage(entry.messages, page);
        entry.messages = merged.messages;
        entry.cursor = merged.cursor;
        entry.seeded = true;
        notify(sessionId);
        backfillSubagentLinks(api, sessionId, entry, seq);
    }).catch((e) => {
        if (seq !== entry.seq) return;
        logError(`Failed to load messages for ${sessionId}: ${e}`).catch(() => {});
        // A failed seed must still resolve readiness: the surface
        // choreography waits on `seeded` to play its entrance, and a
        // wedge here would loop the loading phase forever. Enter with
        // whatever the store holds (possibly empty).
        entry.seeded = true;
        notify(sessionId);
    });
}

/** Seed-time recovery for a MISSED `session.tool.progress` frame: a
 *  running subagent part whose child link never arrived (remote SSE
 *  gap, cold start into a session that is already running — the mobile
 *  norm; the server persists the running part with an EMPTY metadata)
 *  is re-linked from the session list's parentID reverse lookup. Only
 *  consults the list when the cheap scan finds an unlinked part, and
 *  only links unambiguous one-to-one pairings (backfillSubagentLink).
 *  Runs on EVERY seed path — mount, ensureSessionSeeded warm-up and
 *  the remote reconnect heal (reseedAllSessions) — so each gap heals at
 *  the next seed; the link then survives later re-seeds via mergePart's
 *  metadata rescue. */
function backfillSubagentLinks(
    api: OpencodeApi,
    sessionId: string,
    entry: SessionEntry,
    seq: number,
): void {
    if (!needsSubagentBackfill(entry.messages)) return;
    api.listSessions().then((sessions) => {
        if (seq !== entry.seq) return; // superseded — the newer seed re-runs this
        const next = backfillSubagentLink(entry.messages, sessionId, sessions ?? []);
        if (next !== entry.messages) {
            entry.messages = next;
            notify(sessionId);
            logInfo(`Backfilled subagent child link for ${sessionId}`).catch(() => {});
        }
    }).catch((e) => {
        logWarn(`Subagent backfill session list failed for ${sessionId}: ${e}`).catch(() => {});
    });
}

/** Warm a session's store WITHOUT mounting its view: creates the entry
 * (so the bus keeps it live) and pulls the newest page unless it has
 * already landed once. THE readiness primitive behind App's sequential
 * surface choreography (called at switch/hover time) — once it resolves,
 * mounting the session's view renders its first frame from the store
 * with no server round-trip. No-op for already-seeded sessions and
 * while disconnected. */
export function ensureSessionSeeded(api: OpencodeApi | null, sessionId: string): void {
    if (!api) return;
    const entry = entryOf(sessionId);
    if (entry.seeded) return;
    requestSeed(api, sessionId);
}

/** Re-seed EVERY tracked session (the remote-consumer heal: after the
 *  remote route's SSE reconnects, any bus frames the disconnect ate are
 *  gone for good — pulling each tracked session's newest page rebuilds
 *  the tail from the server's settled truth. The seq guard inside
 *  requestSeed makes this race-free against in-flight seeds.) */
export function reseedAllSessions(api: OpencodeApi | null): void {
    if (!api) return;
    for (const sessionId of entries.keys()) {
        requestSeed(api, sessionId);
    }
}

/** The single bus handler, installed once per app run (`subscribe` is
 *  stable). Applies events to EVERY tracked session — including ones
 *  backgrounded behind another tab, whose deltas would otherwise be lost
 *  for good. The api handle is refreshed on every ensureBus call (an api
 *  identity change is a reconnect — the handler must seed through the
 *  CURRENT client, never a dead one). */
let busUnsubscribe: (() => void) | null = null;
let busApi: OpencodeApi | null = null;
function ensureBus(subscribe: (handler: OpencodeEventHandler) => () => void, api: OpencodeApi | null) {
    busApi = api;
    if (busUnsubscribe) return;
    busUnsubscribe = subscribe((event) => {
        const sid = (event.data as {sessionID?: string} | null)?.sessionID;
        if (!sid) return;
        if (event.type === "session.deleted") {
            dropPendingCommands(sid);
            expediteBubbles.delete(sid);
            if (entries.delete(sid)) notify(sid);
            return;
        }
        const entry = entries.peek(sid);
        if (!entry) return; // never opened here — nothing to keep live
        // A queued prompt's DELIVERY: the row leaves the queue (the
        // promptQueue fold in useSessions handles that side) and its
        // content becomes the transcript's user message. No content rides
        // the frame — the promoted message KEEPS the row's id
        // (live-verified), and the row's text/files are what this client
        // POSTed or seeded, so the append is exact; any later seed merges
        // the server's persisted version over it in place.
        if (event.type === "session.inbox.delivered") {
            const inboxID = (event.data as EventMap["session.inbox.delivered"] | null)?.inboxID;
            const queued = inboxID != null ? getQueuedPrompts(sid).find((r) => r.id === inboxID) : undefined;
            if (queued) {
                const message: ChatUserMessage = {
                    id: queued.id,
                    type: "user",
                    text: queued.text,
                    files: queued.files,
                    ...(queued.command ? {command: queued.command} : {}),
                };
                const next = appendUserMessage(entry.messages, message);
                if (next !== entry.messages) {
                    entry.messages = next;
                    notify(sid);
                }
            } else if (busApi) {
                // The row is gone from the queue — either the queue fold
                // (useSessions' global handler) already processed THIS
                // frame (handlers run in registration order over
                // useOpencode's Set, and a session created mid-app — the
                // welcome-screen first send — mounts ChatView AFTER the
                // sessions hook subscribed), or this client never held
                // the row at all (another client composed it). No content
                // rides the frame, so the row's text is unrecoverable
                // here — but the server has ALREADY persisted the
                // promoted message (delivery consumes the row inside the
                // same transaction), so pull the newest page and let
                // applySeedPage merge it in.
                requestSeed(busApi, sid);
            }
            return;
        }
        const next = applyEvent(entry.messages, event);
        if (next !== entry.messages) {
            entry.messages = next;
            notify(sid);
        }
    });
}

/** Prepare a slash-command submission for a session that may not have a
 *  store entry yet (first send from the welcome screen): create the entry
 *  so the event bus keeps the confirming enqueue frame, and register the
 *  compact form for stamping. Returns an undo fn for the fallback path. */
export function prepareCommandSubmission(
    sessionId: string,
    command: PendingCommand,
): () => void {
    entryOf(sessionId);
    return recordPendingCommand(sessionId, command);
}

/** Subscribe to tracked-session message changes (module-level). The
 *  activity store watches these to keep backgrounded sessions' diffs
 *  fresh without mounting their views. */
export function subscribeSessionMessages(listener: (sessionId: string) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** A tracked session's current messages (undefined = never opened here). */
export function peekSessionMessages(sessionId: string): readonly ChatMessage[] | undefined {
    return entries.peek(sessionId)?.messages;
}

/** Stable empty snapshot for sessions with no store entry. */
const EMPTY_MESSAGES: readonly ChatMessage[] = [];

/** Shared subscribe for the read-only hooks: hear EVERY session's
 *  notifications when watching all of them (null), only this session's
 *  otherwise — the filter both snapshot hooks hand-rolled before. */
function subscribeSessionListener(sessionId: string | null, notify: () => void): () => void {
    return subscribeSessionMessages((sid) => {
        if (sessionId === null || sid === sessionId) notify();
    });
}

/** Read-only live snapshot of a tracked session's messages — the store
 *  watched from OUTSIDE ChatView (the workspace stats card, which survives
 *  same-directory session switches and must not show the previous
 *  session's terminals/subagents for a frame). useSyncExternalStore
 *  re-subscribes and re-checks the snapshot when the session id changes,
 *  so there is no stale frame; seeding/actions stay ChatView's job. */
export function useSessionMessagesSnapshot(sessionId: string | null): readonly ChatMessage[] {
    const subscribe = useCallback((notify: () => void) => subscribeSessionListener(sessionId, notify), [sessionId]);
    const getSnapshot = useCallback(
        () => (sessionId !== null ? peekSessionMessages(sessionId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES),
        [sessionId],
    );
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Whether a session's newest page has landed at least once (null =
 *  nothing to wait for → always ready, e.g. the welcome surface). The
 *  boolean the surface choreography gates its entrance phase on: a
 *  `true` flip means the store can paint the session's first frame
 *  without a server round-trip. Booleans are stable snapshot values,
 *  so useSyncExternalStore re-renders only on the flip itself. */
export function useSessionSeeded(sessionId: string | null): boolean {
    const subscribe = useCallback((notify: () => void) => subscribeSessionListener(sessionId, notify), [sessionId]);
    const getSnapshot = useCallback(
        () => (sessionId !== null ? entries.peek(sessionId)?.seeded === true : true),
        [sessionId],
    );
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSessionMessages(
    api: OpencodeApi | null,
    subscribe: (handler: OpencodeEventHandler) => () => void,
    sessionId: string | null,
): {
    messages: ChatMessage[];
    /** Whether the server holds older pages than what's loaded. */
    hasMore: boolean;
    loadingOlder: boolean;
    /** True until the newest-page seed has landed for this mount —
     *  an empty list before that is a loading state, not "no
     *  messages". */
    seeding: boolean;
    loadOlder: () => void;
    send: (
        text: string,
        files?: ComposerAttachment[],
        fileRefs?: ComposerFileRef[],
        command?: PendingCommand | null,
    ) => Promise<void>;
    /** Edit-and-resend the session's last user message (revert + fresh
     *  prompt; `editFiles` = the composer's staged attachments, falling
     *  back to the message's originals). False = the revert failed and
     *  nothing changed. */
    editResend: (
        message: ChatUserMessage,
        text: string,
        editFiles?: ComposerAttachment[],
    ) => Promise<boolean>;
    interrupt: () => Promise<void>;
    /** Queue a prompt server-side (`delivery:"queue"`) — the composer's
     *  busy path. See promptQueue.ts for the queue's semantics. */
    sendQueued: (
        text: string,
        files?: ComposerAttachment[],
        fileRefs?: ComposerFileRef[],
        command?: PendingCommand | null,
    ) => Promise<void>;
    /** Retry one `failed` queue row by id. */
    retryQueued: (id: string) => Promise<void>;
    /** Remove one queued row (local + server cancel; restores the row
     *  when the cancel fails). */
    removeQueued: (id: string) => Promise<void>;
    /** Re-POST the "stop and send" batch after the interrupted run
     *  settles (expedited rows first — ChatView's flush effect). */
    deliverQueuedRows: (rows: readonly QueuedPrompt[]) => Promise<void>;
    /** Drag-reorder commit: cancel the queued rows, re-POST in the new
     *  order (the server queue has no reorder API). */
    rewriteQueuedOrder: (dragId: string, beforeId: string | null) => Promise<void>;
} {
    // Seeded from the store at FIRST RENDER (not first effect): a session
    // switched back to paints its kept messages — in-flight content
    // included — in the very commit that mounts the view, which is what
    // lets the stats card know its activity is ready at mount too.
    const [messages, setMessages] = useState<ChatMessage[]>(
        () => (sessionId !== null ? entries.peek(sessionId)?.messages ?? [] : []),
    );
    const [hasMore, setHasMore] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    // True until this mount's newest-page seed has landed (an
    // already-seeded store entry settles immediately). Consumers that
    // size themselves around the content (the stats card's subagent
    // drill) wait on this instead of measuring an empty list.
    const [seeding, setSeeding] = useState(() => {
        const entry = sessionId !== null ? entries.peek(sessionId) : undefined;
        return entry ? !entry.seeded : true;
    });

    const apiRef = useRef(api);
    apiRef.current = api;
    const sessionRef = useRef(sessionId);
    sessionRef.current = sessionId;

    /** Publish the active entry to React, coalescing bursts (streaming
     *  delta frames) into one animation frame. Reads the store at flush
     *  time, so frames absorbed meanwhile are included. */
    const flushScheduled = useRef(false);
    function scheduleFlush() {
        if (flushScheduled.current) return;
        flushScheduled.current = true;
        requestAnimationFrame(() => {
            flushScheduled.current = false;
            const sid = sessionRef.current;
            const entry = sid !== null ? entries.peek(sid) : undefined;
            if (!entry) {
                setMessages([]);
                setHasMore(false);
                setSeeding(false);
                return;
            }
            setMessages(entry.messages);
            setHasMore(entry.seeded && entry.cursor !== null);
            setSeeding(!entry.seeded);
        });
    }

    useEffect(() => {
        ensureBus(subscribe, api);
    }, [subscribe, api]);

    // Render the active session's entry and follow its changes. A
    // returning session paints from the store immediately — its in-flight
    // content included, before any server round-trip.
    useEffect(() => {
        if (sessionId === null) return;
        entryOf(sessionId);
        scheduleFlush();
        const listener = (sid: string) => {
            if (sid === sessionId) scheduleFlush();
        };
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }, [sessionId]);

    // First activation seeds from the server (newest page); later
    // activations reconcile against it — applySeedPage merges, so
    // content streamed past the snapshot survives while anything the
    // store missed (e.g. across an event-stream gap) is adopted.
    useEffect(() => {
        if (!api || !sessionId) return;
        requestSeed(api, sessionId);
    }, [api, sessionId]);

    // A model switch persists a `model-switched` marker message and
    // publishes `session.model.selected` WITHOUT a message frame; re-pull
    // the newest page so the transcript's divider appears right away.
    // The marker is committed before the event is published and the page
    // carries its server id, so nothing client-side can duplicate it.
    useEffect(() => {
        if (!api || !sessionId) return;
        return subscribe((event) => {
            if (event.type !== "session.model.selected") return;
            const data = event.data as EventMap["session.model.selected"] | null;
            if (data?.sessionID !== sessionId) return;
            requestSeed(api, sessionId);
        });
    }, [api, sessionId, subscribe]);

    /** Fetch the next-older page and prepend it (ascending order). */
    const loadOlder = useCallback(() => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        const entry = sid !== null ? entries.peek(sid) : undefined;
        if (!a || !sid || !entry || entry.cursor === null) return;
        setLoadingOlder(true);
        a.listMessagesPage(sid, entry.cursor).then((page) => {
            const merged = applyOlderPage(entry.messages, page);
            entry.messages = merged.messages;
            entry.cursor = merged.cursor;
            notify(sid);
        }).catch((e) => {
            logError(`Failed to load older messages: ${e}`).catch(() => {});
        }).finally(() => {
            setLoadingOlder(false);
        });
    }, []);

    // --- Actions ---

    const send = useCallback(async (
        text: string,
        files?: ComposerAttachment[],
        fileRefs?: ComposerFileRef[],
        command?: PendingCommand | null,
    ) => {
        const trimmed = text.trim();
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid || !trimmed) return;
        // INTERRUPT FENCE: a stop was pressed but the run hasn't unwound
        // yet (the stopping marker spans exactly that window). A prompt
        // POST landing now would be admitted to the server inbox during
        // the interrupt's cleanup and RESTART the run as a successor
        // execution (v2.0.11: "wakes arriving during cleanup are new
        // admissions and restart normally at settle") — the stop would
        // visibly fail. The gap this closes is real: ChatView's `deliver`
        // awaits the vision-divert before calling here, so a send-now
        // click can still be in flight when the user presses stop.
        // Suppressed means dropped (stop means stop — same doctrine as
        // handleInterrupt clearing the local queue).
        if (stopInFlight(sid, "Send")) return;
        const promptFiles = [
            ...(files ?? []).map((f) => ({uri: f.uri, name: f.name})),
            ...(fileRefs ?? []).map((r) => fileRefToPromptFile(r)),
        ];
        // Optimistic user bubble; the prompt response + inbox.enqueued event
        // confirm it with the real id (applyEvent adopts it in messageStore).
        // A command submission carries its compact form so the transcript
        // renders `/name args`, not the expanded template the event brings.
        const localId = nextLocalId();
        const optimistic: ChatUserMessage = {
            id: localId,
            type: "user",
            text: trimmed,
            // Stable row key across the id swap (see ChatUserMessage.localKey).
            localKey: localId,
            // File refs keep their `file://` URI so a failed send's
            // RETRY can rebuild identical prompt files (and the chip
            // preview resolves like an adopted server message's).
            files: composerWireFiles(files, fileRefs),
            ...(command ? {command} : {}),
        };
        appendOptimisticBubble(sid, optimistic);
        // The stamp applies only when the command itself runs — a fallback
        // prompt must enqueue UNstamped (its text is the raw `/name args`).
        const undoPending = command ? recordPendingCommand(sid, command) : null;
        try {
            if (command) {
                await a.runSessionCommand(sid, command.name, command.arguments);
            } else {
                await a.sendPrompt(sid, trimmed, promptFiles);
            }
        } catch (e) {
            // A rejected slash command must not dead-end the message —
            // the raw text still means something to the model. Retry
            // once as a plain prompt; only when that also fails is the
            // send considered lost.
            undoPending?.();
            if (command) {
                try {
                    await a.sendPrompt(sid, trimmed, promptFiles);
                    return;
                } catch {
                    // fall through to the visible failure below
                }
            }
            logError(`Failed to send prompt: ${e}`).catch(() => {});
            // Keep the bubble as a FAILED row (retry affordance in the
            // transcript) — silently dropping it reads as "the message
            // vanished", which on a flaky mobile link is exactly what
            // the user just lived through.
            markOptimisticFailed(sid, optimistic.id);
        }
    }, []);

    /** Edit-and-resend for the session's LAST user message (the UI
     *  derives which message qualifies; the server enforces idleness
     *  with 409): stage a revert at the message, commit it — deleting
     *  the message and everything after it, and undoing the file
     *  changes those turns made (staging's default; see api.ts) — then
     *  deliver the edited text as a fresh prompt. `editFiles` are the
     *  composer's staged attachments (editable during the edit); without
     *  them the ORIGINAL attachments ride back unchanged. The deleted
     *  range is dropped from the
     *  store EAGERLY so the resent bubble appends in place; the
     *  confirming `session.revert.committed` bus event is then a no-op
     *  (dropFromBoundary's `local-` id rule keeps the pending bubble).
     *  Returns false when the revert itself failed — the message and
     *  the workspace stay untouched and the editor stays open. */
    const editResend = useCallback(async (message: ChatUserMessage, text: string, editFiles?: ComposerAttachment[]): Promise<boolean> => {
        const trimmed = text.trim();
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid || !trimmed) return false;
        // Same interrupt fence as send(): a revert+resend racing an
        // in-flight stop would re-admit work the user just aborted.
        // False keeps the composer in edit mode (buffer preserved).
        if (stopInFlight(sid, "Edit-resend")) return false;
        try {
            await a.stageSessionRevert(sid, message.id);
            try {
                await a.commitSessionRevert(sid);
            } catch (commitErr) {
                // Unwind the stage: clear re-applies the files staging
                // undid and lifts the staged state (best-effort).
                await a.clearSessionRevert(sid).catch((clearErr) => {
                    logError(`Failed to clear staged revert: ${clearErr}`).catch(() => {});
                });
                throw commitErr;
            }
        } catch (e) {
            logError(`Failed to revert session for edit: ${e}`).catch(() => {});
            return false;
        }
        const entry = entries.peek(sid);
        if (entry) {
            const kept = dropFromBoundary(entry.messages, message.id);
            if (kept !== entry.messages) {
                entry.messages = kept;
                notify(sid);
            }
        }
        // Re-send with the edited attachments (or the ORIGINAL ones when
        // the composer staged none): stored files ride back as prompt
        // files (inlined base64 reconstructed as data: URIs). No
        // vision-diversion re-run — the composer strips the note for
        // editing, so the ORIGINAL message's note (parsed back out of
        // its text; the disk files persist, paths unchanged) is
        // re-appended to the edited text and a text-only model keeps
        // its image paths.
        const {diverted} = splitAttachmentNote(message.text);
        const delivered = diverted ? `${trimmed}\n\n${attachmentNoteLine(diverted)}` : trimmed;
        const files: UserMessageFile[] = editFiles
            ? editFiles.map((f) => ({name: f.name, mime: f.mime, uri: f.uri}))
            : (message.files ?? []);
        const promptFiles = files
            .filter((f) => typeof f.uri === "string" || (f.data != null && f.mime != null))
            .map((f) => ({
                uri: typeof f.uri === "string" ? f.uri : `data:${f.mime};base64,${f.data}`,
                name: f.name ?? "file",
            }));
        const localId = nextLocalId();
        appendOptimisticBubble(sid, {
            id: localId,
            type: "user",
            text: delivered,
            localKey: localId,
            files,
        });
        try {
            await a.sendPrompt(sid, delivered, promptFiles);
        } catch (e) {
            // The edit DID happen (the old message is gone server-side) —
            // only the delivery failed; surface it like a failed send.
            logError(`Failed to send edited prompt: ${e}`).catch(() => {});
            markOptimisticFailed(sid, localId);
        }
        return true;
    }, []);

    const interrupt = useCallback(async () => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid) return;
        const wasStopping = isSessionStopping(sid);
        // The stopping marker goes up the MOMENT the button is pressed:
        // the server takes a moment to actually unwind the run, and the
        // tail's indicator must say "Stopping" through that window (see
        // sessionStopping.ts). The bus fold settles it when the run-end
        // event arrives; the branches below only cover the cases where
        // no such event will come — a false response means nothing was
        // running, a throw means the request itself failed. A true
        // response does nothing: the end event may already have cleared
        // the marker (either order is safe — clearing is idempotent and
        // never resurrected here).
        markSessionStopping(sid);
        // Idempotent stop: a marker already up means an interrupt POST is
        // in flight and owns the abort — a second POST here would return
        // false (the coordinator reports stopping-already as idle) and
        // prematurely drop the marker, re-opening the send fence inside
        // the stop window. Callers that stack actions during one stop
        // ("stop and send" expediting several rows) rely on this.
        if (wasStopping) return;
        let interrupted = false;
        let failed = false;
        try {
            interrupted = await a.interruptSession(sid);
        } catch (e) {
            failed = true;
            logError(`Failed to interrupt session: ${e}`).catch(() => {});
        }
        // SWEEP the server inbox (v2.0.11, source-verified): the interrupt
        // only kills the in-flight execution — prompts POSTed mid-run (a
        // raw steer; this client no longer produces them — "stop and
        // send" expedites + interrupts instead — but a racing client or
        // an in-flight POST can) sit in the PERSISTED inbox as pending
        // steer rows that no step boundary has promoted yet, and they
        // survive the
        // stop: a prompt POST landing after the interrupt restarts the run
        // as a successor execution, and anything left parked resurrects
        // inside the NEXT turn's first promotion. Cancelling every pending
        // row makes "stop" final server-side. Runs on every interrupt
        // outcome (the parked rows are there whatever the POST said) and
        // is best-effort: a failed sweep logs and leaves the rows for the
        // next stop to retry.
        try {
            const pending = await a.listSessionInbox(sid);
            // Declare the cancels to the "stop and send" snapshot BEFORE
            // the DELETE loop: this sweep is exactly what the expedited
            // batch is waiting to survive (its rows re-POST once the run
            // settles), and without the declaration the `cancelled` frames
            // this loop triggers would prune the snapshot empty — the
            // batch then delivered nothing and the prompts vanished (the
            // ⚡ button's own stop ate its send). No-op without a snapshot.
            if (pending.length > 0) markSweepCancels(sid, pending.map((r) => r.id));
            for (const row of pending) {
                await a.cancelSessionInbox(sid, row.id);
            }
            if (pending.length > 0) {
                logInfo(`Interrupt swept ${pending.length} pending inbox input(s)`).catch(() => {});
            }
        } catch (e) {
            logWarn(`Failed to sweep session inbox after interrupt: ${e}`).catch(() => {});
        }
        if (failed || !interrupted) clearSessionStopping(sid);
    }, []);

    /** Queue a prompt server-side (`delivery:"queue"`) with an optimistic
     *  row: the POST response IS the inbox row (live-verified), so the
     *  adoption is a straight id swap; a response without a usable id
     *  waits for the `session.inbox.enqueued` frame (foldQueuedRows
     *  replaces the text-matching sending row in place). A dead POST
     *  keeps the row as `failed` (retry affordance). Shared by
     *  sendQueued / retryQueued / the expedited re-POST batch / the
     *  reorder rewrite — order is the POST order (enqueued_seq).
     *
     *  `immediate` (the "stop and send" batch's FIRST row): a plain
     *  deliver POST instead — the session is confirmed idle when the
     *  flush effect runs, so the run starts at once and the message
     *  enters the transcript through the normal enqueued path (no queue
     *  row, no park-then-drain round trip: a `queue` POST here made the
     *  row visibly re-park above the composer while the server's
     *  idle-drain kicked in, the "message bounced back into the queue"
     *  artefact). A dead POST falls back to the transcript's failed
     *  bubble (appendFailedPrompt — retryable, same as send()). */
    const postQueuedRow = useCallback(async (
        text: string,
        files: UserMessageFile[],
        command: PendingCommand | null,
        immediate?: boolean,
    ) => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid || !text.trim()) return;
        // Same interrupt fence as send(): a POST landing inside the
        // stop window would be swept (its row cancelled) or restart the
        // aborted work as a successor execution. In immediate mode the ⚡
        // bubble is already in the transcript — settle it as failed
        // (retryable) rather than letting it hang.
        if (stopInFlight(sid, immediate ? "Deliver POST" : "Queue POST")) {
            if (immediate) settleExpeditedBubble(sid, "failed");
            return;
        }
        const optimistic = immediate ? null : appendOptimisticQueued(sid, {text, files, command});
        const undoPending = command ? recordPendingCommand(sid, command) : null;
        try {
            if (optimistic === null) {
                // immediate mode: plain deliver POST, no queue row — the
                // enqueued frame appends the transcript message directly.
                await a.sendPrompt(sid, text, queuedRowToPromptFiles({files}));
                return;
            }
            const response = await a.sendPrompt(sid, text, queuedRowToPromptFiles(optimistic), "queue");
            const row = response as SessionInboxItem | null | undefined;
            if (typeof row?.id === "string") {
                adoptQueuedRow(sid, optimistic.id, inboxRowToQueued(row, command));
            }
            // else: the enqueued frame (usually faster than the HTTP
            // response) already replaced the sending row; if both go
            // missing the row hangs `sending` until the next seed —
            // logged there, never silently duplicated.
        } catch (e) {
            undoPending?.();
            if (optimistic) markQueuedFailed(sid, optimistic.id);
            else if (!settleExpeditedBubble(sid, "failed")) appendFailedPrompt(sid, {text, files, ...(command ? {command} : {})});
            logError(`Failed to ${immediate ? "deliver" : "queue"} prompt: ${e}`).catch(() => {});
        }
    }, []);

    /** Queue one prompt (the composer's busy path — ChatView diverts
     *  attachments before calling). Slash commands queue as their
     *  EXPANDED template text (the command endpoint takes no delivery
     *  parameter — queuing a command is typing out its full text); the
     *  compact form rides the row via the pending-command stamp. */
    const sendQueued = useCallback(async (
        text: string,
        files?: ComposerAttachment[],
        fileRefs?: ComposerFileRef[],
        command?: PendingCommand | null,
    ) => {
        await postQueuedRow(text.trim(), composerWireFiles(files, fileRefs), command ?? null);
    }, [postQueuedRow]);

    /** Retry a `failed` queue row (drop it, re-POST the same content). */
    const retryQueued = useCallback(async (id: string) => {
        const sid = sessionRef.current;
        const row = sid !== null ? getQueuedPrompts(sid).find((r) => r.id === id) : undefined;
        if (!row || row.status !== "failed") return;
        dropQueuedRow(sid!, row.id);
        await postQueuedRow(row.text, row.files, row.command);
    }, [postQueuedRow]);

    /** Remove one queued row: local delete + the server cancel (only for
     *  rows that reached the server). A failed cancel RESTORES the row —
     *  leaving it deleted client-side while the server still holds it
     *  would resurrect the prompt at the next drain. */
    const removeQueued = useCallback(async (id: string) => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!sid) return;
        const row = getQueuedPrompts(sid).find((r) => r.id === id);
        if (!row) return;
        dropQueuedRow(sid, id);
        if (row.status !== "queued" || !row.id.startsWith("msg_") || !a) return;
        try {
            await a.cancelSessionInbox(sid, id);
        } catch (e) {
            appendQueuedRow(sid, row);
            logWarn(`Failed to cancel queued prompt (row restored): ${e}`).catch(() => {});
        }
    }, []);

    /** Re-POST the "stop and send" batch (the flush effect's job after
     * the interrupted run settles): expedited rows first, then the rest —
     * the first POST executes immediately (idle drain), the others park
     * in the fresh run and chain on its end. */
    const deliverQueuedRows = useCallback(async (rows: readonly QueuedPrompt[]) => {
        const sid = sessionRef.current;
        for (const [i, row] of rows.entries()) {
            // First row: plain deliver POST (the session is confirmed idle
            // here — the run starts at once and the message enters the
            // transcript directly, adopting the ⚡ optimistic bubble through
            // the enqueued frame's text match). The rest park in the fresh
            // run and chain on its natural end.
            await postQueuedRow(row.text, row.files, row.command, i === 0);
            if (i === 0 && sid !== null) settleExpeditedBubble(sid, "sent");
        }
    }, [postQueuedRow]);

    /** Drag-reorder commit: the server has no reorder API, so the queue
     *  is REWRITTEN — every queued row cancels, then re-POSTs in the new
     *  order (prompt files re-upload; mobile attachments are compressed
     *  upstream so the bodies stay small). Safe only while the run holds
     *  (queue rows are drain-visible at run END); on idle the first
     *  re-POST executes immediately, which is just the queue flushing. */
    const rewriteQueuedOrder = useCallback(async (dragId: string, beforeId: string | null) => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid) return;
        const queuedRows = getQueuedPrompts(sid).filter((r) => r.status === "queued");
        const next = planQueueRewrite(queuedRows, dragId, beforeId);
        if (!next) return;
        for (const row of queuedRows) {
            dropQueuedRow(sid, row.id);
        }
        await Promise.all(queuedRows.map((row) =>
            a.cancelSessionInbox(sid, row.id).catch((e) => {
                logWarn(`Queue rewrite: cancel failed for ${row.id}: ${e}`).catch(() => {});
            }),
        ));
        for (const row of next) {
            await postQueuedRow(row.text, row.files, row.command);
        }
    }, [postQueuedRow]);

    return {messages, hasMore, loadingOlder, seeding, loadOlder, send, editResend, interrupt, sendQueued, retryQueued, removeQueued, deliverQueuedRows, rewriteQueuedOrder};
}
