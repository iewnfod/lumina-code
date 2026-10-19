import {memo} from "react";
import {ClipboardCheck} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import type {PlanSubmitPayload} from "../../opencode/sessionActivity.ts";
import {GateCard} from "./GateCard.tsx";

/**
 * The plan workflow's approval card (Route A): the plan_submit executor
 * BLOCKS inside its tool call awaiting the user's decision — ChatView
 * derives that pending state from the transcript (planApprovalPending)
 * and renders this card pinned above the composer. Approving switches
 * the session to build (the agent change is what the executor's poll
 * waits for — the model's next step already runs under build); rejecting
 * interrupts the session, which aborts the executor into a revision
 * prompt. No "always" — every submission asks fresh. `interrupted` is
 * the RESTART-ORPHAN variant: the session is idle (its executor died
 * with the app), so the decision is delivered as a wake prompt — the
 * warning line says so. Shows the plan DOCUMENT only — the task list
 * is not previewed here (it lives in the stats panel's Plan progress
 * section and the saved document's checklist appendix). A payload that
 * fails to parse is a malformed submission (rejection only) — kept as a
 * defensive fallback since the executor validates before blocking.
 */
export const PlanApprovalCard = memo(function PlanApprovalCard({
    payload,
    interrupted,
    onApprove,
    onReject,
}: {
    /** The submitted plan, or null when unparseable. */
    payload: PlanSubmitPayload | null;
    /** Restart orphan: the blocking executor is gone — the decision
     * wakes the session instead of unblocking a live poll. */
    interrupted: boolean;
    onApprove: () => void;
    onReject: () => void;
}) {
    const t = useI18n();
    return (
        <GateCard
            icon={ClipboardCheck}
            title={t["Approve plan"]}
            interruptedWarning={t["Approval wait interrupted"]}
            invalidNotice={t["Invalid plan submission"]}
            document={payload ? payload.plan : null}
            approveLabel={t["Approve"]}
            interrupted={interrupted}
            onApprove={onApprove}
            onReject={onReject}
        />
    );
});
