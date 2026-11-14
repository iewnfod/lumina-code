import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {fileRefToPromptFile, OpencodeApi} from "./api/index.ts";
import {createKeyedStore} from "../lib/moduleStore.ts";
import {appendUserMessage, applyEvent, applyOlderPage, applySeedPage, backfillSubagentLink, dropFromBoundary, needsSubagentBackfill} from "./messageStore.ts";
import {dropPendingCommands, recordPendingCommand} from "./pendingCommands.ts";
import {getQueuedPrompts, seedSessionQueue, type QueuedPrompt} from "./promptQueue.ts";
import {nextLocalId} from "./chatMessages.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {
    ChatMessage,
    ChatUserMessage,
    ComposerAttachment,
    ComposerFileRef,
    EventMap,
    PendingCommand,
    UserMessageFile,
} from "./types.ts";

/**
 * The module-level MESSAGE STORE — one message list per session, the
 * substrate under useSessionMessages' React binding (that hook and its
 * companions live in useSessionMessages.ts; the queue actions live in
 * sessionQueueActions.ts; the stop discipline in sessionRunFence.ts).
 *
 * The store outlives ChatView unmounts on purpose: streamed reasoning /
 * text deltas exist ONLY on the event bus (the opencode server persists
 * a part when it ends, carrying "" until then — see messageStore.ts), so
 * a session switched away from must keep accumulating frames in the
 * background. Switching back renders the kept list instantly and
 * reconciles with the newest server page via a merge that never
 * truncates streamed content.
 *
 * Event-bus updates apply clone-on-write so untouched message identities
 * stay stable, which is what lets ChatView's memoized rows skip
 * re-render.
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

// --- Read primitives -------------------------------------------------------

/** A tracked session's current messages (undefined = never opened here). */
export function peekSessionMessages(sessionId: string): readonly ChatMessage[] | undefined {
    return entries.peek(sessionId)?.messages;
}

/** The store entry's shape as a read-only snapshot — the React binding's
 *  flush reads all three fields at once (state consistency inside one
 *  animation frame). */
export interface SessionSnapshot {
    messages: ChatMessage[];
    cursor: string | null;
    seeded: boolean;
}

/** One tracked session's snapshot state (undefined = never opened). */
export function peekSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
    const entry = entries.peek(sessionId);
    if (!entry) return undefined;
    return {messages: entry.messages, cursor: entry.cursor, seeded: entry.seeded};
}

/** Whether a session's newest page has landed at least once. */
export function isSessionSeeded(sessionId: string): boolean {
    return entries.peek(sessionId)?.seeded === true;
}

/** Every tracked session id (sessions whose store entry exists — opened
 *  here at least once this run). The request pipeline walks these to
 *  resolve a subagent child's PARENT session (its ask merges into the
 *  parent's sidebar badge), so a child pending on the server is never
 *  invisible just because the sidebar lists root sessions only. */
export function trackedSessionIds(): string[] {
    return [...entries.keys()];
}

/** Subscribe to tracked-session message changes (module-level). The
 *  activity store watches these to keep backgrounded sessions' diffs
 *  fresh without mounting their views. */
