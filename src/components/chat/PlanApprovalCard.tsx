import {memo} from "react";
import {ClipboardCheck} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import type {PlanSubmitPayload} from "../../opencode/sessionActivity.ts";
import {Card, CardButton} from "./RequestCardChrome.tsx";
import Markdown from "./Markdown.tsx";

/**
 * The plan workflow's approval card (Route A): the plan_submit executor
 * BLOCKS inside its tool call awaiting the user's decision — ChatView
 * derives that pending state from the transcript (planApprovalPending)
 * and renders this card pinned above the composer. Approving switches
 * the session to build (the agent change is what the executor's poll
 * waits for — the model's next step already runs under build) and saves
 * the plan document (.lumina/plans/); rejecting interrupts the session,
 * which aborts the executor into a revision prompt. No "always" — every
 * submission asks fresh. Shows the plan DOCUMENT only — the task list
 * is not previewed here (it lives in the stats panel's Plan progress
 * section and the saved document's checklist appendix). A payload that
 * fails to parse is a malformed submission (rejection only) — kept as a
 * defensive fallback since the executor validates before blocking.
 */
export const PlanApprovalCard = memo(function PlanApprovalCard({
    payload,
    onApprove,
    onReject,
}: {
    /** The submitted plan, or null when unparseable. */
    payload: PlanSubmitPayload | null;
    onApprove: () => void;
    onReject: () => void;
}) {
    const t = useI18n();
    return (
        <Card>
            <div className="flex items-center gap-2 text-sm font-medium">
                <ClipboardCheck size={15} className="shrink-0" style={{color: "#10b981"}}/>
                <span>{t["Approve plan"]}</span>
            </div>
            {payload ? (
                // The plan document renders as MARKDOWN (the shared
                // .lum-md typography — this is a reading surface, not a
                // data dump) in a viewport-proportional scroll area:
                // long plans need real reading room, short ones stay
                // content-sized. No `live` — static content, no
                // entrance animations.
                <div className="pl-6 max-h-[45vh] overflow-y-auto">
                    <Markdown>{payload.plan}</Markdown>
                </div>
            ) : (
                <div className="pl-6 text-xs" style={{color: "#f87171"}}>
                    {t["Invalid plan submission"]}
                </div>
            )}
            <div className="flex items-center justify-end gap-2">
                <CardButton label={t["Reject"]} onClick={onReject}/>
                <CardButton
                    label={t["Approve"]}
                    primary
                    disabled={!payload}
                    onClick={() => payload && onApprove()}
                />
            </div>
        </Card>
    );
});
