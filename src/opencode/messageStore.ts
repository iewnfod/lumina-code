import type {MessagesPage, OpencodeEvent} from "./api.ts";
import {
    isAssistantMessage,
    type AssistantPart,
    type AssistantToolPart,
    type ChatAssistantMessage,
    type ChatMessage,
    type EventMap,
    type ToolState,
} from "./types.ts";

/**
 * Pure message-list logic for ONE session: the event-bus reducer and the
 * server-page merges. Framework-free on purpose — the module-level store
 * in useSessionMessages.ts keeps one list per session alive across
 * ChatView unmounts, so switching sessions must never rebuild a list from
 * a server snapshot alone: the opencode server persists a reasoning/text
 * part only when it ENDS (deltas are bus-only — verified against v2.0.11
 * message-updater.ts), so a mid-run snapshot carries the part as "".
 *
 * Everything here is clone-on-write: untouched messages keep their
 * identity so ChatView's memoized rows skip re-rendering.
 */

/** Apply one bus event to a session's list; returns the same array when
 *  the event changes nothing. Frames for other sessions are ignored. */
export function applyEvent(list: ChatMessage[], event: OpencodeEvent): ChatMessage[] {
    const data = event.data as {sessionID?: string} | null;
    if (!data) return list;

    switch (event.type) {
        case "session.inbox.enqueued": {
            const d = data as EventMap["session.inbox.enqueued"];
            if (d.item?.type !== "user") return list;
            const text = d.item.payload?.text ?? "";
            const files = d.item.payload?.files;
            // Already held (seed race or another handler pass)?
            if (list.some((m) => m.id === d.inboxID)) return list;
            // Adopt the optimistic bubble send() appended (swap in the
            // server id)…
            const last = list[list.length - 1];
            if (
                last && last.type === "user" &&
                last.id.startsWith("local-") && last.text === text
            ) {
                return [...list.slice(0, -1), {id: d.inboxID, type: "user", text, files}];
            }
            // …or append when the prompt came from another client.
            return [...list, {id: d.inboxID, type: "user", text, files}];
        }
        case "session.step.started": {
            const d = data as EventMap["session.step.started"];
            return list.some((m) => m.id === d.assistantMessageID)
                ? list
                : [
                    ...list,
                    {
                        id: d.assistantMessageID,
                        type: "assistant",
                        agent: d.agent,
                        model: d.model,
                        content: [],
                        time: {created: d.started},
                    } satisfies ChatAssistantMessage,
                ];
        }
        case "session.reasoning.started":
            return appendStreamPart(list, (data as EventMap["session.reasoning.started"]).assistantMessageID, (data as EventMap["session.reasoning.started"]).ordinal, "reasoning");
        case "session.reasoning.delta":
            return appendStreamDelta(list, (data as EventMap["session.reasoning.delta"]).assistantMessageID, (data as EventMap["session.reasoning.delta"]).ordinal, "reasoning", (data as EventMap["session.reasoning.delta"]).delta);
        case "session.reasoning.ended":
            return settleStreamPart(list, (data as EventMap["session.reasoning.ended"]).assistantMessageID, (data as EventMap["session.reasoning.ended"]).ordinal, "reasoning", (data as EventMap["session.reasoning.ended"]).text);
        case "session.text.started":
            return appendStreamPart(list, (data as EventMap["session.text.started"]).assistantMessageID, (data as EventMap["session.text.started"]).ordinal, "text");
        case "session.text.delta":
            return appendStreamDelta(list, (data as EventMap["session.text.delta"]).assistantMessageID, (data as EventMap["session.text.delta"]).ordinal, "text", (data as EventMap["session.text.delta"]).delta);
        case "session.text.ended":
            return settleStreamPart(list, (data as EventMap["session.text.ended"]).assistantMessageID, (data as EventMap["session.text.ended"]).ordinal, "text", (data as EventMap["session.text.ended"]).text);
        case "session.tool.input.started": {
            const d = data as EventMap["session.tool.input.started"];
            return mutateAssistant(list, d.assistantMessageID, (m) => {
                m.content = [
                    ...m.content,
                    {
                        type: "tool",
                        id: d.id,
                        name: d.name,
                        state: {status: "pending"},
                    } satisfies AssistantToolPart,
                ];
            }, true);
        }
        case "session.tool.called": {
            const d = data as EventMap["session.tool.called"];
            return mutateTool(list, d.assistantMessageID, d.id, (t) => {
                t.state = {status: "running", input: d.input};
            });
        }
        case "session.tool.success": {
            const d = data as EventMap["session.tool.success"];
            return mutateTool(list, d.assistantMessageID, d.id, (t) => {
                t.state = {
                    status: "completed",
                    input: t.state.input,
                    content: d.content,
                    metadata: d.metadata,
                };
            });
        }
        case "session.tool.error":
        case "session.tool.failed":
            // v2.0.11 emits "failed"; "error" kept for older builds —
            // identical payload.
            return mutateTool(list, (data as EventMap["session.tool.failed"]).assistantMessageID, (data as EventMap["session.tool.failed"]).id, (t) => {
                t.state = {status: "error", input: t.state.input, error: (data as EventMap["session.tool.failed"]).error};
            });
        case "session.step.failed": {
            const d = data as EventMap["session.step.failed"];
            return mutateAssistant(list, d.assistantMessageID, (m) => {
                m.error = d.error;
                m.time = {...(m.time ?? {}), completed: Date.now()};
            });
        }
        case "session.step.ended": {
            const d = data as EventMap["session.step.ended"];
            return mutateAssistant(list, d.assistantMessageID, (m) => {
                m.finish = d.finish;
                m.time = {...(m.time ?? {}), completed: Date.now()};
            });
        }
        default:
            return list;
    }
}

