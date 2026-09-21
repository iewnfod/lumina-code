import {useEffect, useRef} from "react";
import {useSurfaceColors} from "../../hooks/surfaceColors.ts";
import type {ChatMessage} from "../../opencode/types.ts";
import {isAssistantMessage} from "../../opencode/types.ts";
import MessageItem from "./MessageItem.tsx";
import ChatInput from "./ChatInput.tsx";

/**
 * The conversation view for the active session: a transcript column (user
 * bubbles + assistant documents with tool cards, streaming live from the
 * event bus) over the prompt composer.
 *
 * Auto-scrolls to the newest content while the user is parked at the bottom;
 * scrolling up pauses the follow behavior so history can be read.
 */
export default function ChatView({
    backgroundColor,
    messages,
    busy,
    disabled,
    onSend,
    onInterrupt,
}: {
    backgroundColor: string;
    messages: ChatMessage[];
    busy: boolean;
    /** No connection / no session selected. */
    disabled: boolean;
    onSend: (text: string) => void;
    onInterrupt: () => void;
}) {
    const colors = useSurfaceColors(backgroundColor);
    const scrollRef = useRef<HTMLDivElement>(null);
    const atBottomRef = useRef(true);

    const visible = messages.filter((m) => m.type === "user" || m.type === "assistant");
    // An assistant message still lacks its completion stamp while the
    // session is working — that's the streaming state (caret / "working…").
    const isStreaming = (m: ChatMessage) => busy && isAssistantMessage(m) && !m.time?.completed;

    useEffect(() => {
        const el = scrollRef.current;
        if (el && atBottomRef.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [messages]);

    const handleScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };

    return (
        <div className="flex flex-col h-full w-full min-w-0">
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto overflow-x-hidden"
            >
                <div className="max-w-3xl mx-auto w-full flex flex-col gap-5 px-6 py-6">
                    {visible.length === 0 && (
                        <div className="flex items-center justify-center h-full min-h-40 text-sm opacity-40 select-none">
                            {disabled ? "Waiting for OpenCode…" : "Send a message to start"}
                        </div>
                    )}
                    {visible.map((m) => (
                        <MessageItem
                            key={m.id}
                            message={m}
                            colors={colors}
                            streaming={isStreaming(m)}
                        />
                    ))}
                </div>
            </div>
            <div className="shrink-0 max-w-3xl mx-auto w-full px-6 pb-4">
                <ChatInput
                    colors={colors}
                    disabled={disabled}
                    busy={busy}
                    onSend={onSend}
                    onInterrupt={onInterrupt}
                />
            </div>
        </div>
    );
}
