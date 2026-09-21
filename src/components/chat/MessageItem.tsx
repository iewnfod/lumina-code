import {memo, useEffect, useState} from "react";
import {AlertCircle, Brain, FileText, Loader2, Wrench} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import type {
    AssistantPart,
    AssistantReasoningPart,
    AssistantTextPart,
    AssistantToolPart,
    ChatAssistantMessage,
    ChatMessage,
    ChatUserMessage,
} from "../../opencode/types.ts";
import {isAssistantMessage, isUserMessage} from "../../opencode/types.ts";
import Markdown from "./Markdown.tsx";
import ToolCard, {toolDisplayName} from "./ToolCard.tsx";
import FoldRow from "./FoldRow.tsx";

/**
 * One transcript entry. User messages are right-aligned accent bubbles;
 * assistant messages read as documents (reasoning disclosure, markdown,
 * tool cards). Marker messages (idle/system/…) are filtered upstream.
 *
 * Memoized: streaming updates clone only the message being appended to, so
 * the rest of a long transcript skips re-rendering entirely.
 */
const MessageItem = memo(function MessageItem({
    message,
    colors,
    streaming,
}: {
    message: ChatMessage;
    colors: SurfaceColors;
    /** True while this assistant message is still being produced. */
    streaming: boolean;
}) {
    if (isUserMessage(message)) {
        return <UserBubble message={message} colors={colors} />;
    }
    if (isAssistantMessage(message)) {
        return <AssistantBlock message={message} colors={colors} streaming={streaming} />;
    }
    return null;
});

export default MessageItem;

function UserBubble({message, colors}: {message: ChatUserMessage; colors: SurfaceColors}) {
    const files = message.files ?? [];
    return (
        // Extra vertical margin sets the turn apart from the tight
        // assistant flow around it (the column gap is only 12px).
        <div className="flex justify-end my-4">
            <div
                className="max-w-[85%] rounded-[var(--radius-lg)] px-4 py-2.5 whitespace-pre-wrap break-words text-sm"
                style={{background: colors.accentOverlay}}
            >
                {files.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-1.5 pb-2 mb-2 border-b border-white/10">
                        {files.map((f, i) => {
                            const src = typeof f.uri === "string" ? f.uri
                                : f.data && f.mime ? `data:${f.mime};base64,${f.data}`
                                : null;
                            return (
                                <span
                                    key={i}
                                    title={f.name}
                                    className="inline-flex items-center gap-1.5 h-7 pl-1.5 pr-2.5 rounded-[var(--radius-sm)] max-w-56"
                                    style={{background: "rgba(128,128,128,0.18)"}}
                                >
                                    {f.mime?.startsWith("image/") && src ? (
                                        <img src={src} alt="" className="w-5 h-5 rounded-[var(--radius-xs)] object-cover shrink-0"/>
                                    ) : (
                                        <FileText size={13} className="shrink-0 opacity-60"/>
                                    )}
                                    <span className="text-xs truncate">{f.name ?? "file"}</span>
                                </span>
                            );
                        })}
                    </div>
                )}
                {message.text}
            </div>
        </div>
    );
}

export type ActivityPart = AssistantReasoningPart | AssistantToolPart;

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
type Segment =
    | {kind: "text"; part: AssistantTextPart}
    | {kind: "activity"; parts: ActivityPart[]};

/**
 * Fold consecutive reasoning/tool parts into segments; text parts break the
 * runs. Runs of 2+ render as one ActivityGroup disclosure so a wall of tool
 * calls and thoughts doesn't bury the prose.
 *
 * Whitespace-only text parts are skipped entirely: providers emit empty
 * text blocks between tool calls, and they'd both split runs (defeating the
 * merge) and render as stray gaps.
 */
