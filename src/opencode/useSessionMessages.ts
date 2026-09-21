import {useCallback, useEffect, useRef, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import {
    isAssistantMessage,
    type AssistantTextPart,
    type AssistantToolPart,
    type ChatAssistantMessage,
    type ChatMessage,
    type ChatUserMessage,
    type EventMap,
} from "./types.ts";

/**
 * Messages of ONE session, live. Seeded from `GET …/message?order=asc`,
 * then driven by the fine-grained execution events on `/api/event`
 * (session.inbox.enqueued / step.started / text.delta / tool.* / step.ended)
 * so the conversation renders as it happens. Events for other sessions are
 * ignored — switching back re-seeds from the server, which is always the
 * source of truth.
 */
export function useSessionMessages(
    api: OpencodeApi | null,
    subscribe: (handler: OpencodeEventHandler) => () => void,
    sessionId: string | null,
): {
    messages: ChatMessage[];
    send: (text: string) => Promise<void>;
    interrupt: () => Promise<void>;
} {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const apiRef = useRef(api);
    apiRef.current = api;
    const sessionRef = useRef(sessionId);
    sessionRef.current = sessionId;
    // Generation guard: ignore async results from a previous session load.
    const loadGen = useRef(0);

    // Seed on connect / session switch.
    useEffect(() => {
        const gen = ++loadGen.current;
        setMessages([]);
        if (!api || !sessionId) return;
        api.listMessages(sessionId).then((list) => {
            if (gen !== loadGen.current) return; // switched away meanwhile
            setMessages(list ?? []);
        }).catch((e) => {
            if (gen !== loadGen.current) return;
            logError(`Failed to load messages for ${sessionId}: ${e}`).catch(() => {});
        });
    }, [api, sessionId]);

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
                    setMessages((prev) => {
                        // Adopt the optimistic bubble this client appended in
                        // send() (swap in the server id)…
                        const last = prev[prev.length - 1];
                        if (
                            last && last.type === "user" &&
                            last.id.startsWith("local-") && last.text === text
                        ) {
                            return [...prev.slice(0, -1), {id: inboxID, type: "user", text}];
                        }
                        // …or append when the prompt came from another client.
                        return [...prev, {id: inboxID, type: "user", text}];
                    });
                    break;
                }
                case "session.step.started": {
                    const d = data as EventMap["session.step.started"];
                    upsertAssistant({
                        id: d.assistantMessageID,
                        type: "assistant",
                        agent: d.agent,
                        model: d.model,
                        content: [],
                        time: {created: d.started},
                    });
                    break;
                }
                case "session.text.started": {
                    const d = data as EventMap["session.text.started"];
                    mutateAssistant(d.assistantMessageID, (m) => {
                        m.content = [...m.content, {type: "text", text: ""} satisfies AssistantTextPart];
                    });
                    break;
                }
                case "session.text.delta": {
                    const d = data as EventMap["session.text.delta"];
                    mutateAssistant(d.assistantMessageID, (m) => {
                        const part = nthTextPart(m, d.ordinal);
                        if (part) part.text = part.text + d.delta;
                        else m.content = [...m.content, {type: "text", text: d.delta}];
                    });
                    break;
                }
                case "session.text.ended": {
                    const d = data as EventMap["session.text.ended"];
                    mutateAssistant(d.assistantMessageID, (m) => {
                        const part = nthTextPart(m, d.ordinal);
                        if (part) part.text = d.text;
                    });
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
                case "session.tool.error": {
                    const d = data as EventMap["session.tool.error"];
                    mutateTool(d.assistantMessageID, d.id, (t) => {
                        t.state = {status: "error", input: t.state.input, error: d.error};
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

    // --- Immutable-state helpers. Each produces a new array/object so React
    //     re-renders; the draft mutation happens on a shallow clone. ---

    function upsertAssistant(msg: ChatAssistantMessage) {
        setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg];
        });
    }

    function mutateAssistant(id: string, fn: (draft: ChatAssistantMessage) => void) {
        setMessages((prev) =>
            prev.map((m) => {
                if (!isAssistantMessage(m) || m.id !== id) return m;
                const draft: ChatAssistantMessage = {
                    ...m,
                    content: [...m.content],
                    time: {...(m.time ?? {})},
                };
                fn(draft);
                return draft;
            }),
        );
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

    /** The nth AssistantTextPart (the event `ordinal` indexes text parts). */
    function nthTextPart(m: ChatAssistantMessage, ordinal: number): AssistantTextPart | undefined {
        let seen = -1;
        for (const part of m.content) {
            if (part.type === "text") {
                seen += 1;
                if (seen === ordinal) return part;
            }
        }
        return undefined;
    }

    // --- Actions ---

    const send = useCallback(async (text: string) => {
        const trimmed = text.trim();
        const a = apiRef.current;
        const sid = sessionRef.current;
        if (!a || !sid || !trimmed) return;
        // Optimistic user bubble; the server response confirms with the real
        // id (inbox.enqueued adds a duplicate-by-text that we dedupe below).
        const optimistic: ChatUserMessage = {
            id: `local-${Date.now()}`,
            type: "user",
            text: trimmed,
        };
        setMessages((prev) => [...prev, optimistic]);
        try {
            await a.sendPrompt(sid, trimmed);
        } catch (e) {
            logError(`Failed to send prompt: ${e}`).catch(() => {});
            // Drop the optimistic bubble so the failure is visible.
            setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
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

    return {messages, send, interrupt};
}
