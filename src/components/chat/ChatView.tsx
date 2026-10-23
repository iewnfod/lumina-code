import {memo, useCallback, useEffect, useMemo, useRef, useState} from "react";
import {info as logInfo} from "@tauri-apps/plugin-log";
import {useTranscriptScroll} from "../../hooks/useTranscriptScroll.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {useCatalog} from "../../opencode/catalogContext.tsx";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {usePendingRequests, useSessionData, useSessionTranscript} from "../../opencode/sessionDataContext.tsx";
import {useSessionStopping} from "../../opencode/sessionStopping.ts";
import {
    dropQueuedRow,
    expediteQueuedRow,
    queuedRowToDraft,
    takeExpeditedBatch,
    useQueuedPrompts,
} from "../../opencode/promptQueue.ts";
import {divertAttachmentsForSend, modelAcceptsImages} from "../../opencode/visionAttachments.ts";
import type {
    ChatUserMessage,
    ComposerAttachment,
    ComposerFileRef,
    PendingCommand,
    SessionModelRef,
    SessionUsage,
} from "../../opencode/types.ts";
import {appendExpeditedBubble, dropOptimisticBubble, settleExpeditedBubble} from "../../opencode/useSessionMessages.ts";
import {filesFromMessage} from "../composer/composerAttachments.ts";
import {lastContextMessage, type ContextUsage} from "./usageStats.ts";
import TranscriptList from "./TranscriptList.tsx";
import {ExitList} from "../ui/ExitPresence.tsx";
import ExitPresence from "../ui/ExitPresence.tsx";
import ChatInput from "../composer/ChatInput.tsx";
import QueuedPromptList from "./QueuedPromptList.tsx";
import {useGateCards} from "./useGateCards.ts";
import {useEditLastMessage} from "./useEditLastMessage.ts";
import {PermissionCard} from "./PermissionCard.tsx";
import {groupPermissionRequests, groupReplyPlan} from "./permissionGroups.ts";
import {PlanApprovalCard} from "./PlanApprovalCard.tsx";
import {WorkReviewCard} from "./WorkReviewCard.tsx";
import {QuestionCard} from "./QuestionCard.tsx";

/**
 * The conversation view for the active session: a transcript column (user
 * bubbles + assistant documents, streaming live) over the prompt composer.
 *
 * Built for long sessions — the transcript DOM stays bounded:
 * - Only the newest RENDER_LIMIT messages mount; an IntersectionObserver on
 *   the top sentinel grows the window (and fetches older pages from the
 *   server via cursor) as the reader scrolls up. Scroll anchoring keeps the
 *   viewport steady while content is prepended above it. (Two broader
 *   virtualizations were tried and reverted: a hand-rolled virtual window
 *   whose spacer/anchor compensation fought the scroller, and
 *   content-visibility: auto whose estimate→real materialization shifted
 *   the viewport on this WebKitGTK — see useTranscriptScroll.)
 * - The message state lives here (not in App), so streaming re-renders are
 *   confined to this subtree; rows are memoized and only the message being
 *   appended to re-renders.
 * - Auto-scrolls to the newest content while the user is parked at the
 *   bottom; scrolling up pauses the follow behavior so history stays put.
 */

/** How many transcript entries mount initially / per expansion. */
const RENDER_LIMIT = 60;

