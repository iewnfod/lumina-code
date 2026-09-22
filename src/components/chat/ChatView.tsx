import {memo, useCallback, useEffect, useMemo, useRef, useState} from "react";
import {AnimatePresence, motion} from "framer-motion";
import {fadeIn} from "../../lib/motion.ts";
import {useSurfaceColors} from "../../hooks/surfaceColors.ts";
import {useTranscriptScroll} from "../../hooks/useTranscriptScroll.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {OpencodeEventHandler} from "../../opencode/useOpencode.ts";
import type {
    ComposerAttachment,
    ComposerFileRef,
    FormAnswer,
    FormRequest,
    OpencodeAgent,
    OpencodeModel,
    PendingCommand,
    PermissionDecision,
    PermissionRequest,
    SessionModelRef,
} from "../../opencode/types.ts";
import {useSessionMessages} from "../../opencode/useSessionMessages.ts";
import type {SessionUsage} from "../../opencode/types.ts";
import {lastContextMessage, type ContextUsage} from "./usageStats.ts";
import TranscriptList from "./TranscriptList.tsx";
import ChatInput from "../composer/ChatInput.tsx";
import {PermissionCard} from "./PermissionCard.tsx";
import {QuestionCard} from "./QuestionCard.tsx";

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
    agents,
    models,
    catalogOnly,
    agent,
    model,
    onAgentChange,
    onModelChange,
    directory,
    onDirectoryChange,
    onOpenModelConfig,
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
    /** No authenticated provider of the user's own — the model picker
     *  shows its "nothing configured" entry above the free catalog. */
    catalogOnly: boolean;
    agent: string;
    model: SessionModelRef | null;
    onAgentChange: (agent: string) => void;
    onModelChange: (model: SessionModelRef) => void;
    /** The session's working directory (null = server default). */
    directory: string | null;
    onDirectoryChange: (directory: string | null) => void;
    /** Opens the settings modal on its Model tab (model/provider config). */
    onOpenModelConfig: () => void;
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
    const t = useI18n();
    const colors = useSurfaceColors(backgroundColor);
    const {messages, hasMore, loadingOlder, loadOlder, send, interrupt} =
        useSessionMessages(api, subscribe, sessionId);

    const sentinelRef = useRef<HTMLDivElement>(null);
    const [renderLimit, setRenderLimit] = useState(RENDER_LIMIT);
    useEffect(() => {
        setRenderLimit(RENDER_LIMIT);
    }, [sessionId]);

    const {scrollRef, onScroll, onWheel, pinAnchor} = useTranscriptScroll({
        messages,
        busy,
        expansionToken: renderLimit,
    });

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
            command: PendingCommand | null,
        ) => void send(text, files, fileRefs, command),
        [send],
    );
    const handleInterrupt = useCallback(() => void interrupt(), [interrupt]);

    // Grow the render window / fetch an older page (both directions of
    // "earlier": in-memory tail first, then the server cursor).
    const loadEarlier = useCallback(() => {
        setRenderLimit((limit) => {
            if (limit >= visible.length) return limit;
            pinAnchor();
            return limit + RENDER_LIMIT;
        });
        // Running low on the in-memory window? Fetch the next older page.
        if (visible.length - RENDER_LIMIT <= RENDER_LIMIT && hasMore) {
            loadOlder();
        }
    }, [visible.length, hasMore, loadOlder, pinAnchor]);

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
    }, [loadEarlier, showTopSentinel, scrollRef]);

    return (
        <div className="flex flex-col h-full w-full min-w-0">
            <div
                ref={scrollRef}
                onScroll={onScroll}
                onWheel={onWheel}
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
                                    {loadingOlder ? t["Loading earlier messages..."] : t["Scroll to load earlier messages"]}
                                </span>
                            </motion.div>
                        )}
                    </AnimatePresence>
                    {rendered.length === 0 && (
                        <div className="flex items-center justify-center h-full min-h-40 text-sm opacity-40 select-none">
                            {disabled ? t["Waiting for OpenCode..."] : t["Send a message to start"]}
                        </div>
                    )}
                    <TranscriptList
                        messages={rendered}
                        colors={colors}
                        busy={busy}
                        directory={directory}
                    />
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
                        catalogOnly={catalogOnly}
                        directory={directory}
                        onDirectoryChange={onDirectoryChange}
                        onOpenModelConfig={onOpenModelConfig}
                        usage={usage}
                        contextUsage={contextUsage}
                    />
                )}
            </div>
        </div>
    );
});

export default ChatView;
