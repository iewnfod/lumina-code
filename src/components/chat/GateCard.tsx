import {memo} from "react";
import type {LucideIcon} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {fadeClasses, useScrollEdges} from "../../hooks/useScrollEdges.ts";
import {Card, CardButton} from "./RequestCardChrome.tsx";
import Markdown from "./Markdown.tsx";

/**
 * The plan workflow's two gate cards (PlanApprovalCard / WorkReviewCard)
 * share one chrome — title row with the gate's icon, the RESTART-ORPHAN
 * warning line, a markdown reading area with conditional edge fades, and
 * the reject/approve button pair (approve disabled for a payload that
 * failed to parse — a malformed submission offers rejection only).
 * This is that skeleton; the two cards are thin wrappers that name
 * their gate, its icon and its copy.
 */
export const GateCard = memo(function GateCard({
    icon: Icon,
    title,
    interruptedWarning,
    invalidNotice,
    document,
    approveLabel,
    interrupted,
    onApprove,
    onReject,
}: {
    icon: LucideIcon;
    title: string;
    /** Warning line shown while `interrupted` (the restart-orphan state). */
    interruptedWarning: string;
    /** Shown instead of the document when the payload failed to parse. */
    invalidNotice: string;
    /** The markdown document to review, or null when unparseable. */
    document: string | null;
    approveLabel: string;
    interrupted: boolean;
    onApprove: () => void;
    onReject: () => void;
}) {
    const t = useI18n();
    // Conditional edge fades: the reading area is flush (pl-6, no
    // vertical padding), so fades appear only while a side has hidden
    // content — a short document renders fade-free.
    const edges = useScrollEdges<HTMLDivElement>();
    return (
        <Card>
            <div className="flex items-center gap-2 text-sm font-medium">
                <Icon size={15} className="shrink-0" style={{color: "var(--color-success)"}}/>
                <span>{title}</span>
            </div>
            {interrupted && (
                <div className="pl-6 text-xs" style={{color: "var(--color-warning)"}}>
                    {interruptedWarning}
                </div>
            )}
            {document !== null ? (
                // The document renders as MARKDOWN (the shared .lum-md
                // typography — this is a reading surface, not a data
                // dump) in a viewport-proportional scroll area: long
                // documents need real reading room, short ones stay
                // content-sized. No `live` — static content, no
                // entrance animations.
                <div
                    ref={edges.ref}
                    onScroll={edges.onScroll}
                    className={`pl-6 max-h-[45vh] overflow-y-auto lum-fade-lg${fadeClasses(edges)}`}
                >
                    <Markdown>{document}</Markdown>
                </div>
            ) : (
                <div className="pl-6 text-xs" style={{color: "var(--color-danger-text)"}}>
                    {invalidNotice}
                </div>
            )}
            <div className="flex items-center justify-end gap-2">
                <CardButton label={t["Reject"]} onClick={onReject}/>
                <CardButton
                    label={approveLabel}
                    primary
                    disabled={document === null}
                    onClick={() => document !== null && onApprove()}
                />
            </div>
        </Card>
    );
});
