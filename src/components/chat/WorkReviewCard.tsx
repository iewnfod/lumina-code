import {memo} from "react";
import {BadgeCheck} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {useScrollEdges} from "../../hooks/useScrollEdges.ts";
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
    // Conditional edge fades: same reading posture as the plan approval
    // card — flush content, fades only while a side has hidden content.
    const edges = useScrollEdges<HTMLDivElement>();
    return (
        <Card>
            <div className="flex items-center gap-2 text-sm font-medium">
                <BadgeCheck size={15} className="shrink-0" style={{color: "var(--color-success)"}}/>
                <span>{t["Review work"]}</span>
            </div>
            {interrupted && (
                <div className="pl-6 text-xs" style={{color: "var(--color-warning)"}}>
                    {t["Review wait interrupted"]}
                </div>
            )}
            {payload ? (
                // The report renders as MARKDOWN (the shared .lum-md
                // typography) in a viewport-proportional scroll area —
                // same reading posture as the plan approval card. No
                // `live`: static content, no entrance animations.
                <div
                    ref={edges.ref}
                    onScroll={edges.onScroll}
                    className={`pl-6 max-h-[45vh] overflow-y-auto lum-fade-lg${edges.top ? " lum-fade-top" : ""}${edges.bottom ? " lum-fade-bottom" : ""}`}
                >
                    <Markdown>{payload.report}</Markdown>
                </div>
            ) : (
                <div className="pl-6 text-xs" style={{color: "var(--color-danger-text)"}}>
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
