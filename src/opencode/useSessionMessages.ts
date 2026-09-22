import {useCallback, useEffect, useRef, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import {OpencodeApi} from "./api.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import {
    isAssistantMessage,
    type AssistantPart,
    type AssistantToolPart,
    type ChatAssistantMessage,
    type ChatMessage,
    type ChatUserMessage,
    type ComposerAttachment,
    type ComposerFileRef,
    type EventMap,
} from "./types.ts";

/**
 * Messages of ONE session, live — built for long transcripts:
 *
 * - Seeded with the NEWEST page (`order=desc`, then reversed) — loading the
 *   oldest-first page would show stale history on long sessions.
 * - Older pages stream in on demand (`loadOlder`, cursor-based; cursor
 *   requests must not carry `order`).
 * - Event-bus updates are applied to a ref and flushed on an animation
 *   frame, so a burst of text.delta frames renders once, not N times.
 * - Clone-on-write updates keep untouched message identities stable, which
 *   is what lets ChatView's memoized rows skip re-render.
 *
 * Events for other sessions are ignored; switching re-seeds from the server,
 * which stays the source of truth.
 */
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
    // Ref-mirror of `messages`; events mutate it, rAF publishes it.
    const messagesRef = useRef<ChatMessage[]>([]);
    const flushScheduled = useRef(false);
    // Cursor toward the next-older page (desc-sequence `cursor.next`).
    const olderCursorRef = useRef<string | null>(null);
    // Generation guard: ignore async results from a previous session load.
    const loadGen = useRef(0);

    /** Publish ref state to React, coalescing bursts into one frame. */
    function commit(immediate = false) {
        if (immediate) {
            flushScheduled.current = false;
            setMessages(messagesRef.current);
            return;
        }
        if (flushScheduled.current) return;
        flushScheduled.current = true;
        requestAnimationFrame(() => {
            flushScheduled.current = false;
            setMessages(messagesRef.current);
        });
    }

    /** Apply a clone-on-write transformation then schedule a publish. */
    function mutate(fn: (list: ChatMessage[]) => ChatMessage[], immediate = false) {
        messagesRef.current = fn(messagesRef.current);
        commit(immediate);
    }

    // Seed on connect / session switch: newest page, reversed to ascending.
    useEffect(() => {
        const gen = ++loadGen.current;
        messagesRef.current = [];
        olderCursorRef.current = null;
        setMessages([]);
        setHasMore(false);
        if (!api || !sessionId) return;
        api.listMessagesPage(sessionId).then((page) => {
            if (gen !== loadGen.current) return; // switched away meanwhile
            const ascending = (page?.data ?? []).slice().reverse();
            olderCursorRef.current = page?.cursor?.next ?? null;
            setHasMore(olderCursorRef.current !== null);
            // Merge race guard: a user message may have been admitted (event
            // bus) while this request was in flight — the page snapshot predates
            // it, so a blind overwrite would drop the bubble. Re-append any
            // locally held message the page doesn't know about.
            const pageIds = new Set(ascending.map((m) => m.id));
            const newer = messagesRef.current.filter((m) => !pageIds.has(m.id));
            messagesRef.current = newer.length > 0 ? [...ascending, ...newer] : ascending;
            setMessages(messagesRef.current);
        }).catch((e) => {
            if (gen !== loadGen.current) return;
            logError(`Failed to load messages for ${sessionId}: ${e}`).catch(() => {});
        });
    }, [api, sessionId]);

    /** Fetch the next-older page and prepend it (ascending order). */
    const loadOlder = useCallback(() => {
        const a = apiRef.current;
        const sid = sessionRef.current;
        const cursor = olderCursorRef.current;
        if (!a || !sid || !cursor) return;
        setLoadingOlder(true);
        a.listMessagesPage(sid, cursor).then((page) => {
            olderCursorRef.current = page?.cursor?.next ?? null;
            setHasMore(olderCursorRef.current !== null);
            const older = (page?.data ?? []).slice().reverse();
            if (older.length > 0) {
                // Skip any ids we already hold (defensive against races).
                const held = new Set(messagesRef.current.map((m) => m.id));
                const fresh = older.filter((m) => !held.has(m.id));
                messagesRef.current = [...fresh, ...messagesRef.current];
                setMessages(messagesRef.current);
            }
        }).catch((e) => {
            logError(`Failed to load older messages: ${e}`).catch(() => {});
        }).finally(() => {
            setLoadingOlder(false);
        });
    }, []);

    // Live event pipeline for the active session.
    useEffect(() => {
        return subscribe((event) => {
            const sid = sessionRef.current;
            if (!sid) return;
            const data = event.data as {sessionID?: string} | null;
            if (!data || data.sessionID !== sid) return;

            switch (event.type) {
                case "session.inbox.enqueued": {
                    const {inboxID, item} = data as EventMap["session.inbox.enqueued"];
                    if (item?.type !== "user") return;
                    const text = item.payload?.text ?? "";
                    const files = item.payload?.files;
                    mutate((prev) => {
                        // Already held (seed race or another handler pass)?
                        if (prev.some((m) => m.id === inboxID)) return prev;
                        // Adopt the optimistic bubble this client appended
                        // in send() (swap in the server id)…
                        const last = prev[prev.length - 1];
                        if (
                            last && last.type === "user" &&
                            last.id.startsWith("local-") && last.text === text
                        ) {
                            return [...prev.slice(0, -1), {id: inboxID, type: "user", text, files}];
                        }
                        // …or append when the prompt came from another client.
                        return [...prev, {id: inboxID, type: "user", text, files}];
                    }, true);
                    break;
                }
                case "session.step.started": {
                    const d = data as EventMap["session.step.started"];
                    mutate((prev) =>
                        prev.some((m) => m.id === d.assistantMessageID)
                            ? prev
                            : [
                                ...prev,
                                {
                                    id: d.assistantMessageID,
                                    type: "assistant",
                                    agent: d.agent,
                                    model: d.model,
                                    content: [],
                                    time: {created: d.started},
                                } satisfies ChatAssistantMessage,
                            ],
                    );
                    break;
                }
                case "session.reasoning.started": {
                    const d = data as EventMap["session.reasoning.started"];
                    appendStreamPart(d.assistantMessageID, d.ordinal, "reasoning");
                    break;
                }
                case "session.reasoning.delta": {
                    const d = data as EventMap["session.reasoning.delta"];
                    appendStreamDelta(d.assistantMessageID, d.ordinal, "reasoning", d.delta);
                    break;
                }
                case "session.reasoning.ended": {
                    const d = data as EventMap["session.reasoning.ended"];
                    settleStreamPart(d.assistantMessageID, d.ordinal, "reasoning", d.text);
                    break;
                }
                case "session.text.started": {
                    const d = data as EventMap["session.text.started"];
                    appendStreamPart(d.assistantMessageID, d.ordinal, "text");
                    break;
                }
                case "session.text.delta": {
                    const d = data as EventMap["session.text.delta"];
                    appendStreamDelta(d.assistantMessageID, d.ordinal, "text", d.delta);
                    break;
                }
                case "session.text.ended": {
                    const d = data as EventMap["session.text.ended"];
                    settleStreamPart(d.assistantMessageID, d.ordinal, "text", d.text);
                    break;
                }
                case "session.tool.input.started": {
                    const d = data as EventMap["session.tool.input.started"];
                    mutateAssistant(d.assistantMessageID, (m) => {
                        m.content = [
                            ...m.content,
                            {
                                type: "tool",
                                id: d.id,
                                name: d.name,
                                state: {status: "pending"},
                            } satisfies AssistantToolPart,
                        ];
                    });
                    break;
                }
                case "session.tool.called": {
                    const d = data as EventMap["session.tool.called"];
                    mutateTool(d.assistantMessageID, d.id, (t) => {
                        t.state = {status: "running", input: d.input};
                    });
                    break;
                }
                case "session.tool.progress":
                    // Output streams via progress frames; the full content
                    // arrives with tool.success — nothing to do here yet.
                    break;
                case "session.tool.success": {
                    const d = data as EventMap["session.tool.success"];
                    mutateTool(d.assistantMessageID, d.id, (t) => {
                        t.state = {
                            status: "completed",
                            input: t.state.input,
                            content: d.content,
                            metadata: d.metadata,
                        };
                    });
                    break;
                }
                case "session.tool.error":
                case "session.tool.failed": {
                    // v2.0.11 emits "failed"; "error" kept for older
                    // builds — identical payload.
                    const d = data as EventMap["session.tool.failed"];
                    mutateTool(d.assistantMessageID, d.id, (t) => {
                        t.state = {status: "error", input: t.state.input, error: d.error};
                    });
                    break;
                }
                case "session.step.failed": {
                    const d = data as EventMap["session.step.failed"];
                    mutateAssistant(d.assistantMessageID, (m) => {
                        m.error = d.error;
                        m.time = {...m.time, completed: Date.now()};
                    });
                    break;
                }
                case "session.step.ended": {
                    const d = data as EventMap["session.step.ended"];
                    mutateAssistant(d.assistantMessageID, (m) => {
                        m.finish = d.finish;
                        m.time = {...m.time, completed: Date.now()};
                    });
                    break;
                }
            }
        });
    }, [subscribe]);

    // --- Streamed-part plumbing (reasoning and text share the mechanics;
    //     `ordinal` indexes parts of the same kind). ---

    function appendStreamPart(
        messageId: string,
        ordinal: number,
        kind: "text" | "reasoning",
    ) {
        mutateAssistant(messageId, (m) => {
            if (nthPart(m, kind, ordinal)) return;
            const part: AssistantPart = kind === "text"
                ? {type: "text", text: ""}
                : {type: "reasoning", text: ""};
            m.content = [...m.content, part];
        });
    }

    function appendStreamDelta(
        messageId: string,
        ordinal: number,
        kind: "text" | "reasoning",
        delta: string,
    ) {
        mutateAssistant(messageId, (m) => {
            const part = nthPart(m, kind, ordinal);
            if (part) part.text = part.text + delta;
            else {
                const fresh: AssistantPart = kind === "text"
                    ? {type: "text", text: delta}
                    : {type: "reasoning", text: delta};
                m.content = [...m.content, fresh];
            }
        });
    }

    function settleStreamPart(
        messageId: string,
        ordinal: number,
        kind: "text" | "reasoning",
        text: string,
    ) {
        mutateAssistant(messageId, (m) => {
            const part = nthPart(m, kind, ordinal);
            if (part) part.text = text;
        });
    }

    /** The nth part of a given kind (stream `ordinal`s are per-kind). */
    function nthPart(
        m: ChatAssistantMessage,
        kind: "text" | "reasoning",
        ordinal: number,
    ): {text: string} | undefined {
        let seen = -1;
        for (const part of m.content) {
            if (part.type === kind) {
                seen += 1;
                if (seen === ordinal) return part;
            }
        }
        return undefined;
    }

    // --- Immutable-state helpers. Each produces new arrays/objects so React
    //     re-renders while untouched messages keep their identity (memo). ---

    function mutateAssistant(id: string, fn: (draft: ChatAssistantMessage) => void) {
        mutate((prev) => {
            let changed = false;
            const next = prev.map((m) => {
                if (!isAssistantMessage(m) || m.id !== id) return m;
                const draft: ChatAssistantMessage = {
                    ...m,
                    content: [...m.content],
                    time: {...(m.time ?? {})},
                };
                fn(draft);
                changed = true;
                return draft;
            });
            return changed ? next : prev;
        });
    }

    function mutateTool(messageId: string, toolId: string, fn: (draft: AssistantToolPart) => void) {
        mutateAssistant(messageId, (m) => {
            m.content = m.content.map((p) => {
                if (p.type !== "tool" || p.id !== toolId) return p;
                const draft: AssistantToolPart = {...p, state: {...p.state}, time: {...p.time}};
                fn(draft);
                return draft;
            });
        });
    }

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
        // confirm it with the real id (see the inbox handler above).
        const optimistic: ChatUserMessage = {
            id: `local-${Date.now()}`,
            type: "user",
            text: trimmed,
            files: [
                ...(files ?? []).map((f) => ({name: f.name, mime: f.mime, uri: f.uri})),
                ...(fileRefs ?? []).map((r) => ({name: r.path.split("/").pop() ?? r.path})),
            ],
        };
        messagesRef.current = [...messagesRef.current, optimistic];
        commit(true);
        try {
            if (command) {
                await a.runSessionCommand(sid, command.name, command.arguments);
            } else {
                await a.sendPrompt(sid, trimmed, promptFiles);
            }
        } catch (e) {
            logError(`Failed to send prompt: ${e}`).catch(() => {});
            // Drop the optimistic bubble so the failure is visible.
            messagesRef.current = messagesRef.current.filter((m) => m.id !== optimistic.id);
            commit(true);
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
