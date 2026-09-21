import {memo, useEffect, useState} from "react";
import {Brain, ChevronDown, ChevronRight} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import type {
    AssistantReasoningPart,
    ChatAssistantMessage,
    ChatMessage,
    ChatUserMessage,
} from "../../opencode/types.ts";
import {isAssistantMessage, isUserMessage} from "../../opencode/types.ts";
import Markdown from "./Markdown.tsx";
import ToolCard from "./ToolCard.tsx";

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
    return (
        <div className="flex justify-end">
            <div
                className="max-w-[85%] rounded-[var(--radius-lg)] px-4 py-2.5 whitespace-pre-wrap break-words text-sm"
                style={{background: colors.accentOverlay}}
            >
                {message.text}
            </div>
        </div>
    );
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
    const lastPart = message.content[message.content.length - 1];
    const reasoningLive = streaming && lastPart?.type === "reasoning";
    const toolRunning = message.content.some(
        (p) => p.type === "tool" && p.state.status === "running",
    );
    const showTrailingIndicator = streaming && !reasoningLive;

    return (
        <div className="flex flex-col gap-1 min-w-0">
            {message.content.map((part, i) => {
                if (part.type === "reasoning") {
                    return (
                        <ThinkingBlock
                            key={i}
                            part={part}
                            live={reasoningLive && part === lastPart}
                        />
                    );
                }
                if (part.type === "text") {
                    return (
                        <div key={i} className="min-w-0">
                            <Markdown>{part.text}</Markdown>
                        </div>
                    );
                }
                return <ToolCard key={part.id ?? i} part={part} colors={colors} />;
            })}
            {showTrailingIndicator && (
                <div className="flex items-center gap-1.5 h-4">
                    {toolRunning ? (
                        <span className="text-xs opacity-50">working…</span>
                    ) : (
                        <span className="inline-block w-[2px] h-[1em] bg-current animate-pulse rounded-[1px]" />
                    )}
                </div>
            )}
        </div>
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

    return (
        <div className="lum-thinking rounded-[var(--radius-md)]">
            <button
                type="button"
                className="flex items-center gap-1.5 cursor-pointer text-xs select-none py-1 opacity-60 hover:opacity-90 transition-opacity duration-[var(--duration-fast)]"
                onClick={() => {
                    setUserToggled(true);
                    setExpanded((v) => !v);
                }}
            >
                <Brain size={13} className={live ? "animate-pulse" : ""} />
                <span>{live ? "Thinking…" : "Thought process"}</span>
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {expanded && (
                <div className="text-xs whitespace-pre-wrap break-words max-h-72 overflow-y-auto opacity-60 leading-relaxed pl-0.5">
                    {part.text}
                </div>
            )}
        </div>
    );
}
