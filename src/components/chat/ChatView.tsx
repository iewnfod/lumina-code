import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import {createPortal} from "react-dom";
import {warn as logWarn} from "@tauri-apps/plugin-log";
import {debug as logDebug} from "@tauri-apps/plugin-log";
import {GripVertical} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useTranscriptScroll} from "../../hooks/useTranscriptScroll.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {useCatalog} from "../../opencode/catalogContext.tsx";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {usePendingRequests, useSessionData, useSessionTranscript} from "../../opencode/sessionDataContext.tsx";
import {useSessionStopping} from "../../opencode/sessionStopping.ts";
import {
    clearSessionQueue,
    enqueuePrompt,
    moveQueuedPrompt,
    removeQueuedPrompt,
    takeQueuedPrompt,
    useQueuedPrompts,
} from "../../opencode/promptQueue.ts";
import {type GateContext, planApprovalPending, workApprovalPending} from "../../opencode/sessionActivity.ts";
import {
    getGateDecisionsSnapshot,
    recordGateDecision,
    subscribeGateDecisions,
} from "../../opencode/gateDecisions.ts";
import {divertAttachmentsForSend, modelAcceptsImages} from "../../opencode/visionAttachments.ts";
import type {
    ChatMessage,
    ChatUserMessage,
    ComposerAttachment,
    ComposerFileRef,
    PendingCommand,
    SessionModelRef,
    SessionUsage,
} from "../../opencode/types.ts";
import {isUserMessage} from "../../opencode/types.ts";
import {lastContextMessage, type ContextUsage} from "./usageStats.ts";
import TranscriptList from "./TranscriptList.tsx";
import {ExitList} from "../ui/ExitPresence.tsx";
import ExitPresence from "../ui/ExitPresence.tsx";
import ChatInput from "../composer/ChatInput.tsx";
import QueuedPromptRow, {queuedRowDisplay} from "./QueuedPromptRow.tsx";
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

/** Wake prompts for restart-ORPHANED gates (see handlePlanDecision /
 * handleWorkDecision): the blocked executor died with the app, so its
 * result never reached the model — the user's verdict must arrive as a
 * message. English protocol text, like the plugin's own (visible as a
 * user bubble; it IS the user's instruction). */
const PLAN_WAKE_APPROVE = (todos: string[]) =>
    "(resume) This plan was APPROVED by the user — an app restart interrupted the approval wait, so the gate's result never reached you. " +
    "Treat the plan as approved and continue: execute the tasks strictly in order and report each via task_complete with its EXACT title. Task list:\n" +
    todos.map((t, i) => `${i + 1}. ${t}`).join("\n");
const PLAN_WAKE_REJECT =
    "(resume) This plan was REJECTED by the user (an app restart interrupted the approval wait). " +
    "Do not execute it. Revise the plan and call plan_submit again.";
const WORK_WAKE_ACCEPT =
    "(resume) The completion report was ACCEPTED by the user (an app restart interrupted the wait) — the plan is complete and archival happens host-side. " +
    "Acknowledge briefly and stop; no further work is needed.";
