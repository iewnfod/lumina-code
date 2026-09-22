import type {
    AssistantPart,
    AssistantReasoningPart,
    AssistantTextPart,
    AssistantToolPart,
    ChatAssistantMessage,
} from "../../opencode/types.ts";

/**
 * Content-part segmentation for assistant messages (pure) — shared by
 * MessageItem (intra-message folding) and ChatView's cross-message
 * activity runs. Extracted so the mapping is testable and both callers
 * agree on part identity/keys.
 */

export type ActivityPart = AssistantReasoningPart | AssistantToolPart;

/** One activity part of a folded run, paired with its stable key. */
export type ActivityEntry = {part: ActivityPart; key: string};

/** The message's effective tail — trailing whitespace-only text parts
 *  (providers emit empty text blocks between tool calls) don't count. */
export function effectiveTailPart(m: ChatAssistantMessage): AssistantPart | undefined {
    let end = m.content.length;
    while (end > 0) {
        const p = m.content[end - 1];
        if (p.type === "text" && p.text.trim() === "") {
            end--;
            continue;
        }
        break;
    }
    return end > 0 ? m.content[end - 1] : undefined;
}

/** Display segment: a text part, or a run of consecutive activity parts. */
export type Segment =
    | {kind: "text"; part: AssistantTextPart}
    | {kind: "activity"; parts: ActivityPart[]};

/** Stable identity for an activity part: `${message.id}:${indexInMessage}`.
 *  Parts are appended (never reordered) and streaming updates mutate part
 *  objects in place, so both the index and the object identity hold for the
 *  part's lifetime — the key survives ChatView's run regrouping, where the
 *  same part moves between component subtrees and must keep its expansion
 *  state. */
export function partKey(message: ChatAssistantMessage, part: ActivityPart): string {
    return `${message.id}:${message.content.indexOf(part)}`;
}

/**
 * Fold consecutive reasoning/tool parts into segments; text parts break the
 * runs. Runs of 2+ render as one ActivityGroup disclosure so a wall of tool
 * calls and thoughts doesn't bury the prose.
 *
 * Whitespace-only text parts are skipped entirely: providers emit empty
 * text blocks between tool calls, and they'd both split runs (defeating the
 * merge) and render as stray gaps.
 */
export function segmentContent(content: AssistantPart[]): Segment[] {
    const segments: Segment[] = [];
    for (const part of content) {
        if (part.type === "text") {
            if (part.text.trim() === "") continue;
            segments.push({kind: "text", part});
            continue;
        }
        const last = segments[segments.length - 1];
        if (last?.kind === "activity") last.parts.push(part);
        else segments.push({kind: "activity", parts: [part]});
    }
    return segments;
}