export function subscribeSessionMessages(listener: (sessionId: string) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Create (or return) a session's entry so the bus keeps it live — the
 *  hook's mount effect and the command-submission prepare both use it. */
export function ensureSessionTracked(sessionId: string): void {
    entryOf(sessionId);
}

// --- Optimistic bubbles ----------------------------------------------------

/** Append an optimistic user bubble to a session's store entry and
 *  notify — shared by send() and the edit-resend flow. */
export function appendOptimisticBubble(sessionId: string, optimistic: ChatUserMessage): void {
    const entry = entries.peek(sessionId);
    if (!entry) return;
    entry.messages = [...entry.messages, optimistic];
    notify(sessionId);
}

/** Mark an optimistic bubble's delivery as FAILED — the bubble stays in
 * the transcript as a visible failed row (the retry UI hangs off it);
 * dropping it outright reads as "my message vanished", the worst failure
 * mode on a flaky mobile link. */
export function markOptimisticFailed(sessionId: string, id: string): void {
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

/** Append a FAILED prompt row straight into a session's store — the
 *  welcome-screen first send (useSessionFlow.sendFirst) has no optimistic
 *  bubble of its own (there is no transcript mounted yet), and a lost
 *  first message on a flaky mobile link must still be retryable from the
 *  transcript instead of vanishing into an empty session. */
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
 *  cleanup: a retried failed row is dropped and re-sent through the
 *  normal send (whose own optimistic bubble takes over). Also the
 *  failure path for optimistic rows that must NOT linger. */
export function dropOptimisticBubble(sessionId: string, id: string): void {
    const current = entries.peek(sessionId);
    if (!current) return;
    current.messages = current.messages.filter((m) => m.id !== id);
    notify(sessionId);
}

/** Truncate a session's list at the first id >= the boundary message —
 *  the edit-resend flow's EAGER drop (the confirming revert event is
 *  then a no-op; `local-` bubbles survive, see dropFromBoundary). */
export function dropStoreRange(sessionId: string, boundaryId: string): void {
    const entry = entries.peek(sessionId);
    if (!entry) return;
    const kept = dropFromBoundary(entry.messages, boundaryId);
    if (kept !== entry.messages) {
        entry.messages = kept;
        notify(sessionId);
    }
}

/** Composer staging → the wire's UserMessageFile[] (attachments inline +
 *  file refs as file:// URIs) — the same conversion the direct send and
 *  the queue path both need for their optimistic rows. */
export function composerWireFiles(files?: ComposerAttachment[], fileRefs?: ComposerFileRef[]): UserMessageFile[] {
    return [
        ...(files ?? []).map((f) => ({name: f.name, mime: f.mime, uri: f.uri})),
        ...(fileRefs ?? []).map((r) => fileRefToPromptFile(r)),
    ];
}

// --- The "stop and send" optimistic bubble ---------------------------------
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

// --- Seeding + the event bus ------------------------------------------------

/** Pull the newest server page and merge it into a session's store —
 *  shared by the mount seed and the model-switch refresh. `entry.seq`
 *  supersedes overlapping requests, so only the latest one applies. Also
 *  re-seeds the queued-prompt mirror (the server's inbox IS the queue's
 *  truth — this is the path that heals a remote client's queue after an
 *  SSE gap, and what makes the queue visible on a device that never
 *  composed it). */
export function requestSeed(api: OpencodeApi, sessionId: string): void {
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

/** Fetch the next-older page and PREPEND it (ascending order) — the
 *  hook's loadOlder. Resolves when the request settles (loading state
 *  stays the hook's); null = nothing to load (no entry / no cursor).
 *  Merging + notifying live here next to the entry they mutate. */
export function loadOlderPage(api: OpencodeApi, sessionId: string): Promise<void> | null {
    const entry = entries.peek(sessionId);
    if (!entry || entry.cursor === null) return null;
    return api.listMessagesPage(sessionId, entry.cursor).then((page) => {
        const merged = applyOlderPage(entry.messages, page);
        entry.messages = merged.messages;
        entry.cursor = merged.cursor;
        notify(sessionId);
    }).catch((e) => {
        logError(`Failed to load older messages: ${e}`).catch(() => {});
    });
}

/** Warm a session's store WITHOUT mounting its view: creates the entry
 *  (so the bus keeps it live) and pulls the newest page unless it has
 *  already landed once. THE readiness primitive behind App's sequential
 *  surface choreography (called at switch/hover time) — once it resolves,
 *  mounting the session's view renders its first frame from the store
 *  with no server round-trip. No-op for already-seeded sessions and
 *  while disconnected. */
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

/** The single bus handler, installed once per app run (`subscribe` is
 *  stable). Applies events to EVERY tracked session — including ones
 *  backgrounded behind another tab, whose deltas would otherwise be lost
 *  for good. The api handle is refreshed on every ensureBus call (an api
 *  identity change is a reconnect — the handler must seed through the
 *  CURRENT client, never a dead one). */
let busUnsubscribe: (() => void) | null = null;
let busApi: OpencodeApi | null = null;
export function ensureBus(subscribe: (handler: OpencodeEventHandler) => () => void, api: OpencodeApi | null) {
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
