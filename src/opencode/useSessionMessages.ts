import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import {fileRefToPromptFile, OpencodeApi} from "./api/index.ts";
import {nextLocalId} from "./chatMessages.ts";
import {recordPendingCommand} from "./pendingCommands.ts";
import {type QueuedPrompt} from "./promptQueue.ts";
import {attachmentNoteLine, splitAttachmentNote} from "./visionAttachments.ts";
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
import {
    appendOptimisticBubble,
    composerWireFiles,
    dropStoreRange,
    ensureBus,
    ensureSessionTracked,
    isSessionSeeded,
    loadOlderPage,
    markOptimisticFailed,
    peekSessionMessages,
    peekSessionSnapshot,
    requestSeed,
    subscribeSessionMessages,
} from "./sessionMessageStore.ts";
import {interruptSessionRun, stopInFlight} from "./sessionRunFence.ts";
import {
    deliverQueuedRows as queueDeliverQueuedRows,
    removeQueued as queueRemoveQueued,
    retryQueued as queueRetryQueued,
    rewriteQueuedOrder as queueRewriteQueuedOrder,
    sendQueued as queueSendQueued,
} from "./sessionQueueActions.ts";

/**
 * Messages of ONE session, live — the React binding over the
 * module-level store (sessionMessageStore.ts) that keeps one list per
 * session. The queue actions live in sessionQueueActions.ts, the stop
 * discipline in sessionRunFence.ts; this file re-exports everything the
 * rest of the app imports from it (the historical single-module surface).
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

// --- Re-exports: the store, the fence and the queue actions (the
// module-split keeps the historical import surface unchanged). ---
export {
    appendFailedPrompt,
    appendExpeditedBubble,
    appendOptimisticBubble,
    ensureSessionSeeded,
    markOptimisticFailed,
    peekSessionMessages,
    prepareCommandSubmission,
    reseedAllSessions,
    settleExpeditedBubble,
    subscribeSessionMessages,
    trackedSessionIds,
    dropOptimisticBubble,
} from "./sessionMessageStore.ts";
export {interruptSessionRun} from "./sessionRunFence.ts";

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
        () => (sessionId !== null ? isSessionSeeded(sessionId) : true),
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
        () => (sessionId !== null ? peekSessionMessages(sessionId) as ChatMessage[] ?? [] : []),
    );
    const [hasMore, setHasMore] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    // True until this mount's newest-page seed has landed (an
    // already-seeded store entry settles immediately). Consumers that
    // size themselves around the content (the stats card's subagent
    // drill) wait on this instead of measuring an empty list.
    const [seeding, setSeeding] = useState(() => {
        return sessionId !== null ? !isSessionSeeded(sessionId) : true;
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
            const snapshot = sid !== null ? peekSessionSnapshot(sid) : undefined;
            if (!snapshot) {
                setMessages([]);
                setHasMore(false);
                setSeeding(false);
                return;
            }
            setMessages(snapshot.messages);
            setHasMore(snapshot.seeded && snapshot.cursor !== null);
            setSeeding(!snapshot.seeded);
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
        ensureSessionTracked(sessionId);
        scheduleFlush();
        return subscribeSessionMessages((sid) => {
            if (sid === sessionId) scheduleFlush();
        });
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
        if (!a || !sid) return;
        const request = loadOlderPage(a, sid);
        if (!request) return;
        setLoadingOlder(true);
        void request.finally(() => setLoadingOlder(false));
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
     *  changes those turns made (staging's default; see the sessions
     *  api domain) — then deliver the edited text as a fresh prompt.
     *  `editFiles` are the composer's staged attachments (editable
     *  during the edit); without them the ORIGINAL attachments ride
     *  back unchanged. The deleted range is dropped from the store
     *  EAGERLY so the resent bubble appends in place; the confirming
     *  `session.revert.committed` bus event is then a no-op
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
        dropStoreRange(sid, message.id);
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
        // The full stop discipline lives at module level
        // (interruptSessionRun) — shared with the keyboard shortcut.
        await interruptSessionRun(a, sid);
    }, []);

    // The queue action set — thin stable wrappers over the module
    // functions (sessionQueueActions.ts), bound to this hook's refs.
    const sendQueued = useCallback(async (
        text: string,
        files?: ComposerAttachment[],
        fileRefs?: ComposerFileRef[],
        command?: PendingCommand | null,
    ) => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid) return;
        await queueSendQueued(a, sid, text, files, fileRefs, command);
    }, []);
    const retryQueued = useCallback(async (id: string) => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid) return;
        await queueRetryQueued(a, sid, id);
    }, []);
    const removeQueued = useCallback(async (id: string) => {
        const sid = sessionRef.current;
        if (!sid) return;
        await queueRemoveQueued(apiRef.current, sid, id);
    }, []);
    const deliverQueuedRows = useCallback(async (rows: readonly QueuedPrompt[]) => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid) return;
        await queueDeliverQueuedRows(a, sid, rows);
    }, []);
    const rewriteQueuedOrder = useCallback(async (dragId: string, beforeId: string | null) => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid) return;
        await queueRewriteQueuedOrder(a, sid, dragId, beforeId);
    }, []);

    return {messages, hasMore, loadingOlder, seeding, loadOlder, send, editResend, interrupt, sendQueued, retryQueued, removeQueued, deliverQueuedRows, rewriteQueuedOrder};
}
