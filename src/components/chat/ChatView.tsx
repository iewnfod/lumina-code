import {Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {AnimatePresence, motion} from "framer-motion";
import {fadeIn} from "../../lib/motion.ts";
import {useSurfaceColors} from "../../hooks/surfaceColors.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {OpencodeEventHandler} from "../../opencode/useOpencode.ts";
import {isAssistantMessage} from "../../opencode/types.ts";
import type {
    ChatAssistantMessage,
    ChatMessage,
    ComposerAttachment,
    ComposerFileRef,
    FormAnswer,
    FormRequest,
    OpencodeAgent,
    OpencodeModel,
    PermissionDecision,
    PermissionRequest,
    SessionModelRef,
} from "../../opencode/types.ts";
import {useSessionMessages} from "../../opencode/useSessionMessages.ts";
import type {SessionUsage} from "../../opencode/types.ts";
import {lastContextMessage, type ContextUsage} from "./usageStats.ts";
import MessageItem, {ActivityGroup, effectiveTailPart, type ActivityEntry, type ActivityPart} from "./MessageItem.tsx";
import RunFooter from "./RunFooter.tsx";
import {collectRunFooters} from "./runFooters.ts";
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
    usage,
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
    /** The session's cumulative usage — tooltip reference lines for the
     *  composer's context ring (which itself reads the transcript's last
     *  measured step; null on the welcome screen). */
    usage: SessionUsage | null;
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
    // Timestamp until which scroll events are treated as our own follow
    // animation rather than user intent (see the follow effect below).
    const programmaticUntilRef = useRef(0);
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

    // The ring's reading: the last assistant step that reported usage
    // (official-client semantics — see lastContextMessage). Double memo so
    // the packet's identity only changes when the owning message does:
    // ChatView re-renders per streaming frame, and a fresh object here
    // would drag the memoized composer (Lexical subtree) along 60×/s.
    const usageMessage = useMemo(() => lastContextMessage(messages), [messages]);
    const contextUsage = useMemo<ContextUsage | null>(
        () => (usageMessage?.tokens ? {tokens: usageMessage.tokens, model: usageMessage.model} : null),
        [usageMessage],
    );
    const hiddenCount = Math.max(0, visible.length - renderLimit);
    const rendered = hiddenCount > 0 ? visible.slice(-renderLimit) : visible;
    const showTopSentinel = hiddenCount > 0 || hasMore;

    // An assistant message still lacks its completion stamp while the
    // session is working — that's the streaming state (caret / thinking).
    const isStreaming = (m: ChatMessage) => busy && isAssistantMessage(m) && !m.time?.completed;

    // Stable identities for the composer's callbacks. ChatView re-renders
    // on every streaming frame; without these the memoized ChatInput would
    // re-render (and re-run its whole editor + catalog-grouping subtree)
    // 60×/s while tokens stream. send/interrupt are already stable
    // (useCallback with empty deps in useSessionMessages).
    const handleSend = useCallback(
        (
            text: string,
            files: ComposerAttachment[],
            fileRefs: ComposerFileRef[],
            command: {name: string; arguments: string} | null,
        ) => void send(text, files, fileRefs, command),
        [send],
    );
    const handleInterrupt = useCallback(() => void interrupt(), [interrupt]);

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
    // (a new message while idle) glide smoothly; large ones (a session
    // switch, first render) jump instantly so the view doesn't spend a
    // second sweeping past pages of content. Streaming deltas jump too:
    // frames land every ~16ms and each restarts the eased animation from
    // scratch — a burst of restarts reads as stutter, not motion.
    useEffect(() => {
        const el = scrollRef.current;
        if (el && atBottomRef.current) {
            const delta = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (delta > el.clientHeight || busy) {
                el.scrollTop = el.scrollHeight;
            } else {
                // The smooth animation emits intermediate scroll events that
                // are nowhere near the bottom yet — tell handleScroll to
                // ignore everything until it settles (or until this window
                // is refreshed by the next follow-scroll).
                programmaticUntilRef.current = performance.now() + 600;
                el.scrollTo({top: el.scrollHeight, behavior: "smooth"});
            }
        }
    }, [messages, busy]);

    // Re-pin on geometry changes that arrive AFTER the follow effect ran.
    // The composer column is a flex SIBLING of the scroller (its height
    // never enters scrollHeight, and scrollTop assignments clamp at
    // scrollHeight - clientHeight — so "aim lower" is a no-op). But when
    // the composer grows (context ring appearing, a permission card
    // replacing the input, the editable expanding), the flex-1 scroller
    // loses exactly that much height and a pin that was precise a moment
    // ago is suddenly short. Content can also grow late from inside
    // (images, code highlighting). ResizeObserver on both boxes re-fires
    // the pin while the reader is parked at the bottom; the clamp makes
    // it strictly additive — over-scroll is impossible, under-scroll
    // self-heals. Skipped during our own smooth glide so small deltas
    // keep gliding instead of snapping.
    useEffect(() => {
        const el = scrollRef.current;
        const content = el?.firstElementChild;
        if (!el || !content) return;
        const observer = new ResizeObserver(() => {
            if (!atBottomRef.current) return;
            if (performance.now() < programmaticUntilRef.current) return;
            el.scrollTop = el.scrollHeight;
        });
        observer.observe(el); // viewport side: composer/window resize
        observer.observe(content); // content side: late growth
        return () => observer.disconnect();
    }, []);

    const handleScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        // Mid-flight frames of our own follow-scroll aren't "the user left
        // the bottom" — without this guard, fast streaming content unpins
        // the view and the follow stops partway.
        if (performance.now() < programmaticUntilRef.current) return;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };

    // An explicit wheel gesture always wins: cancel the ignore window so
    // the very next scroll event re-evaluates stickiness.
    const handleWheel = () => {
        programmaticUntilRef.current = 0;
    };

    // While the tab/webview is hidden the browser pauses rendering:
    // smooth scrolls never run and streaming updates may stop arriving,
    // so no follow effect fires to catch up. On return, snap a pinned
    // view straight to the bottom, and shield the flag from the stale
    // scroll event the restore can synthesize.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState !== "visible") return;
            const el = scrollRef.current;
            if (!el) return;
            programmaticUntilRef.current = performance.now() + 300;
            if (atBottomRef.current) el.scrollTop = el.scrollHeight;
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, []);

    return (
        <div className="flex flex-col h-full w-full min-w-0">
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                onWheel={handleWheel}
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
                style={{
                    // Edge fade: content dissolves into the chrome instead of
                    // being hard-clipped at the top of the content area and
                    // just above the composer. A CSS mask fades whichever
                    // pixels are there — no color to match, so it reads
                    // correctly over the glass surface in dark mode too.
                    // Eased stops: the alpha drops off quickly near the very
                    // edge instead of lingering half-visible across the
                    // whole band, so text feels fully faded before it exits.
                    WebkitMaskImage:
                        "linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.65) 19px, black 51px, black calc(100% - 51px), rgba(0,0,0,0.65) calc(100% - 19px), transparent 100%)",
                    maskImage:
                        "linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.65) 19px, black 51px, black calc(100% - 51px), rgba(0,0,0,0.65) calc(100% - 19px), transparent 100%)",
                }}
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
                    {(() => {
                        const blocks = blockify(rendered);
                        // End-of-run footers (copy + duration) hang under
                        // the block whose last message finished a turn.
                        const footers = collectRunFooters(rendered, busy);
                        return blocks.map((block) => {
                            // Every block rides in a Fragment so a footer
                            // can appear below it later (run completes)
                            // without remounting the block itself.
                            let element: ReactNode;
                            // The message that would end a run at this
                            // block, if any.
                            let runEndId: string | null = null;
                            if (block.kind === "message") {
                                element = (
                                    <MessageItem
                                        message={block.message}
                                        colors={colors}
                                        streaming={isStreaming(block.message)}
                                        directory={directory}
                                    />
                                );
                                if (isAssistantMessage(block.message)) runEndId = block.message.id;
                            } else {
                                const entries: ActivityEntry[] = [];
                                for (const m of block.messages) {
                                    m.content.forEach((part, i) => {
                                        if (part.type !== "text") {
                                            entries.push({part, key: `${m.id}:${i}`});
                                        }
                                    });
                                }
                                // Live while the streaming message's effective
                                // tail is a tool/thought inside this run.
                                const streamingMsg = block.messages.find(isStreaming);
                                const tail = streamingMsg ? effectiveTailPart(streamingMsg) : undefined;
                                const livePart: ActivityPart | null =
                                    tail != null && tail.type !== "text" ? tail : null;
                                // …and across step boundaries: the server opens a
                                // NEW assistant message per model step, so between
                                // one step's message completing and the next
                                // step's first part nothing here is streaming —
                                // but the run keeps growing at the transcript's
                                // tail. Stay open for that whole span instead of
                                // folding shut and popping back open per step.
                                const runLive = busy && block === blocks[blocks.length - 1];
                                element = (
                                    <ActivityGroup
                                        stateKey={block.messages[0].id}
                                        entries={entries}
                                        colors={colors}
                                        livePart={livePart}
                                        runLive={runLive}
                                        directory={directory}
                                    />
                                );
                                runEndId = block.messages[block.messages.length - 1].id;
                            }
                            const run = runEndId !== null ? footers.get(runEndId) : undefined;
                            // Key stays the block's FIRST message id — for a
                            // growing activity run the last id changes per
                            // step and would remount the whole block.
                            const key = block.kind === "message" ? block.message.id : block.messages[0].id;
                            return (
                                <Fragment key={key}>
                                    {element}
                                    {run && (
                                        <RunFooter text={run.text} durationMs={run.durationMs} colors={colors}/>
                                    )}
                                </Fragment>
                            );
                        });
                    })()}
                </div>
            </div>
            <div className="shrink-0 max-w-3xl mx-auto w-full px-6 pb-4 flex flex-col gap-2">
                {/* Pinned server requests — while any is pending, the
                    session's execution waits server-side, so they stay
                    in the composer's place, never scrolled away. */}
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
                {/* While any request is pending, the composer hides —
                    the answer flow is the request card itself, not a
                    free-typed prompt. */}
                {pendingForms.length === 0 && pendingPermissions.length === 0 && (
                    <ChatInput
                        colors={colors}
                        disabled={disabled}
                        busy={busy}
                        onSend={handleSend}
                        onInterrupt={handleInterrupt}
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
                        usage={usage}
                        contextUsage={contextUsage}
                    />
                )}
            </div>
        </div>
    );
});

export default ChatView;
