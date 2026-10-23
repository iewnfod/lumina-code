import {useCallback, useEffect, useMemo, useSyncExternalStore} from "react";
import {debug as logDebug, warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {FormRequest, PermissionRequest} from "../../opencode/types.ts";
import type {ChatMessage} from "../../opencode/chatMessages.ts";
import {
    planApprovalPending,
    workApprovalPending,
    type GateContext,
    type PlanSubmitPayload,
    type WorkSubmitPayload,
} from "../../opencode/planWorkflow.ts";
import {getGateDecisionsSnapshot, recordGateDecision, subscribeGateDecisions} from "../../opencode/gateDecisions.ts";

/** Wake prompts for restart-ORPHANED gates: the blocked executor died
 *  with the app, so its result never reached the model — the user's
 *  verdict must arrive as a message. English protocol text, like the
 *  plugin's own (visible as a user bubble; it IS the user's
 *  instruction). */
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

/**
 * The plan workflow's TWO GUI gates (Route A) — extracted from ChatView:
 * the derivations (planApprovalPending / workApprovalPending over the
 * transcript + the restart-recovery GateContext), the decision handlers
 * (approve = the agent switch / the review marker file the blocked
 * executor polls; reject = interrupt), the wake-prompt recovery for
 * RESTART ORPHANS (a still-running gate part on an idle session means
 * its executor died with the app — the verdict travels as a message),
 * and the zombie probe mirroring an already-delivered acceptance marker
 * into the local record. The cards themselves (PlanApprovalCard /
 * WorkReviewCard) render from this hook's returns.
 */
export function useGateCards({
    api,
    sessionId,
    directory,
    busy,
    agent,
    approveAgent = "build",
    messages,
    pendingPermissions,
    pendingForms,
    interrupt,
    snapToBottom,
}: {
    api: OpencodeApi | null;
    sessionId: string;
    directory: string | null;
    busy: boolean;
    agent: string;
    /** Agent the plan approval switches the session INTO — build for dev
     *  sessions, lumina-daily for daily ones (useSessionFlow derives it;
     *  the plugin executor's poll accepts ANY non-plan agent, so both
     *  open the gate). */
    approveAgent?: string;
    messages: readonly ChatMessage[];
    pendingPermissions: PermissionRequest[];
    pendingForms: FormRequest[];
    interrupt: () => void;
    snapToBottom: () => void;
}): {
    pendingPlan: PlanSubmitPayload | null;
    pendingWork: WorkSubmitPayload | null;
    waitingForUser: boolean;
    onPlanDecision: (approve: boolean) => void;
    onWorkDecision: (approve: boolean) => void;
} {
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
    const pendingWork = useMemo(
        () => workApprovalPending(messages as ChatMessage[], gateCtx),
        [messages, gateCtx],
    );
    // The tail's working dots stand down while a decision is pending —
    // a permission/question/plan-approval/work-acceptance card is the
    // session waiting on the USER, not work in progress.
    const waitingForUser =
        pendingPermissions.length > 0 || pendingForms.length > 0 || pendingPlan !== null || pendingWork !== null;

    /** The acceptance marker both work-approve paths write — the file the
     *  blocked executor polls (.lumina/review/{sessionID}.json — a fixed
     *  path both sides derive without knowing the task directory's
     *  collision suffix). A failed write keeps the card up (the executor
     *  is still blocked) — the user can simply click again. */
    const writeWorkMarker = useCallback(() => {
        if (!directory || !api) return;
        api.writeTextFile(
            `${directory.replace(/\/+$/, "")}/.lumina/review/${sessionId}.json`,
            JSON.stringify({approved: true, at: new Date().toISOString()}),
        ).catch((e) => {
            logWarn(`Failed to deliver the work-acceptance marker: ${e}`).catch(() => {});
        });
    }, [directory, api, sessionId]);

    // Plan approval: approve = switching the session to its execution
    // agent (build / lumina-daily by the session's mode — the agent
    // change IS what the executor's poll waits for); reject = interrupt,
    // which aborts the executor into a revision prompt. The plan DOCUMENT
    // is not written here: the plan_submit executor itself persists the
    // submission + (on approval) tasks.md into .lumina/tasks/.
    const onPlanDecision = useCallback(
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
                            await api?.switchAgent(sessionId, approveAgent);
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
            // if the reader had scrolled up through the plan text.
            snapToBottom();
            void api?.switchAgent(sessionId, approveAgent);
        },
        [pendingPlan, api, sessionId, approveAgent, interrupt, snapToBottom, busy],
    );

    // Work acceptance: approval is DELIVERED as the marker file (see
    // writeWorkMarker); rejection is the session interrupt, aborting the
    // executor into a revision prompt. RESTART ORPHANS (!busy): the
    // executor that would consume the marker (or react to the interrupt)
    // is gone — record the verdict locally, still write the marker (the
    // plugin's session-hook janitor archives on the next model call) and
    // wake the session so the workflow closes.
    const onWorkDecision = useCallback(
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
                writeWorkMarker();
                api?.sendPrompt(sessionId, WORK_WAKE_ACCEPT).catch((e) => {
                    logWarn(`Failed to wake the session after work acceptance: ${e}`).catch(() => {});
                });
                return;
            }
            if (!approve) {
                void interrupt();
                return;
            }
            snapToBottom();
            writeWorkMarker();
        },
        [pendingWork, api, sessionId, interrupt, snapToBottom, busy, writeWorkMarker],
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

    return {pendingPlan, pendingWork, waitingForUser, onPlanDecision, onWorkDecision};
}
