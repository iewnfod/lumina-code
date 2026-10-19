import {memo} from "react";
import {BadgeCheck} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import type {WorkSubmitPayload} from "../../opencode/sessionActivity.ts";
import {GateCard} from "./GateCard.tsx";

/**
 * The plan workflow's acceptance card (the second gate): the work_submit
 * executor BLOCKS inside its tool call until the user has TESTED the
 * delivered work and decides — archival certifies "tested and working",
 * never the AI's own claim of completion. ChatView derives the pending
 * state from the transcript (workApprovalPending) and pins this card
 * above the composer. Approving writes the marker file the executor
 * polls (.lumina/review/{sessionID}.json — it then archives the plan
 * directory into .lumina/archived/); rejecting interrupts the session,
 * aborting the executor into a revision prompt. `interrupted` is the
 * RESTART-ORPHAN variant: the session is idle (its executor died with
 * the app), so the decision is recorded locally + delivered as a wake
 * prompt, and the plugin's janitor archives on the next model call —
 * the warning line says so. A payload that fails to parse is a
 * malformed submission (rejection only) — kept as a defensive fallback
 * since the executor validates before blocking.
 */
export const WorkReviewCard = memo(function WorkReviewCard({
    payload,
    interrupted,
    onApprove,
    onReject,
}: {
    /** The submitted report, or null when unparseable. */
    payload: WorkSubmitPayload | null;
    /** Restart orphan: the blocking executor is gone — the decision is
     * recorded locally and wakes the session. */
    interrupted: boolean;
    onApprove: () => void;
    onReject: () => void;
}) {
    const t = useI18n();
    return (
        <GateCard
            icon={BadgeCheck}
            title={t["Review work"]}
            interruptedWarning={t["Review wait interrupted"]}
            invalidNotice={t["Invalid work report"]}
            document={payload ? payload.report : null}
            approveLabel={t["Approve & archive"]}
            interrupted={interrupted}
            onApprove={onApprove}
            onReject={onReject}
        />
    );
});
