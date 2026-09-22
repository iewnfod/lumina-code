import {useCallback, useEffect, useRef, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import {OpencodeApi} from "./api.ts";
import {applyEvent, applyOlderPage, applySeedPage} from "./messageStore.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {
    ChatMessage,
    ChatUserMessage,
    ComposerAttachment,
    ComposerFileRef,
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

export function useSessionMessages(
    api: OpencodeApi | null,
    subscribe: (handler: OpencodeEventHandler) => () => void,
    sessionId: string | null,
): {
    messages: ChatMessage[];
    /** Whether the server holds older pages than what's loaded. */
    hasMore: boolean;
    loadingOlder: boolean;
    loadOlder: () => void;
    send: (
        text: string,
        files?: ComposerAttachment[],
        fileRefs?: ComposerFileRef[],
        command?: {name: string; arguments: string} | null,
    ) => Promise<void>;
    interrupt: () => Promise<void>;
} {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);

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
                return;
            }
            setMessages(entry.messages);
            setHasMore(entry.seeded && entry.cursor !== null);
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
        command?: {name: string; arguments: string} | null,
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
        const optimistic: ChatUserMessage = {
            id: `local-${Date.now()}`,
            type: "user",
            text: trimmed,
            files: [
                ...(files ?? []).map((f) => ({name: f.name, mime: f.mime, uri: f.uri})),
                ...(fileRefs ?? []).map((r) => ({name: r.path.split("/").pop() ?? r.path})),
            ],
        };
        const entry = entries.get(sid);
        if (entry) {
            entry.messages = [...entry.messages, optimistic];
            notify(sid);
        }
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

    return {messages, hasMore, loadingOlder, loadOlder, send, interrupt};
}