/** Reconcile with the NEWEST server page (order=desc on the wire →
 *  ascending here). Messages present on both sides merge part-by-part —
 *  the server snapshot predates locally observed events, so locally
 *  streamed text (longer, mid-flight) and settled completion stamps must
 *  survive, while page-only content (history we never held, e.g. missed
 *  across an event-stream gap) is adopted. Locally held messages the page
 *  doesn't know about (optimistic bubbles, frames newer than the
 *  snapshot) stay appended. */
export function applySeedPage(
    list: ChatMessage[],
    page: MessagesPage,
): {messages: ChatMessage[]; cursor: string | null} {
    const ascending = (page?.data ?? []).slice().reverse();
    const byId = new Map(list.map((m) => [m.id, m]));
    const messages = ascending.map((pm) => {
        const local = byId.get(pm.id);
        if (!local) return pm;
        if (!isAssistantMessage(local) || !isAssistantMessage(pm)) return pm;
        return mergeAssistant(local, pm);
    });
    const pageIds = new Set(ascending.map((m) => m.id));
    for (const m of list) {
        if (!pageIds.has(m.id)) messages.push(m);
    }
    return {messages, cursor: page?.cursor?.next ?? null};
}

/** Prepend the next-older page (already ascending on the wire via
 *  reversal; ids we already hold are skipped defensively). */
export function applyOlderPage(
    list: ChatMessage[],
    page: MessagesPage,
): {messages: ChatMessage[]; cursor: string | null} {
    const older = (page?.data ?? []).slice().reverse();
    const held = new Set(list.map((m) => m.id));
    const fresh = older.filter((m) => !held.has(m.id));
    return {
        messages: fresh.length > 0 ? [...fresh, ...list] : list,
        cursor: page?.cursor?.next ?? null,
    };
}

// --- Part plumbing (stream `ordinal`s are per-kind). ---

function appendStreamPart(
    list: ChatMessage[],
    messageId: string,
    ordinal: number,
    kind: "text" | "reasoning",
): ChatMessage[] {
    return mutateAssistant(list, messageId, (m) => {
        if (nthPart(m, kind, ordinal)) return;
        m.content = [...m.content, kind === "text"
            ? {type: "text", text: ""}
            : {type: "reasoning", text: ""}];
    }, true);
}

function appendStreamDelta(
    list: ChatMessage[],
    messageId: string,
    ordinal: number,
    kind: "text" | "reasoning",
    delta: string,
): ChatMessage[] {
    return mutateAssistant(list, messageId, (m) => {
        const part = nthPart(m, kind, ordinal);
        if (part) part.text = part.text + delta;
        else {
            m.content = [...m.content, kind === "text"
                ? {type: "text", text: delta}
                : {type: "reasoning", text: delta}];
        }
    }, true);
}

