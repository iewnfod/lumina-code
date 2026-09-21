import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import type {ChatAssistantMessage, ChatMessage, ChatUserMessage} from "../../opencode/types.ts";
import {isAssistantMessage, isUserMessage} from "../../opencode/types.ts";
import Markdown from "./Markdown.tsx";
import ToolCard from "./ToolCard.tsx";

/**
 * One transcript entry. User messages are right-aligned accent bubbles;
 * assistant messages read as documents (markdown + tool cards). Marker
 * messages (idle/system/…) are filtered upstream, not here.
 */
export default function MessageItem({
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
}

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
    const hasToolRunning = message.content.some(
        (p) => p.type === "tool" && p.state.status === "running",
    );
    return (
        <div className="flex flex-col gap-1 min-w-0">
            {message.content.map((part, i) =>
                part.type === "text" ? (
                    <div key={i} className="min-w-0">
                        <Markdown>{part.text}</Markdown>
                    </div>
                ) : (
                    <ToolCard key={part.id ?? i} part={part} colors={colors} />
                ),
            )}
            {/* Activity indicator: a blinking caret while text streams in,
                a subtle "working" hint while a tool runs. */}
            {streaming && (
                <div className="flex items-center gap-1.5 h-4">
                    {hasToolRunning ? (
                        <span className="text-xs opacity-50">working…</span>
                    ) : (
                        <span className="inline-block w-[2px] h-[1em] bg-current animate-pulse rounded-[1px]" />
                    )}
                </div>
            )}
        </div>
    );
}
