import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import {OpencodeApi} from "./api.ts";
import {applyEvent, applyOlderPage, applySeedPage} from "./messageStore.ts";
import {dropPendingCommands, recordPendingCommand} from "./pendingCommands.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {
    ChatMessage,
    ChatUserMessage,
    ComposerAttachment,
    ComposerFileRef,
    PendingCommand,
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
    /** Cursor toward the next-older page (desc-sequence `cursor.next`). */
    cursor: string | null;
    /** The newest page has landed at least once. */
    seeded: boolean;
    /** Guards in-flight page requests: only the latest one applies. */
    seq: number;
}

/** Per-session store; survives session switches and webview reloads of
 *  the conversation view. Entries drop on `session.deleted`. */
const entries = new Map<string, SessionEntry>();
const listeners = new Set<(sessionId: string) => void>();

function entryOf(sessionId: string): SessionEntry {
    let entry = entries.get(sessionId);
    if (!entry) {
        entry = {messages: [], cursor: null, seeded: false, seq: 0};
        entries.set(sessionId, entry);
    }
    return entry;
}

function notify(sessionId: string) {
    for (const listener of listeners) listener(sessionId);
}

/** The single bus handler, installed once per app run (`subscribe` is
 *  stable). Applies events to EVERY tracked session — including ones
 *  backgrounded behind another tab, whose deltas would otherwise be lost
 *  for good. */
let busUnsubscribe: (() => void) | null = null;
function ensureBus(subscribe: (handler: OpencodeEventHandler) => () => void) {
    if (busUnsubscribe) return;
    busUnsubscribe = subscribe((event) => {
        const sid = (event.data as {sessionID?: string} | null)?.sessionID;
        if (!sid) return;
        if (event.type === "session.deleted") {
            dropPendingCommands(sid);
            if (entries.delete(sid)) notify(sid);
            return;
        }
        const entry = entries.get(sid);
        if (!entry) return; // never opened here — nothing to keep live
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
    return entries.get(sessionId)?.messages;
}

/** Stable empty snapshot for sessions with no store entry. */
const EMPTY_MESSAGES: readonly ChatMessage[] = [];

/** Read-only live snapshot of a tracked session's messages — the store
 *  watched from OUTSIDE ChatView (the workspace stats card, which survives
 *  same-directory session switches and must not show the previous
 *  session's terminals/subagents for a frame). useSyncExternalStore
 *  re-subscribes and re-checks the snapshot when the session id changes,
 *  so there is no stale frame; seeding/actions stay ChatView's job. */
export function useSessionMessagesSnapshot(sessionId: string | null): readonly ChatMessage[] {
    const subscribe = useCallback(
        (notify: () => void) =>
            subscribeSessionMessages((sid) => {
                if (sessionId === null || sid === sessionId) notify();
            }),
        [sessionId],
    );
    const getSnapshot = useCallback(
        () => (sessionId !== null ? peekSessionMessages(sessionId) ?? EMPTY_MESSAGES : EMPTY_MESSAGES),
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
    interrupt: () => Promise<void>;
} {
    // Seeded from the store at FIRST RENDER (not first effect): a session
    // switched back to paints its kept messages — in-flight content
    // included — in the very commit that mounts the view, which is what
    // lets the stats card know its activity is ready at mount too.
    const [messages, setMessages] = useState<ChatMessage[]>(
        () => (sessionId !== null ? entries.get(sessionId)?.messages ?? [] : []),
    );
    const [hasMore, setHasMore] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    // True until this mount's newest-page seed has landed (an
    // already-seeded store entry settles immediately). Consumers that
    // size themselves around the content (the stats card's subagent
    // drill) wait on this instead of measuring an empty list.
    const [seeding, setSeeding] = useState(() => {
        const entry = sessionId !== null ? entries.get(sessionId) : undefined;
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
            const entry = sid !== null ? entries.get(sid) : undefined;
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
        ensureBus(subscribe);
    }, [subscribe]);

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
        const entry = entryOf(sessionId);
        const seq = ++entry.seq;
        api.listMessagesPage(sessionId).then((page) => {
            if (seq !== entry.seq) return; // superseded by a newer request
            const merged = applySeedPage(entry.messages, page);
            entry.messages = merged.messages;
            entry.cursor = merged.cursor;
            entry.seeded = true;
            notify(sessionId);
        }).catch((e) => {
            if (seq !== entry.seq) return;
            logError(`Failed to load messages for ${sessionId}: ${e}`).catch(() => {});
        });
    }, [api, sessionId]);

    /** Fetch the next-older page and prepend it (ascending order). */
    const loadOlder = useCallback(() => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        const entry = sid !== null ? entries.get(sid) : undefined;
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
        const promptFiles = [
            ...(files ?? []).map((f) => ({uri: f.uri, name: f.name})),
            ...(fileRefs ?? []).map((r) => OpencodeApi.fileRefToPromptFile(r)),
        ];
        // Optimistic user bubble; the prompt response + inbox.enqueued event
        // confirm it with the real id (applyEvent adopts it in messageStore).
        // A command submission carries its compact form so the transcript
        // renders `/name args`, not the expanded template the event brings.
        const optimistic: ChatUserMessage = {
            id: `local-${Date.now()}`,
            type: "user",
            text: trimmed,
            files: [
                ...(files ?? []).map((f) => ({name: f.name, mime: f.mime, uri: f.uri})),
                ...(fileRefs ?? []).map((r) => ({name: r.path.split("/").pop() ?? r.path})),
            ],
            ...(command ? {command} : {}),
        };
        const entry = entries.get(sid);
        if (entry) {
            entry.messages = [...entry.messages, optimistic];
            notify(sid);
        }
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
            // Drop the optimistic bubble so the failure is visible.
            const current = entries.get(sid);
            if (current) {
                current.messages = current.messages.filter((m) => m.id !== optimistic.id);
                notify(sid);
            }
        }
    }, []);

    const interrupt = useCallback(async () => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid) return;
        try {
            await a.interruptSession(sid);
        } catch (e) {
            logError(`Failed to interrupt session: ${e}`).catch(() => {});
        }
    }, []);

    return {messages, hasMore, loadingOlder, seeding, loadOlder, send, interrupt};
}