function settleStreamPart(
    list: ChatMessage[],
    messageId: string,
    ordinal: number,
    kind: "text" | "reasoning",
    text: string,
): ChatMessage[] {
    return mutateAssistant(list, messageId, (m) => {
        const part = nthPart(m, kind, ordinal);
        if (part) part.text = text;
    }, true);
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

// --- Clone-on-write helpers. Each produces new arrays/objects so React
//     re-renders while untouched messages keep their identity (memo). ---

function mutateAssistant(
    list: ChatMessage[],
    id: string,
    fn: (draft: ChatAssistantMessage) => void,
    ensure = false,
): ChatMessage[] {
    // Re-attach: a content event may reference a message whose
    // step.started predated this list or an event-stream gap (webview
    // reload / reconnect while the run continued server-side) — create
    // the shell on demand so streaming resumes instead of silently
    // dropping the frames.
    if (ensure && !list.some((m) => isAssistantMessage(m) && m.id === id)) {
        const draft: ChatAssistantMessage = {
            id,
            type: "assistant",
            content: [],
            time: {created: Date.now()},
        };
        fn(draft);
        return [...list, draft];
    }
    let changed = false;
    const next = list.map((m) => {
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
    return changed ? next : list;
}

function mutateTool(
    list: ChatMessage[],
    messageId: string,
    toolId: string,
    fn: (draft: AssistantToolPart) => void,
): ChatMessage[] {
    return mutateAssistant(list, messageId, (m) => {
        m.content = m.content.map((p) => {
            if (p.type !== "tool" || p.id !== toolId) return p;
            const draft: AssistantToolPart = {...p, state: {...p.state}, time: {...p.time}};
            fn(draft);
            return draft;
        });
    }, true);
}

// --- Seed-merge helpers. ---

/** Terminal tool outcomes outrank in-flight ones; a stale page snapshot
 *  must never regress a locally observed completion. */
function toolRank(status: ToolState["status"]): number {
    if (status === "completed" || status === "error") return 2;
    return status === "running" ? 1 : 0;
}

/** The nth part of a given type (per-type ordinal, like stream ordinals). */
function partOfType(m: ChatAssistantMessage, index: number, type: AssistantPart["type"]): AssistantPart | undefined {
    let seen = -1;
    for (const part of m.content) {
        if (part.type === type) {
            seen += 1;
            if (seen === index) return part;
        }
    }
    return undefined;
}

/** Merge a locally accumulated assistant message with the server's
 *  snapshot of it. Parts align by per-type ordinal (parts are appended,
 *  never reordered); text/reasoning keep whichever copy is longer (the
 *  local one is mid-stream, the page's predates the stream), tools keep
 *  whichever state is further along. Local-only trailing parts survive. */
function mergeAssistant(local: ChatAssistantMessage, page: ChatAssistantMessage): ChatAssistantMessage {
    const pageCounts: Record<AssistantPart["type"], number> = {text: 0, reasoning: 0, tool: 0};
    const merged: AssistantPart[] = [];
    for (const pagePart of page.content) {
        const idx = pageCounts[pagePart.type]++;
        const localPart = partOfType(local, idx, pagePart.type);
        merged.push(mergePart(localPart, pagePart));
    }
    // Locally observed parts the snapshot doesn't have yet — the tail
    // that is still streaming.
    const localCounts: Record<AssistantPart["type"], number> = {text: 0, reasoning: 0, tool: 0};
    for (const part of local.content) {
        if (localCounts[part.type]++ >= pageCounts[part.type]) merged.push(part);
    }
    return {
        ...page,
        content: merged,
        // Completion may have landed as an event after the snapshot.
        finish: local.finish ?? page.finish,
        error: local.error ?? page.error,
        time: {...page.time, completed: local.time?.completed ?? page.time?.completed},
    };
}

function mergePart(local: AssistantPart | undefined, page: AssistantPart): AssistantPart {
    if (!local) return page;
    if (page.type === "text" || page.type === "reasoning") {
        if (local.type !== page.type) return page;
        return local.text.length > page.text.length ? {...page, text: local.text} : page;
    }
    if (page.type === "tool" && local.type === "tool" && local.id === page.id &&
        toolRank(local.state.status) > toolRank(page.state.status)) {
        return {...page, state: local.state, executed: local.executed ?? page.executed};
    }
    return page;
}
