import {memo, useEffect, useRef, useState} from "react";
import {ShieldCheck} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {useColors} from "../../hooks/colors.tsx";
import {useJudgeAudit} from "../../hooks/usePermissionJudge.ts";
import type {JudgeAuditEntry} from "../../opencode/permissionJudge.ts";
import ExitPresence from "../ui/ExitPresence.tsx";

/** How long the quiet line lingers before fading itself out. */
const AUDIT_LINGER_MS = 5000;

/** Request ids whose transient line already PLAYED — module-level on
 * purpose: the row unmounts on every surface switch (settings page,
 * session switch-and-back), and component state would lose the
 * "already shown" memory, replaying a dismissed entry on every return.
 * With the module set, remounts stay quiet and only a genuinely NEW
 * allow re-arms the line. */
const playedRequestIds = new Set<string>();

/**
 * The permission judge's TRANSIENT audit affordance — one quiet line
 * above the request cards telling the user the AI just auto-allowed
 * the newest judged access of the OPEN session (what it let through
 * and why). Auto-dismisses after a few seconds (a new entry restarts
 * the clock); the DURABLE, queryable history lives in the AI 权限评估
 * settings page (JudgeAuditHistory — the record persists across
 * restarts). Deliberately NOT transcript injection; the authoritative
 * log line is in the plugin log.
 */
export const JudgeAuditRow = memo(function JudgeAuditRow({sessionID}: {sessionID: string}) {
    const t = useI18n();
    const colors = useColors();
    const audit = useJudgeAudit();
    const [visible, setVisible] = useState(false);
    const entry: JudgeAuditEntry | undefined = audit.find((e) => e.sessionID === sessionID);
    // This component instance's birth time — entries that predate it
    // (a restart's persisted history, another session's record after a
    // switch) never announce: the line exists for NEW allows only.
    const mountedAtRef = useRef(Date.now());

    // Auto-dismiss: show on a NEW entry, hide again after the linger.
    useEffect(() => {
        if (!entry) return;
        if (entry.time <= mountedAtRef.current) return;
        if (playedRequestIds.has(entry.requestId)) return;
        setVisible(true);
        const timer = setTimeout(() => {
            playedRequestIds.add(entry.requestId);
            setVisible(false);
        }, AUDIT_LINGER_MS);
        return () => clearTimeout(timer);
    }, [entry?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <ExitPresence present={visible && entry !== undefined} exitMs={200} budget={false}>
            {(closing) =>
                entry && (
                    <div
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] text-2xs transition-opacity duration-200 ${closing ? "opacity-0" : "opacity-100"}`}
                        style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
                    >
                        <ShieldCheck size={13} className="shrink-0 opacity-70"/>
                        <span className="min-w-0 flex-1 truncate">
                            {t["Auto-allowed by AI"]}
                            {entry.resources.length > 0 && (
                                <span className="opacity-70" style={MONO}>{` ${entry.resources[0]}`}</span>
                            )}
                            {entry.reason && <span className="opacity-70">{` — ${entry.reason}`}</span>}
                        </span>
                    </div>
                )
            }
        </ExitPresence>
    );
});

/** The audit line's resource reads mono — same family as the request
 * cards' resource lines (RequestCardChrome's MONO_STYLE is not exported
 * for size reasons; this is the same recipe, sized down). */
const MONO = {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--lum-code-size, 11px)",
} as const;