const ChatView = memo(function ChatView({
    sessionId,
    busy,
    disabled,
    agent,
    model,
    onAgentChange,
    onModelChange,
    directory,
    onDirectoryChange,
    stagedBranch,
    onStagedBranchChange,
    onOpenModelConfig,
    usage,
    approveAgent,
}: {
    sessionId: string;
    busy: boolean;
    /** No connection. */
    disabled: boolean;
    agent: string;
    model: SessionModelRef | null;
    onAgentChange: (agent: string) => void;
    onModelChange: (model: SessionModelRef) => void;
    /** The session's working directory (null = server default). */
    directory: string | null;
    onDirectoryChange: (directory: string | null) => void;
    /** Staged branch binding — only meaningful before the first message
     *  (the picker is pre-session), threaded for the composer's picker. */
    stagedBranch: string | null;
    onStagedBranchChange: (branch: string | null) => void;
    /** Opens the settings modal on its Model tab (model/provider config). */
    onOpenModelConfig: () => void;
    /** The session's cumulative usage — tooltip reference lines for the
     *  composer's context ring (which itself reads the transcript's last
     *  measured step; null on the welcome screen). */
    usage: SessionUsage | null;
    /** Agent a plan approval switches this session into — build for dev
     *  sessions, lumina-daily for daily ones (useSessionFlow derives it
     *  from the session's mode; switching a daily session to build would
     *  strand it on the developer persona + full toolset). */
    approveAgent: string;
}) {
    const t = useI18n();
    const {api} = useConnection();
    const {models} = useCatalog();
    const {replyPermission, replyForm, cancelForm} = useSessionData();
    const {
        messages,
        hasMore,
        loadingOlder,
        loadOlder,
        send,
        editResend,
        interrupt,
        sendQueued,
        retryQueued,
        removeQueued,
        deliverQueuedRows,
        rewriteQueuedOrder,
    } = useSessionTranscript(sessionId);
    const {permissions: pendingPermissions, forms: pendingForms} = usePendingRequests(sessionId);
    // Identical asks (same action + resources) merge into ONE card: the
    // server fires one permission assert per tool invocation with no
    // cross-call dedup, so parallel reads of the same external directory
    // stack 2+ indistinguishable asks. Memoized on the store array — the
    // group list keeps its identity across streaming frames so the
    // memoized cards skip re-renders.
    const permissionGroups = useMemo(
        () => groupPermissionRequests(pendingPermissions),
        [pendingPermissions],
    );
    // Stop pressed, run not yet unwound — the tail's indicator says
    // "Stopping" through the interrupt latency window (sessionStopping.ts).
    const stopping = useSessionStopping(sessionId);
    // Prompts composed while the session runs: they QUEUE instead of
    // steering the current turn (promptQueue.ts) and flush through the
    // normal send path once the run ends (the flush effect below).
    const queued = useQueuedPrompts(sessionId);
    const queuedItems = useMemo(() => [...queued], [queued]);

    const sentinelRef = useRef<HTMLDivElement>(null);
    const [renderLimit, setRenderLimit] = useState(RENDER_LIMIT);
    useEffect(() => {
        setRenderLimit(RENDER_LIMIT);
    }, [sessionId]);

    const {scrollRef, onScroll, onWheel, pinAnchor, snapToBottom} = useTranscriptScroll({
        messages,
        busy,
        expansionToken: renderLimit,
    });

    // The transcript renders user/assistant content plus the persisted
    // `model-switched` markers (blockify turns usable ones into the
    // mid-session model-change dividers; the rest are dropped there).
    const visible = messages.filter(
        (m) => m.type === "user" || m.type === "assistant" || m.type === "model-switched",
    );
    // The project picker stays available until the conversation starts —
    // i.e. until the first message lands (not just on the welcome screen);
    // a model-switch marker alone is not a conversation.
    const hasConversation = messages.some((m) => m.type === "user" || m.type === "assistant");

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
    // `deliver` is the ONE send path — the composer's live send, the
    // queue's flush and the rows' "send now" all route through it (vision
    // divert + optimistic bubble + command fallback included).
    const deliver = useCallback(
        (
            text: string,
            files: ComposerAttachment[],
            fileRefs: ComposerFileRef[],
            command: PendingCommand | null,
        ) => {
            // The reader may have scrolled up into history before sending —
            // their message (and the run it starts) must scroll into view.
            snapToBottom();
            // Text-only model + image attachments: divert them to disk and
            // append the vision-tool note instead of inlining (which the
            // provider would drop or reject). Falls back to inline on any
            // failure, so the message always goes out.
            void divertAttachmentsForSend({
                api,
                attachments: files,
                acceptsImages: modelAcceptsImages(models, model),
            }).then(({inline, note}) => {
                void send(note ? `${text}\n\n${note}` : text, inline, fileRefs, command);
            });
        },
        [send, api, models, model, snapToBottom],
    );
    /** Retry a FAILED prompt row (sendFailed): drop the row, re-deliver
     *  its text + attachments through the one send path. The divert note
     *  (text-only model) already rides the stored text — the re-divert
     *  pass finds no images left to divert (they are on disk) and never
     *  appends a second note; a slash-command row retries as a command
     *  (with the plain-prompt fallback send() already provides). */
    const handleRetrySend = useCallback(
        (message: ChatUserMessage) => {
            dropOptimisticBubble(sessionId, message.id);
            deliver(message.text, filesFromMessage(message), [], message.command ?? null);
        },
        [sessionId, deliver],
    );
    /** The queue's send path — `deliver`'s twin for the busy branch:
     *  same vision divert, then a server-native `queue` POST (the row
     *  parks in the persistent inbox instead of steering the run; every
     *  client of this server sees it — see promptQueue.ts). */
    const deliverQueued = useCallback(
        (
            text: string,
            files: ComposerAttachment[],
            fileRefs: ComposerFileRef[],
            command: PendingCommand | null,
        ) => {
            void divertAttachmentsForSend({
                api,
                attachments: files,
                acceptsImages: modelAcceptsImages(models, model),
            }).then(({inline, note}) => {
                void sendQueued(note ? `${text}\n\n${note}` : text, inline, fileRefs, command);
            });
        },
        [api, models, model, sendQueued],
    );
    const handleSend = useCallback(
        (
            text: string,
            files: ComposerAttachment[],
            fileRefs: ComposerFileRef[],
            command: PendingCommand | null,
        ) => {
            // Mid-run the prompt QUEUES instead of steering the current
            // turn — server-side (`delivery:"queue"`), so the row is
            // visible on every client and the server itself flushes it
            // when the run ends.
            if (busy) {
                deliverQueued(text, files, fileRefs, command);
                return;
            }
            deliver(text, files, fileRefs, command);
        },
        [busy, deliver, deliverQueued],
    );
    const handleInterrupt = useCallback(() => {
        // Stopping means STOP: the interrupt's inbox sweep cancels every
        // pending row server-side (queue rows included — same doctrine as
        // the old local clear, now enforced where the rows live); the
        // `cancelled` frames collapse the rows away with their exit
        // animation.
        void interrupt();
    }, [interrupt]);

    // --- "Stop and send" flush (the queue's regular flush is the
    //     SERVER's: the run's natural end drains its queue rows) ---
    // The expedited batch is the one client-driven delivery left: the
    // rows' content was snapshotted at expedite time (the sweep deletes
    // the server rows right after), and once the interrupted run settles
    // (busy turning false) the batch re-POSTs in order — expedited first
    // (click order), the rest in queue order. The guard ref keeps this to
    // ONE batch per idle window (the re-run while busy is still false
    // would otherwise re-enter on every row mutation); busy turning true
    // re-arms it, so does a session switch.
    const flushedIdleRef = useRef(false);
    useEffect(() => {
        flushedIdleRef.current = false;
    }, [sessionId]);
    useEffect(() => {
        if (busy) {
            flushedIdleRef.current = false;
            return;
        }
        if (flushedIdleRef.current) return;
        const batch = takeExpeditedBatch(sessionId);
        if (batch.length === 0) {
            // The batch evaporated (pruned empty — the row was naturally
            // drained before the stop, or the snapshot was never taken):
            // the ⚡ bubble must not linger beside the real message.
            settleExpeditedBubble(sessionId, "abandoned");
            return;
        }
        flushedIdleRef.current = true;
        logInfo(`Stop-and-send flush: ${batch.length} row(s) [${batch.map((r) => r.id).join(", ")}]`).catch(() => {});
        void deliverQueuedRows(batch);
    }, [busy, sessionId, deliverQueuedRows]);
    // "Stop and send" pulls one row out of the queue's waiting line:
    // idle it delivers immediately; mid-run it NEVER steers the running
    // turn (parked steers are what made interrupts unreliable — they
    // survive the stop server-side, see useSessionMessages' sweep).
    // Instead the row is expedited (content snapshotted — the sweep is
    // about to cancel the server rows) and the current run interrupted;
    // the flush effect above re-POSTs the batch once it settles.
    const handleSendQueuedNow = useCallback(
        (id: string) => {
            if (busy) {
                const row = queued.find((q) => q.id === id);
                const leading = expediteQueuedRow(sessionId, id);
                // INSTANT feel: the leading row's message flies into the
                // transcript the moment ⚡ is pressed (optimistic bubble —
                // the flush effect's immediate POST adopts it), and the
                // queue row leaves in the same breath (the sweep owns the
                // server-side cancel). Later ⚡ rows re-park as queue rows
                // in the fresh run instead.
                if (row && leading) {
                    appendExpeditedBubble(sessionId, row);
                    dropQueuedRow(sessionId, id);
                }
                void interrupt();
                return;
            }
            // Idle with a leftover row (a sweep that failed, or the app
            // died mid-queue): cancel it and deliver through the normal
            // path — `deliver` keeps the optimistic-bubble transcript
            // treatment, and the draft rebuild (note stripped, file://
            // refs kept) round-trips the attachments.
            const entry = queued.find((q) => q.id === id);
            if (!entry) return;
            const draft = queuedRowToDraft(entry);
            void removeQueued(id);
            deliver(draft.text, draft.files, [], entry.command);
        },
        [busy, queued, sessionId, interrupt, removeQueued, deliver],
    );
    // Edit: the row's text + attachments load back into the composer
    // (ChatInput's draftLoad prop) and the entry leaves the queue;
    // resubmitting re-enqueues while the session still runs. The draft
    // rebuilds from the row's wire content (divert note stripped, the
    // saved images re-referenced as file:// chips).
    const [queueEdit, setQueueEdit] = useState<{token: number; text: string; files: ComposerAttachment[]} | null>(null);
    useEffect(() => {
        setQueueEdit(null);
    }, [sessionId]);
    const handleEditQueued = useCallback(
        (id: string) => {
            const entry = queued.find((q) => q.id === id);
            if (!entry) return;
            void removeQueued(id);
            setQueueEdit({token: Date.now(), ...queuedRowToDraft(entry)});
        },
        [queued, removeQueued],
    );
    const handleDraftLoaded = useCallback(() => setQueueEdit(null), []);

    // The plan workflow's two gates (Route A) — derivation + decisions
    // + restart-orphan recovery, see useGateCards.ts.
    const {
        pendingPlan, pendingWork, waitingForUser, onPlanDecision, onWorkDecision,
    } = useGateCards({
        api,
        sessionId,
        directory,
        busy,
        agent,
        /** The agent a plan approval switches this session INTO (build
         *  for dev sessions, lumina-daily for daily ones) — computed by
         *  useSessionFlow from the ACTIVE session's mode. */
        approveAgent,
        messages,
        pendingPermissions,
        pendingForms,
        interrupt,
        snapToBottom,
    });

    // Edit-last-message wiring (the pencil on the last user bubble loads
    // it into the composer), see useEditLastMessage.ts.
    const {editProps, editMessage, onCancelEdit, onSubmitEdit} = useEditLastMessage({
        sessionId,
        disabled,
        busy,
        messages,
        editResend,
        snapToBottom,
    });

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
        <div
            className="flex flex-col h-full w-full min-w-0"
        >
            <div
                ref={scrollRef}
                onScroll={onScroll}
                onWheel={onWheel}
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden lum-fade-top lum-fade-bottom lum-fade-lg"
            >
                {/* Edge fade (main.css .lum-fade-top/-bottom .lum-fade-lg —
                 * the reference surface of the app's fade system): content
                 * dissolves into the chrome instead of being hard-clipped
                 * at the top of the content area and just above the
                 * composer. Static — both edges always faded. */}
                {/* The transcript column. (content-visibility: auto was
                    tried here and reverted: on this WebKitGTK the
                    estimate→real materialization of never-rendered rows
                    shifted the viewport while scrolling — see
                    useTranscriptScroll's re-pin note for the sibling
                    lesson.) */}
                {/* Bottom padding lifts the resting tail — the run footer's
                 * edit card — mostly out of the 51px lum-fade-lg band (the
                 * residual overlap sits in the band's near-solid tail), so it
                 * doesn't read as half-erased just above the composer. Top
                 * stays 24px: the top edge dissolving while scrolled up is the
                 * intended dissolve-into-chrome look. */}
                <div className="lum-column flex flex-col gap-3 pt-6 pb-8">
                    {showTopSentinel && (
                        <div
                            ref={sentinelRef}
                            className="flex justify-center py-2 select-none"
                        >
                            <span className="text-xs opacity-40">
                                {loadingOlder ? t["Loading earlier messages..."] : t["Scroll to load earlier messages"]}
                            </span>
                        </div>
                    )}
                    {rendered.length === 0 && (
                        <div className="flex items-center justify-center h-full min-h-40 text-sm opacity-40 select-none">
                            {disabled ? t["Waiting for OpenCode..."] : t["Send a message to start"]}
                        </div>
                    )}
                    <TranscriptList
                        messages={rendered}
                        busy={busy}
                        sessionId={sessionId}
                        directory={directory}
                        models={models}
                        waitingForUser={waitingForUser}
                        stopping={stopping}
                        edit={editProps}
                        onRetrySend={handleRetrySend}
                    />
                </div>
            </div>
            <div className="lum-column shrink-0 pb-4 flex flex-col gap-2">
                {/* Queued prompts — composed mid-run, delivered when the
                 * run ends (promptQueue.ts). Entrance/exit is the
                 * bespoke queued pair (main.css): the wrapper's grid
                 * track grows in sync with the row's rise (the content
                 * above is pushed up smoothly while the row floats out
                 * of the composer), and the exit is a pure fade. The
                 * composer below stays live for the next queued
                 * prompt. */}
                <QueuedPromptList
                    sessionId={sessionId}
                    queued={queuedItems}
                    editLocked={editMessage !== null}
                    onSendNow={handleSendQueuedNow}
                    onEdit={handleEditQueued}
                    onRemove={(id) => void removeQueued(id)}
                    onRetry={(id) => void retryQueued(id)}
                    onRewriteOrder={(draggedId, overId) => void rewriteQueuedOrder(draggedId, overId)}
                />
                {/* The plan workflow's approval card — pinned here while
                 * the plan_submit executor blocks on the user's decision
                 * (a still-running part in the transcript; see
                 * planApprovalPending). Collapses away in place once the
                 * part settles. The !busy variant is a RESTART ORPHAN:
                 * the executor is gone, the card offers recovery (see
                 * handlePlanDecision). */}
                <ExitPresence present={pendingPlan !== null} exitMs={250} exit={{animation: "lum-row-exit"}}>
                    {(closing, bind) =>
                        (pendingPlan || closing) && (
                            <PlanApprovalCard
                                payload={pendingPlan}
                                interrupted={!busy}
                                onApprove={() => onPlanDecision(true)}
                                onReject={() => onPlanDecision(false)}
                                {...bind}
                            />
                        )
                    }
                </ExitPresence>
                {/* The work-acceptance card — the workflow's second gate,
                 * pinned here while the work_submit executor blocks on
                 * the user's verdict over the TESTED work (a still-running
                 * part; see workApprovalPending). Collapses away in place
                 * once the part settles; the !busy variant is a restart
                 * orphan (see handleWorkDecision). */}
                <ExitPresence present={pendingWork !== null} exitMs={250} exit={{animation: "lum-row-exit"}}>
                    {(closing, bind) =>
                        (pendingWork || closing) && (
                            <WorkReviewCard
                                payload={pendingWork}
                                interrupted={!busy}
                                onApprove={() => onWorkDecision(true)}
                                onReject={() => onWorkDecision(false)}
                                {...bind}
                            />
                        )
                    }
                </ExitPresence>
                {/* Pinned server requests — while any is pending, the
                 * session's execution waits server-side, so they float
                 * here above the composer, never scrolled away. The
                 * composer stays available beneath them: a prompt typed
                 * while an ask waits simply queues behind the blocked
                 * run. Identical permission asks render as ONE card
                 * (permissionGroups) whose decision replies to the whole
                 * group. Answered cards collapse away in place (the exit
                 * engine). */}
                <ExitList
                    items={permissionGroups}
                    keyOf={(group) => group.key}
                    exitMs={250}
                    exit={{animation: "lum-row-exit"}}
                >
                    {(group) => (
                        <PermissionCard
                            request={group.requests[0]}
                            onDecision={(_, decision) => {
                                // Answering resumes execution at the tail —
                                // follow it down from wherever the reader is.
                                snapToBottom();
                                for (const reply of groupReplyPlan(group.requests, decision)) {
                                    void replyPermission(reply.request, reply.decision);
                                }
                            }}
                        />
                    )}
                </ExitList>
                <ExitList
                    items={pendingForms}
                    keyOf={(form) => form.id}
                    exitMs={250}
                    exit={{animation: "lum-row-exit"}}
                >
                    {(form) => (
                        <QuestionCard
                            form={form}
                            onReply={(f, answer) => {
                                snapToBottom();
                                void replyForm(f, answer);
                            }}
                            onCancel={cancelForm}
                        />
                    )}
                </ExitList>
                {/* The composer stays mounted while requests pend (see
                 * the comment above): busy still swaps its send button
                 * for stop per the usual run flow. */}
                <ChatInput
                    disabled={disabled}
                    busy={busy}
                    draftKey={sessionId}
                    onSend={handleSend}
                    onInterrupt={handleInterrupt}
                    draftLoad={queueEdit}
                    onDraftLoaded={handleDraftLoaded}
                    agent={agent}
                    model={model}
                    onAgentChange={onAgentChange}
                    onModelChange={onModelChange}
                    conversationStarted={hasConversation}
                    directory={directory}
                    onDirectoryChange={onDirectoryChange}
                    stagedBranch={stagedBranch}
                    onStagedBranchChange={onStagedBranchChange}
                    onOpenModelConfig={onOpenModelConfig}
                    usage={usage}
                    contextUsage={contextUsage}
                    editMessage={editMessage}
                    onCancelEdit={onCancelEdit}
                    onSubmitEdit={onSubmitEdit}
                />
            </div>
        </div>
    );
});

export default ChatView;
