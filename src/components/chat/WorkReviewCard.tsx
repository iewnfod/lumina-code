import {memo} from "react";
import {BadgeCheck} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import type {WorkSubmitPayload} from "../../opencode/sessionActivity.ts";
import {Card, CardButton} from "./RequestCardChrome.tsx";
import Markdown from "./Markdown.tsx";

/**
 * The plan workflow's acceptance card (the second gate): the work_submit
 * executor BLOCKS inside its tool call until the user has TESTED the
 * delivered work and decides — archival certifies "tested and working",
 * never the AI's own claim of completion. ChatView derives the pending
 * state from the transcript (workApprovalPending) and pins this card
 * above the composer. Approving writes the marker file the executor
 * polls (.lumina/review/{sessionID}.json — it then archives the plan
 * directory into .lumina/archived/); rejecting interrupts the session,
 * aborting the executor into a revision prompt. A payload that fails to
 * parse is a malformed submission (rejection only) — kept as a defensive
 * fallback since the executor validates before blocking.
 */
export const WorkReviewCard = memo(function WorkReviewCard({
    payload,
    onApprove,
    onReject,
}: {
    /** The submitted report, or null when unparseable. */
    payload: WorkSubmitPayload | null;
    onApprove: () => void;
    onReject: () => void;
}) {
    const t = useI18n();
    return (
        <Card>
            <div className="flex items-center gap-2 text-sm font-medium">
                <BadgeCheck size={15} className="shrink-0" style={{color: "#10b981"}}/>
                <span>{t["Review work"]}</span>
            </div>
            {payload ? (
                // The report renders as MARKDOWN (the shared .lum-md
                // typography) in a viewport-proportional scroll area —
                // same reading posture as the plan approval card. No
                // `live`: static content, no entrance animations.
                <div className="pl-6 max-h-[45vh] overflow-y-auto">
                    <Markdown>{payload.report}</Markdown>
                </div>
            ) : (
                <div className="pl-6 text-xs" style={{color: "#f87171"}}>
                    {t["Invalid work report"]}
                </div>
            )}
            <div className="flex items-center justify-end gap-2">
                <CardButton label={t["Reject"]} onClick={onReject}/>
                <CardButton
                    label={t["Approve & archive"]}
                    primary
                    disabled={!payload}
                    onClick={() => payload && onApprove()}
                />
            </div>
        </Card>
    );
});
