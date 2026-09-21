import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import {useSurfaceColors} from "../../hooks/surfaceColors.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {OpencodeEventHandler} from "../../opencode/useOpencode.ts";
import type {ChatMessage} from "../../opencode/types.ts";
import {isAssistantMessage} from "../../opencode/types.ts";
import {useSessionMessages} from "../../opencode/useSessionMessages.ts";
import MessageItem from "./MessageItem.tsx";
import ChatInput from "./ChatInput.tsx";

/**
 * The conversation view for the active session: a transcript column (user
 * bubbles + assistant documents, streaming live) over the prompt composer.
 *
 * Built for long sessions — the transcript DOM stays bounded:
 * - Only the newest RENDER_LIMIT messages mount; an IntersectionObserver on
 *   the top sentinel grows the window (and fetches older pages from the
 *   server via cursor) as the reader scrolls up. Scroll anchoring keeps the
 *   viewport steady while content is prepended above it.
 * - The message state lives here (not in App), so streaming re-renders are
 *   confined to this subtree; rows are memoized and only the message being
 *   appended to re-renders.
 * - Auto-scrolls to the newest content while the user is parked at the
 *   bottom; scrolling up pauses the follow behavior so history stays put.
 */

/** How many transcript entries mount initially / per expansion. */
const RENDER_LIMIT = 60;

const ChatView = memo(function ChatView({
    api,
    subscribe,
    sessionId,
    backgroundColor,
    busy,
    disabled,
}: {
    api: OpencodeApi | null;
    subscribe: (handler: OpencodeEventHandler) => () => void;
    sessionId: string;
    backgroundColor: string;
    busy: boolean;
    /** No connection. */
    disabled: boolean;
}) {
    const colors = useSurfaceColors(backgroundColor);
    const {messages, hasMore, loadingOlder, loadOlder, send, interrupt} =
        useSessionMessages(api, subscribe, sessionId);

    const scrollRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const atBottomRef = useRef(true);
    // Scroll anchor: scrollHeight captured right before a window expansion
    // commits, restored (+delta) after, so prepended content doesn't jump.
    const anchorHeightRef = useRef<number | null>(null);

    const [renderLimit, setRenderLimit] = useState(RENDER_LIMIT);
    useEffect(() => {
        setRenderLimit(RENDER_LIMIT);
    }, [sessionId]);

    const visible = messages.filter((m) => m.type === "user" || m.type === "assistant");
    const hiddenCount = Math.max(0, visible.length - renderLimit);
    const rendered = hiddenCount > 0 ? visible.slice(-renderLimit) : visible;
    const showTopSentinel = hiddenCount > 0 || hasMore;

    // An assistant message still lacks its completion stamp while the
    // session is working — that's the streaming state (caret / thinking).
    const isStreaming = (m: ChatMessage) => busy && isAssistantMessage(m) && !m.time?.completed;

    // Grow the render window / fetch an older page (both directions of
    // "earlier": in-memory tail first, then the server cursor).
    const loadEarlier = useCallback(() => {
        setRenderLimit((limit) => {
            if (limit >= visible.length) return limit;
            anchorHeightRef.current = scrollRef.current?.scrollHeight ?? null;
            return limit + RENDER_LIMIT;
        });
        // Running low on the in-memory window? Fetch the next older page.
        if (visible.length - RENDER_LIMIT <= RENDER_LIMIT && hasMore) {
            loadOlder();
        }
    }, [visible.length, hasMore, loadOlder]);

    // Auto-load when the top sentinel scrolls into view.
    useEffect(() => {
        const sentinel = sentinelRef.current;
        const scroller = scrollRef.current;
        if (!sentinel || !scroller || !showTopSentinel) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) loadEarlier();
            },
            {root: scroller, rootMargin: "200px"},
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [loadEarlier, showTopSentinel]);

    // Restore the scroll position after content was prepended above.
    useLayoutEffect(() => {
        const el = scrollRef.current;
        const anchor = anchorHeightRef.current;
        if (el && anchor !== null) {
            el.scrollTop += el.scrollHeight - anchor;
        }
        anchorHeightRef.current = null;
    }, [renderLimit, messages]);

    // Follow the newest content while parked at the bottom.
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
                    {showTopSentinel && (
                        <div ref={sentinelRef} className="flex justify-center py-2 select-none">
                            <span className="text-xs opacity-40">
                                {loadingOlder ? "Loading earlier messages…" : "Scroll to load earlier messages"}
                            </span>
                        </div>
                    )}
                    {rendered.length === 0 && (
                        <div className="flex items-center justify-center h-full min-h-40 text-sm opacity-40 select-none">
                            {disabled ? "Waiting for OpenCode…" : "Send a message to start"}
                        </div>
                    )}
                    {rendered.map((m) => (
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
                    onSend={(text) => void send(text)}
                    onInterrupt={() => void interrupt()}
                />
            </div>
        </div>
    );
});

export default ChatView;