function segmentContent(content: AssistantPart[]): Segment[] {
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

function AssistantBlock({
    message,
    colors,
    streaming,
}: {
    message: ChatAssistantMessage;
    colors: SurfaceColors;
    streaming: boolean;
}) {
    // The part currently receiving frames (reasoning before the answer,
    // text after) drives the per-part live states.
    const lastPart = effectiveTailPart(message);
    const reasoningLive = streaming && lastPart?.type === "reasoning";
    // The activity part being streamed right now, if any — its group (or
    // card) expands live and folds when the run finishes.
    const livePart: ActivityPart | null =
        streaming && lastPart != null && lastPart.type !== "text" ? lastPart : null;
    const toolRunning = message.content.some(
        (p) => p.type === "tool" && p.state.status === "running",
    );
    const showTrailingIndicator = streaming && !reasoningLive;

    return (
        <div className="flex flex-col gap-3 min-w-0">
            {segmentContent(message.content).map((segment, i) => {
                if (segment.kind === "text") {
                    return (
                        <div key={i} className="min-w-0">
                            <Markdown>{segment.part.text}</Markdown>
                        </div>
                    );
                }
                // A lone part keeps its dedicated affordance — no point
                // wrapping a single tool call or thought in a group.
                if (segment.parts.length === 1) {
                    const part = segment.parts[0];
                    return part.type === "reasoning" ? (
                        <ThinkingBlock key={i} part={part} live={reasoningLive && part === lastPart} />
                    ) : (
                        <ToolCard key={part.id ?? i} part={part} colors={colors} />
                    );
                }
                return (
                    <ActivityGroup
                        key={i}
                        parts={segment.parts}
                        colors={colors}
                        livePart={livePart}
                    />
                );
            })}
            {showTrailingIndicator && !toolRunning && (
                <div className="flex items-center gap-1.5 h-4">
                    <span className="inline-block w-[2px] h-[1em] bg-current animate-pulse rounded-[1px]" />
                </div>
            )}
        </div>
    );
}

/**
 * A run of consecutive tool calls / thoughts folded into one disclosure —
 * long agentic stretches read as a single collapsed summary line instead
 * of a wall of cards. Expanded while anything inside is streaming, folds
 * when the run finishes (an explicit user toggle wins, as elsewhere).
 */
export function ActivityGroup({
    parts,
    colors,
    livePart,
}: {
    parts: ActivityPart[];
    colors: SurfaceColors;
    /** The message part currently streaming, if it lives in this group. */
    livePart: ActivityPart | null;
}) {
    const [expanded, setExpanded] = useState(false);
    const [userToggled, setUserToggled] = useState(false);

    const live = livePart != null && parts.includes(livePart);
    const running = parts.some((p) => p.type === "tool" && p.state.status === "running");
    const errored = parts.some((p) => p.type === "tool" && p.state.status === "error");
    const toolCount = parts.filter((p) => p.type === "tool").length;
    const thoughtCount = parts.length - toolCount;
    useEffect(() => {
        if (userToggled) return;
        setExpanded(live);
    }, [live, userToggled]);

    // Cross-message groups can be briefly empty (steps just opened, no
    // parts yet) — render nothing rather than a blank disclosure line.
    if (parts.length === 0) return null;

    const bits: string[] = [];
    if (toolCount > 0) bits.push(`${toolCount} tool call${toolCount > 1 ? "s" : ""}`);
    if (thoughtCount > 0) bits.push(`${thoughtCount} thought${thoughtCount > 1 ? "s" : ""}`);
    const label = running ? "Working…" : bits.join(" · ");
    // Distinct tool names involved, e.g. "Edit · Shell · Grep".
    const names = [...new Set(
        parts.filter((p) => p.type === "tool").map((p) => toolDisplayName(p.name)),
    )];

    return (
        <FoldRow
            icon={running
                ? <Loader2 size={14} className="animate-spin" />
                : errored
                    ? <AlertCircle size={14} style={{color: "#ef4444"}} />
                    : <Wrench size={14} />}
            title={label}
            detail={names.length > 0 ? (
                <span className="truncate">{names.join(" · ")}</span>
            ) : null}
            expanded={expanded}
            onToggle={() => {
                setUserToggled(true);
                setExpanded((v) => !v);
            }}
        >
            <div
                className="flex flex-col gap-1.5 pt-1.5 pl-2.5 ml-1 border-l"
                style={{borderColor: colors.glassBorder}}
            >
                {parts.map((part, i) =>
                    part.type === "reasoning" ? (
                        <ThinkingBlock key={i} part={part} live={livePart === part} />
                    ) : (
                        <ToolCard key={part.id ?? i} part={part} colors={colors} />
                    ),
                )}
            </div>
        </FoldRow>
    );
}

/**
 * Reasoning-model thinking process: a dimmed disclosure above the answer.
 * Expanded (live) while the thoughts stream in, auto-collapsed once the
 * model moves on to the answer — unless the reader toggled it themselves.
 */
function ThinkingBlock({part, live}: {part: AssistantReasoningPart; live: boolean}) {
    const [expanded, setExpanded] = useState(false);
    const [userToggled, setUserToggled] = useState(false);

    useEffect(() => {
        if (userToggled) return;
        setExpanded(live);
    }, [live, userToggled]);

    // Collapsed rows carry the thought's first line as a preview.
    const snippet = part.text.trim().split("\n")[0] ?? "";

    return (
        <FoldRow
            icon={<Brain size={14} className={live ? "animate-pulse" : ""} />}
            title={live ? "Thinking…" : "Thought process"}
            detail={!expanded && snippet ? (
                <span className="truncate">{snippet}</span>
            ) : null}
            expanded={expanded}
            onToggle={() => {
                setUserToggled(true);
                setExpanded((v) => !v);
            }}
        >
            <div className="ml-5 mt-0.5 mb-1 text-sm whitespace-pre-wrap break-words max-h-72 overflow-y-auto opacity-60 leading-relaxed">
                {part.text}
            </div>
        </FoldRow>
    );
}
