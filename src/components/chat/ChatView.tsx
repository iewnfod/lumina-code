import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import {AnimatePresence, motion} from "framer-motion";
import {fadeIn} from "../../lib/motion.ts";
import {useSurfaceColors} from "../../hooks/surfaceColors.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {OpencodeEventHandler} from "../../opencode/useOpencode.ts";
import {isAssistantMessage} from "../../opencode/types.ts";
import type {
    ChatAssistantMessage,
    ChatMessage,
    FormAnswer,
    FormRequest,
    OpencodeAgent,
    OpencodeModel,
    PermissionDecision,
    PermissionRequest,
    SessionModelRef,
} from "../../opencode/types.ts";
import {useSessionMessages} from "../../opencode/useSessionMessages.ts";
import MessageItem, {ActivityGroup, effectiveTailPart, type ActivityPart} from "./MessageItem.tsx";
import ChatInput from "./ChatInput.tsx";
import {PermissionCard, QuestionCard} from "./RequestCards.tsx";

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

/** Transcript display block: one message, or a run of consecutive
 *  activity-only assistant messages folded into a single disclosure. */
type TranscriptBlock =
    | {kind: "message"; message: ChatMessage}
    | {kind: "activity"; messages: ChatAssistantMessage[]};

/** An assistant message with no visible prose — pure tool/thought
 *  machinery, eligible for cross-message folding. */
function isActivityOnly(m: ChatMessage): m is ChatAssistantMessage {
    return isAssistantMessage(m) && !m.content.some(
        (p) => p.type === "text" && p.text.trim() !== "",
    );
}

/**
 * The server opens a NEW assistant message per model step, so a chain of
 * single-tool steps (edit → shell → grep → …) arrives as many consecutive
 * activity-only messages. Runs of 2+ fold into one ActivityGroup; a lone
 * one keeps MessageItem's rendering (its dedicated ToolCard / own grouping).
 */
function blockify(list: ChatMessage[]): TranscriptBlock[] {
    const blocks: TranscriptBlock[] = [];
    let run: ChatAssistantMessage[] = [];
    const flush = () => {
        if (run.length === 0) return;
        if (run.length === 1) blocks.push({kind: "message", message: run[0]});
        else blocks.push({kind: "activity", messages: run});
        run = [];
    };
    for (const m of list) {
        if (isActivityOnly(m)) run.push(m);
        else {
            flush();
            blocks.push({kind: "message", message: m});
        }
    }
    flush();
    return blocks;
}