const WORK_WAKE_REJECT =
    "(resume) The completion report was REJECTED by the user (an app restart interrupted the wait). " +
    "Fix the issues they report, then call work_submit again with an updated report.";

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
    onOpenModelConfig,
    usage,
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
    /** Opens the settings modal on its Model tab (model/provider config). */
    onOpenModelConfig: () => void;
    /** The session's cumulative usage — tooltip reference lines for the
     *  composer's context ring (which itself reads the transcript's last
     *  measured step; null on the welcome screen). */
    usage: SessionUsage | null;
}) {
    const t = useI18n();
    const colors = useColors();
    const {api} = useConnection();
    const {models} = useCatalog();
    const {replyPermission, replyForm, cancelForm} = useSessionData();
    const {messages, hasMore, loadingOlder, loadOlder, send, editResend, interrupt} =
        useSessionTranscript(sessionId);
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

    // --- Edit-last-message state ---
    // Which message's text the COMPOSER is editing (the pencil on the
    // last user bubble loads it there); cleared on submit success or
    // cancel (never on failure — the user's edit must not be lost).
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    useEffect(() => {
        setEditingMessageId(null);
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
    const handleSend = useCallback(
        (
            text: string,
            files: ComposerAttachment[],
            fileRefs: ComposerFileRef[],
            command: PendingCommand | null,
        ) => {
            // Mid-run the prompt QUEUES instead of steering the current
            // turn — it renders as a row above the composer and goes out
            // through `deliver` when the run ends (the flush effect).
            if (busy) {
                enqueuePrompt(sessionId, {text, files, fileRefs, command});
                return;
            }
            deliver(text, files, fileRefs, command);
        },
        [busy, sessionId, deliver],
    );
    const handleInterrupt = useCallback(() => {
        // Stopping means STOP: the queue clears too, so the aborted work
        // is not immediately restarted by the next queued prompt (the
        // rows collapse away with their exit animation).
        clearSessionQueue(sessionId);
        void interrupt();
    }, [sessionId, interrupt]);

    // --- Queued-prompt flush + row actions ---
    // Exactly ONE queued prompt delivers per idle window (the guard ref):
    // after `deliver` the queue shrinks, which re-runs this effect while
    // `busy` is still false (execution.started arrives a beat later) —
    // without the guard the whole queue would flush at once instead of
    // one-prompt-per-run. busy turning true re-arms the guard; so does a
    // session switch (the ref outlives it otherwise).
    const flushedIdleRef = useRef(false);
    useEffect(() => {
        flushedIdleRef.current = false;
    }, [sessionId]);
    useEffect(() => {
        if (busy) {
            flushedIdleRef.current = false;
            return;
        }
        if (flushedIdleRef.current || queued.length === 0) return;
        const head = takeQueuedPrompt(sessionId);
        if (!head) return;
        flushedIdleRef.current = true;
        deliver(head.text, head.files, head.fileRefs, head.command);
    }, [busy, queued, sessionId, deliver]);
    // "Send now" pulls one row out of the queue and delivers it
    // immediately — the server accepts prompts mid-run (they join the
    // running turn), so this is a deliberate steer, not a queue jump.
    const handleSendQueuedNow = useCallback(
        (id: string) => {
            const entry = queued.find((q) => q.id === id);
            if (!entry) return;
            removeQueuedPrompt(sessionId, id);
            deliver(entry.text, entry.files, entry.fileRefs, entry.command);
        },
        [queued, sessionId, deliver],
    );
    // Edit: the row's text + attachments load back into the composer
    // (ChatInput's draftLoad prop) and the entry leaves the queue;
    // resubmitting re-enqueues while the session still runs.
    const [queueEdit, setQueueEdit] = useState<{token: number; text: string; files: ComposerAttachment[]} | null>(null);
    useEffect(() => {
        setQueueEdit(null);
        setQueueDrag(null);
    }, [sessionId]);
    const handleEditQueued = useCallback(
        (id: string) => {
            const entry = queued.find((q) => q.id === id);
            if (!entry) return;
            removeQueuedPrompt(sessionId, id);
            setQueueEdit({token: Date.now(), text: entry.text, files: entry.files});
        },
        [queued, sessionId],
    );
    const handleDraftLoaded = useCallback(() => setQueueEdit(null), []);

    // --- Queue-row reorder (pointer drag; HTML5 DnD proved unreliable
    // in the WebKitGTK webview) ---
    // The grip's pointerdown opens the session; window-level listeners
    // resolve the row under the pointer via elementFromPoint (each row
    // root carries data-queued-id) and pointerup commits the move.
    // Esc / pointercancel / releasing outside the rows cancels.
    const [queueDrag, setQueueDrag] = useState<{draggedId: string; overId: string | null} | null>(null);
    const queueDragRef = useRef(queueDrag);
    queueDragRef.current = queueDrag;
    const queueDragActive = queueDrag !== null;
    // The GHOST follows the pointer imperatively (transform writes in
    // the move handler — no per-move re-render): grab offset + width
    // are captured from the row's rect at drag start, lastPointer
    // carries the position into the ghost's mount effect.
    const ghostRef = useRef<HTMLDivElement | null>(null);
    const ghostGeomRef = useRef<{grabX: number; grabY: number; width: number} | null>(null);
    const lastPointerRef = useRef<{x: number; y: number} | null>(null);
    useEffect(() => {
        if (!queueDragActive) return;
        const rowAt = (x: number, y: number): string | null => {
            const el = document.elementFromPoint(x, y)?.closest("[data-queued-id]");
            return el instanceof HTMLElement ? (el.dataset.queuedId ?? null) : null;
        };
        const onMove = (e: PointerEvent) => {
            lastPointerRef.current = {x: e.clientX, y: e.clientY};
            const g = ghostRef.current;
            const geom = ghostGeomRef.current;
            if (g && geom) {
                g.style.transform = `translate(${e.clientX - geom.grabX}px, ${e.clientY - geom.grabY}px)`;
            }
            const overId = rowAt(e.clientX, e.clientY);
            setQueueDrag((d) => (d ? (d.overId === overId ? d : {...d, overId}) : d));
        };
        const onFinish = (e: PointerEvent) => {
            const d = queueDragRef.current;
            setQueueDrag(null);
            if (!d) return;
            const overId = rowAt(e.clientX, e.clientY);
            // Drop = insert BEFORE the target row (the pinned stack
            // grows upward; both directions work).
            if (overId && overId !== d.draggedId) moveQueuedPrompt(sessionId, d.draggedId, overId);
        };
        const onCancel = () => setQueueDrag(null);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setQueueDrag(null);
        };
        document.body.style.cursor = "grabbing";
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onFinish);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("keydown", onKey);
        return () => {
            document.body.style.cursor = "";
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onFinish);
            window.removeEventListener("pointercancel", onCancel);
            window.removeEventListener("keydown", onKey);
        };
    }, [queueDragActive, sessionId]);
    // Place the ghost under the pointer BEFORE its first paint.
    useLayoutEffect(() => {
        const g = ghostRef.current;
        const geom = ghostGeomRef.current;
        const pt = lastPointerRef.current;
        if (!queueDragActive || !g || !geom || !pt) return;
        g.style.transform = `translate(${pt.x - geom.grabX}px, ${pt.y - geom.grabY}px)`;
    }, [queueDragActive]);
    const startQueueDrag = useCallback((e: React.PointerEvent, id: string) => {
        if (e.button !== 0) return;
        // No text selection / focus steal from the composer.
        e.preventDefault();
        const row = (e.currentTarget as HTMLElement).closest("[data-queued-id]");
        const rect = row instanceof HTMLElement ? row.getBoundingClientRect() : null;
        ghostGeomRef.current = rect
            ? {grabX: e.clientX - rect.left, grabY: e.clientY - rect.top, width: rect.width}
            : {grabX: 0, grabY: 0, width: 0};
        lastPointerRef.current = {x: e.clientX, y: e.clientY};
        setQueueDrag({draggedId: id, overId: null});
    }, []);

    // --- Edit-last-message wiring ---
    // Only the session's LAST user message is editable (and it needs a
    // connection). The pencil is hover-revealed like copy even while
    // the session runs — hiding it made the feature undiscoverable —
    // but it is DISABLED mid-run (a revert needs an idle session, the
    // server enforces it with 409). A slash-command submission is not
    // editable: the stored text is the EXPANDED template, not what the
    // user typed. An optimistic local bubble can't be it either (it
    // only exists mid-send).
    const lastEditableId = useMemo(() => {
        if (disabled) return null;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!isUserMessage(m)) continue;
            return m.command || m.id.startsWith("local-") ? null : m.id;
        }
        return null;
    }, [messages, disabled]);
    const handleStartEdit = useCallback((message: ChatUserMessage) => {
        setEditingMessageId(message.id);
    }, []);
    const handleCancelEdit = useCallback(() => {
        setEditingMessageId(null);
    }, []);
    const handleSubmitEdit = useCallback(
        async (message: ChatUserMessage, text: string, files: ComposerAttachment[]): Promise<boolean> => {
            const ok = await editResend(message, text, files);
            if (ok) {
                setEditingMessageId(null);
                // The resent message (and its rerun) lands at the tail —
                // follow it like a fresh send.
                snapToBottom();
            }
            return ok;
        },
        [editResend, snapToBottom],
    );
    // The message whose text the COMPOSER is editing (null = normal send
    // mode). Identity-stable across streaming frames — clone-on-write
    // keeps untouched message objects referentially equal, so ChatInput's
    // memo holds and its edit-mode effect only fires on real transitions.
    const editMessage = useMemo(
        () =>
            editingMessageId == null
                ? null
                : (messages.find((m) => m.id === editingMessageId && isUserMessage(m)) as ChatUserMessage | undefined) ??
                  null,
        [messages, editingMessageId],
    );
    // One identity-stable bundle per (flags, handlers) change so the
    // memoized transcript rows skip re-renders across streaming frames.
    const editProps = useMemo(
        () => ({
            editableMessageId: lastEditableId,
            editingMessageId,
            // Mid-run the pencil renders DISABLED (revert needs idle).
            editDisabled: busy,
            onStartEdit: handleStartEdit,
        }),
        [lastEditableId, editingMessageId, busy, handleStartEdit],
    );

    // Plan-workflow approval (Route A): the plan_submit executor BLOCKS
    // inside its tool call, so a still-running part IS the pending
    // decision — the card renders from that derivation, not from the
    // permission-request pipeline (v2.0.11 has no permission gate for
    // plugin tools). Approving = switching the session to build — the
    // agent change IS what the executor's poll waits for — plus a
    // best-effort save of the plan document (the transcript keeps the
    // content whatever happens). Rejecting = interrupting the session,
    // which aborts the executor → it returns a revision prompt.
    //
    // RESTART ORPHANS: the server persists a tool part as "running" at
    // call start and never settles it when the app dies mid-gate — after
    // a restart the part is still running but its executor is GONE (no
    // busy run), so the switch/interrupt the live path relies on finds
    // nobody listening and the card would sit forever. The folds below
    // take the agent + any LOCALLY RECORDED verdicts (gateDecisions.ts)
    // so a decided orphan collapses; an undecided one renders the card
    // in recovery mode (the !busy interrupted variant) whose decisions
    // DELIVER the verdict as a wake prompt — the session resumes.
    const gateDecisions = useSyncExternalStore(subscribeGateDecisions, getGateDecisionsSnapshot);
    const gateCtx = useMemo<GateContext>(
        () => ({
            agent,
            decided: new Map(Object.entries(gateDecisions[sessionId] ?? {})),
        }),
        [agent, gateDecisions, sessionId],
    );
    const pendingPlan = useMemo(
        () => planApprovalPending(messages as ChatMessage[], gateCtx),
        [messages, gateCtx],
    );
    // The work-acceptance gate (Route A twin): the work_submit executor
    // blocks inside its call awaiting the user's VERDICT on the tested
    // work — a still-running part in the transcript is the pending card.
    const pendingWork = useMemo(
        () => workApprovalPending(messages as ChatMessage[], gateCtx),
        [messages, gateCtx],
    );
    // The tail's working dots stand down while a decision is pending —
    // a permission/question/plan-approval/work-acceptance card is the
    // session waiting on the USER, not work in progress.
    const waitingForUser =
        pendingPermissions.length > 0 || pendingForms.length > 0 || pendingPlan !== null || pendingWork !== null;
    const handlePlanDecision = useCallback(
        (approve: boolean) => {
            if (!pendingPlan) return;
            if (!busy) {
                // Restart orphan: the blocked executor is gone — the
                // verdict travels as a WAKE PROMPT (the model never saw
                // the gate's result) and lands in the local record so
                // the card collapses; the frozen part itself is
                // unreadable forever, the folds interpret it.
                if (approve) {
                    snapToBottom();
                    void (async () => {
                        try {
                            await api?.switchAgent(sessionId, "build");
                        } catch (e) {
                            logWarn(`Failed to switch agent for plan recovery: ${e}`).catch(() => {});
                        }
                        try {
                            await api?.sendPrompt(sessionId, PLAN_WAKE_APPROVE(pendingPlan.todos));
                        } catch (e) {
                            logWarn(`Failed to wake the session after plan approval: ${e}`).catch(() => {});
                        }
                    })();
                } else {
                    recordGateDecision(sessionId, pendingPlan.partId, "rejected");
                    snapToBottom();
                    api?.sendPrompt(sessionId, PLAN_WAKE_REJECT).catch((e) => {
                        logWarn(`Failed to wake the session after plan rejection: ${e}`).catch(() => {});
                    });
                }
                return;
            }
            if (!approve) {
                void interrupt();
                return;
            }
            // Approving resumes execution at the tail — follow it down even
            // if the reader had scrolled up through the plan text. The plan
            // DOCUMENT is not written here anymore: the plan_submit
            // executor itself persists the submission + (on approval)
            // tasks.md into .lumina/tasks/ — see src/plugins/luminaTools.js.
            snapToBottom();
            void api?.switchAgent(sessionId, "build");
        },
        [pendingPlan, api, sessionId, interrupt, snapToBottom, busy],
    );

    // The acceptance gate's decision: approval is DELIVERED as the marker
    // file the blocked executor polls (.lumina/review/{sessionID}.json —
    // a fixed path both sides derive without knowing the task directory's
    // collision suffix; the executor pre-creates the folder and cleans
    // stale markers). A failed write keeps the card up (the executor is
    // still blocked) — the user can simply click again. Rejection is the
    // session interrupt, aborting the executor into a revision prompt.
    // RESTART ORPHANS (!busy): the executor that would consume the
    // marker (or react to the interrupt) is gone — record the verdict
    // locally, still write the marker (the plugin's session-hook janitor
    // archives on the next model call) and wake the session so the
    // workflow closes.
    const handleWorkDecision = useCallback(
        (approve: boolean) => {
            if (!pendingWork) return;
            if (!busy) {
                recordGateDecision(sessionId, pendingWork.partId, approve ? "accepted" : "rejected");
                snapToBottom();
                if (!approve) {
                    api?.sendPrompt(sessionId, WORK_WAKE_REJECT).catch((e) => {
                        logWarn(`Failed to wake the session after work rejection: ${e}`).catch(() => {});
                    });
                    return;
                }
                if (!directory || !api) return;
                api.writeTextFile(
                    `${directory.replace(/\/+$/, "")}/.lumina/review/${sessionId}.json`,
                    JSON.stringify({approved: true, at: new Date().toISOString()}),
                ).catch((e) => {
                    logWarn(`Failed to deliver the work-acceptance marker: ${e}`).catch(() => {});
                });
                api.sendPrompt(sessionId, WORK_WAKE_ACCEPT).catch((e) => {
                    logWarn(`Failed to wake the session after work acceptance: ${e}`).catch(() => {});
                });
                return;
            }
            if (!approve) {
                void interrupt();
                return;
            }
            if (!directory || !api) return;
            snapToBottom();
            api.writeTextFile(
                `${directory.replace(/\/+$/, "")}/.lumina/review/${sessionId}.json`,
                JSON.stringify({approved: true, at: new Date().toISOString()}),
            ).catch((e) => {
                logWarn(`Failed to deliver the work-acceptance marker: ${e}`).catch(() => {});
            });
        },
        [pendingWork, directory, api, sessionId, interrupt, snapToBottom, busy],
    );

    // Work-gate ZOMBIE probe: a work_submit frozen running whose
    // acceptance marker is ALREADY on disk (delivered by an earlier
    // run's decision — the executor that would have consumed it died
    // with the app; the local record usually covers this, but it is a
    // separate medium that can lag) must not re-render as a pending
    // card. The marker is the acceptance protocol's durable truth
    // (verified live: the nested relative path reads fine through
    // api.readTextFile), so probe it once per orphaned gate and mirror
    // an existing marker into the record. Read failures are treated as
    // absence — on this server generation a MISSING directory 500s
    // instead of 404ing, so "absent" is the normal outcome (a false
    // absence merely keeps the recovery card up; the user decides
    // again).
    useEffect(() => {
        if (!pendingWork || busy || !directory || !api) return;
        if (gateCtx.decided?.has(pendingWork.partId)) return;
        let cancelled = false;
        api.readTextFile(directory.replace(/\/+$/, ""), `.lumina/review/${sessionId}.json`)
            .then((raw) => {
                if (!cancelled && raw !== null) {
                    recordGateDecision(sessionId, pendingWork.partId, "accepted");
                }
            })
            .catch((e) => {
                logDebug(`Work-acceptance marker probe treated as absent: ${e}`).catch(() => {});
            });
        return () => {
            cancelled = true;
        };
    }, [pendingWork, busy, directory, api, sessionId, gateCtx]);

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
                <ExitList
                    items={queuedItems}
                    keyOf={(q) => q.id}
                    enter
                    enterClassName="lum-queue-enter"
                    exitMs={250}
                    exit={{animation: "lum-queue-exit"}}
                    exitClassName="lum-queue-exit"
                >
                    {(q, _closing, _bind, entering) => (
                        <QueuedPromptRow
                            entry={q}
                            entering={entering}
                            dragging={queueDrag?.draggedId === q.id}
                            dropTarget={queueDrag !== null && queueDrag.draggedId !== q.id && queueDrag.overId === q.id}
                            onSendNow={handleSendQueuedNow}
                            onEdit={handleEditQueued}
                            onRemove={(id) => removeQueuedPrompt(sessionId, id)}
                            onGripPointerDown={(e) => startQueueDrag(e, q.id)}
                            editLocked={editMessage !== null}
                        />
                    )}
                </ExitList>
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
                                onApprove={() => handlePlanDecision(true)}
                                onReject={() => handlePlanDecision(false)}
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
                                onApprove={() => handleWorkDecision(true)}
                                onReject={() => handleWorkDecision(false)}
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
                    onOpenModelConfig={onOpenModelConfig}
                    usage={usage}
                    contextUsage={contextUsage}
                    editMessage={editMessage}
                    onCancelEdit={handleCancelEdit}
                    onSubmitEdit={handleSubmitEdit}
                />
            </div>
            {/* The reorder DRAG GHOST: a fixed-position lifted copy of the
             * dragged row following the pointer (imperative transform —
             * see the drag session above). Portaled to document.body:
             * `fixed` inside the tree would be caught by an ancestor's
             * containment (the conversation row's container-type: size
             * makes it the containing block) and offset from the cursor.
             * pointer-events:none is LOAD-BEARING: it keeps the ghost out
             * of elementFromPoint so the drop target resolves to the row
             * BENEATH it. */}
            {queueDrag && (ghostGeomRef.current?.width ?? 0) > 0 &&
                createPortal(
                    <div
                        ref={ghostRef}
                        className="fixed left-0 top-0 z-50 pointer-events-none"
                        style={{width: ghostGeomRef.current?.width}}
                    >
                        <div
                            className="flex items-center gap-2 rounded-[var(--radius-lg)] px-3 py-2 select-none"
                            style={{
                                background: colors.recessedBg,
                                border: `1px solid ${colors.glassBorder}`,
                                boxShadow: colors.elevationShadow,
                                transform: "scale(1.02)",
                            }}
                        >
                            <GripVertical size={14} className="shrink-0" style={{color: colors.inactiveText}}/>
                            <span className="flex-1 min-w-0 truncate text-xs" style={{color: colors.textPrimary}}>
                                {queuedRowDisplay(
                                    queued.find((q) => q.id === queueDrag.draggedId) ?? {
                                        text: "",
                                        files: [],
                                        fileRefs: [],
                                        command: null,
                                        id: queueDrag.draggedId,
                                    },
                                )}
                            </span>
                        </div>
                    </div>,
                    document.body,
                )}
        </div>
    );
});

export default ChatView;
