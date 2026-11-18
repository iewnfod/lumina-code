import {memo, useState} from "react";
import {motion} from "framer-motion";
import {ChevronRight, History} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {useColors} from "../../hooks/colors.tsx";
import {whileHoverTap} from "../../lib/motion.ts";
import {useJudgeAudit} from "../../hooks/usePermissionJudge.ts";
import Modal from "../ui/Modal.tsx";

/**
 * The permission judge's DURABLE audit view — the queryable history the
 * transient chat line (JudgeAuditRow) only previews: every auto-allow
 * the judge has made, newest first (persisted across restarts — see
 * permissionJudge.ts's auditStore). Rendered as a quiet ENTRY row under
 * the AI 权限评估 pane that opens the list in a MODAL (the pane's
 * model-picker layout stays untouched); the entry carries the count.
 */
export const JudgeAuditHistory = memo(function JudgeAuditHistory() {
    const t = useI18n();
    const colors = useColors();
    const audit = useJudgeAudit();
    const [open, setOpen] = useState(false);

    return (
        <>
            {/* A full-width entry row — the same row chrome as the pane's
             * model rows (hover wash + spring), opening the modal. */}
            <motion.button
                type="button"
                {...whileHoverTap}
                onClick={() => setOpen(true)}
                className="flex items-center justify-between gap-2 w-full mt-2 px-2.5 py-2 rounded-[var(--radius-sm)] text-left cursor-pointer hover:bg-[var(--lum-row-hover)]"
                style={{"--lum-row-hover": colors.hoverOverlay} as React.CSSProperties}
            >
                <span className="flex items-center gap-2 min-w-0 flex-1">
                    <History size={14} className="shrink-0 opacity-60"/>
                    <span className="text-xs truncate">{t["Recent auto-allows"]}</span>
                    {audit.length > 0 && (
                        <span className="text-2xs opacity-60">({audit.length})</span>
                    )}
                </span>
                <ChevronRight size={14} className="shrink-0 opacity-50"/>
            </motion.button>
            <Modal open={open} onClose={() => setOpen(false)} title={t["Recent auto-allows"]}>
                {audit.length === 0 ? (
                    <p className="text-2xs leading-relaxed py-2" style={{color: colors.inactiveText}}>
                        {t["No auto-allows yet — accesses the AI judge lets through will be listed here"]}
                    </p>
                ) : (
                    <div className="flex flex-col gap-1 max-h-[60vh] overflow-y-auto" style={MONO}>
                        {audit.map((e) => (
                            <div
                                key={e.requestId}
                                className="flex items-baseline gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-2xs leading-relaxed"
                                style={{background: colors.recessedBg}}
                            >
                                <span className="shrink-0 opacity-60">{formatAuditTime(e.time)}</span>
                                <span className="min-w-0 flex-1">
                                    <span className="break-all">{e.resources.join(", ") || e.action}</span>
                                    {e.reason && <span className="block opacity-60">{e.reason}</span>}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </Modal>
        </>
    );
});

/** Local wall-clock time: today shows HH:MM, older days show the date
 *  too — audit reading is human-scale, not relative-age churn. */
function formatAuditTime(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return hm;
    return `${d.getFullYear() === now.getFullYear() ? "" : `${d.getFullYear()}-`}${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

const MONO = {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--lum-code-size, 11px)",
} as const;