const ChatView = memo(function ChatView({
    api,
    subscribe,
    sessionId,
    backgroundColor,
    busy,
    disabled,
    agents,
    models,
    agent,
    model,
    onAgentChange,
    onModelChange,
    directory,
    onDirectoryChange,
    pendingPermissions,
    pendingForms,
    onPermissionDecision,
    onFormReply,
    onFormCancel,
}: {
    api: OpencodeApi | null;
    subscribe: (handler: OpencodeEventHandler) => () => void;
    sessionId: string;
    backgroundColor: string;
    busy: boolean;
    /** No connection. */
    disabled: boolean;
    /** Composer catalog + effective selections (owned by App). */
    agents: OpencodeAgent[];
    models: OpencodeModel[];
    agent: string;
    model: SessionModelRef | null;
    onAgentChange: (agent: string) => void;
    onModelChange: (model: SessionModelRef) => void;
    /** The session's working directory (null = server default). */
    directory: string | null;
    onDirectoryChange: (directory: string | null) => void;
    /** Pending server requests for THIS session (permission asks +
     *  question forms) — pinned above the composer until answered. */
    pendingPermissions: PermissionRequest[];
    pendingForms: FormRequest[];
    onPermissionDecision: (request: PermissionRequest, decision: PermissionDecision) => void;
    onFormReply: (form: FormRequest, answer: FormAnswer) => void;
    onFormCancel: (form: FormRequest) => void;
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
    // The project picker stays available until the conversation starts —
    // i.e. until the first message lands (not just on the welcome screen).
    const hasConversation = visible.length > 0;
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

    // Follow the newest content while parked at the bottom. Small deltas
    // (streaming tokens, a new message) glide smoothly; large ones (a
    // session switch, first render) jump instantly so the view doesn't
    // spend a second sweeping past pages of content.
    useEffect(() => {
        const el = scrollRef.current;
        if (el && atBottomRef.current) {
            const delta = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (delta > el.clientHeight) {
                el.scrollTop = el.scrollHeight;
            } else {
                el.scrollTo({top: el.scrollHeight, behavior: "smooth"});
            }
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
                <div className="max-w-3xl mx-auto w-full flex flex-col gap-3 px-6 py-6">
                    <AnimatePresence>
                        {showTopSentinel && (
                            <motion.div
                                variants={fadeIn}
                                initial="hidden"
                                animate="show"
                                exit="exit"
                                ref={sentinelRef}
                                className="flex justify-center py-2 select-none"
                            >
                                <span className="text-xs opacity-40">
                                    {loadingOlder ? "Loading earlier messages…" : "Scroll to load earlier messages"}
                                </span>
                            </motion.div>
                        )}
                    </AnimatePresence>
                    {rendered.length === 0 && (
                        <div className="flex items-center justify-center h-full min-h-40 text-sm opacity-40 select-none">
                            {disabled ? "Waiting for OpenCode…" : "Send a message to start"}
                        </div>
                    )}
                    {blockify(rendered).map((block) => {
                        if (block.kind === "message") {
                            return (
                                <MessageItem
                                    key={block.message.id}
                                    message={block.message}
                                    colors={colors}
                                    streaming={isStreaming(block.message)}
                                />
                            );
                        }
                        const parts = block.messages.flatMap((m) =>
                            m.content.filter((p): p is ActivityPart => p.type !== "text"),
                        );
                        // Live while the streaming message's effective tail
                        // is a tool/thought inside this run.
                        const streamingMsg = block.messages.find(isStreaming);
                        const tail = streamingMsg ? effectiveTailPart(streamingMsg) : undefined;
                        const livePart: ActivityPart | null =
                            tail != null && tail.type !== "text" ? tail : null;
                        return (
                            <ActivityGroup
                                key={block.messages[0].id}
                                parts={parts}
                                colors={colors}
                                livePart={livePart}
                            />
                        );
                    })}
                </div>
            </div>
            <div className="shrink-0 max-w-3xl mx-auto w-full px-6 pb-4 flex flex-col gap-2">
                {/* Pinned server requests — while any is pending, the
                    session's execution waits server-side, so they stay
                    visible above the composer, never scrolled away. */}
                {pendingPermissions.map((request) => (
                    <PermissionCard
                        key={request.id}
                        request={request}
                        colors={colors}
                        onDecision={onPermissionDecision}
                    />
                ))}
                {pendingForms.map((form) => (
                    <QuestionCard
                        key={form.id}
                        form={form}
                        colors={colors}
                        onReply={onFormReply}
                        onCancel={onFormCancel}
                    />
                ))}
                {/* While a question is pending, the composer hides — the
                    answer flow is the question card itself, not a
                    free-typed prompt. */}
                {pendingForms.length === 0 && (
                    <ChatInput
                        colors={colors}
                        disabled={disabled}
                        busy={busy}
                        onSend={(text, files) => void send(text, files)}
                        onInterrupt={() => void interrupt()}
                        agents={agents}
                        models={models}
                        agent={agent}
                        model={model}
                        onAgentChange={onAgentChange}
                        onModelChange={onModelChange}
                        conversationStarted={hasConversation}
                        api={api}
                        directory={directory}
                        onDirectoryChange={onDirectoryChange}
                    />
                )}
            </div>
        </div>
    );
});

export default ChatView;
