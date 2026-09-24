import {type CSSProperties} from "react";
import {motion} from "framer-motion";
import {ChevronRight, Plus, X} from "lucide-react";
import {useColors} from "../hooks/colors.tsx";
import {whileHoverTap} from "../lib/motion.ts";
import ExitPresence, {ExitList} from "./ui/ExitPresence.tsx";
import {folderLabel} from "../lib/path.ts";
import {useI18n} from "../hooks/i18n.tsx";
import {relativeAge, type SessionInfo} from "./sessionGrouping.ts";
import SessionTitle from "./SessionTitle.tsx";
import Hint from "./ui/Hint.tsx";

/** Sessions shown per folder before the "Show more" expander. */
export const MAX_VISIBLE_SESSIONS = 5;

/**
 * One folder group in the sidebar: collapsible header (label + per-folder
 * new-session button + disclosure chevron), the session list, and the
 * "Show more / Show less" expander. The parent (SessionBar) owns which
 * folders are collapsed and how far each is expanded; this component
 * renders the state it's handed.
 *
 * Motion is CSS: the folder body folds through .lum-fold (grid rows —
 * the browser animates the real height), the chevron rotates via a
 * transition, rows appear with .lum-enter and unmount without exit
 * choreography. The header's chevron and the buttons keep framer only
 * for the shared hover/tap spring.
 */
export default function SessionFolder({
    directory,
    sessions,
    visibleSessions,
    activeId,
    busyIds,
    pendingCounts,
    collapsed,
    now,
    foregroundColor,
    onSelect,
    onClose,
    onSessionHover,
    onToggleFolder,
    onNewInFolder,
    onShowMore,
    onShowLess,
}: {
    /** The group's working directory ("" = the no-directory bucket). */
    directory: string;
    /** Every session in the folder. */
    sessions: SessionInfo[];
    /** The slice currently revealed (cap + expansions). */
    visibleSessions: SessionInfo[];
    activeId: string | null;
    busyIds?: ReadonlySet<string>;
    pendingCounts?: ReadonlyMap<string, number>;
    collapsed: boolean;
    /** Ticking "now" for relative ages (owned by SessionBar). */
    now: number;
    foregroundColor: string;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    /** Hover prefetch — warms a session's stats before it's opened. */
    onSessionHover?: (id: string) => void;
    onToggleFolder: (directory: string) => void;
    /** New session pinned to this folder (header +). */
    onNewInFolder: (directory?: string) => void;
    /** Reveal another batch ("Show more" — grows the cap). */
    onShowMore: (directory: string, visibleCount: number) => void;
    /** Collapse back to the initial cap ("Show less"). */
    onShowLess: (directory: string) => void;
}) {
    const colors = useColors();
    const t = useI18n();
    const visibleCount = visibleSessions.length;

    return (
        <div>
            <div
                className="group/folder w-full flex items-center gap-1 px-3 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider cursor-pointer transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-glass)] hover:opacity-70"
                style={{color: colors.inactiveText}}
                onClick={() => onToggleFolder(directory)}
            >
                {/* The header shows only the directory's last segment — the
                 * hint carries the full path. */}
                <Hint label={directory || undefined} className="min-w-0 flex-1">
                    <span className="block truncate text-left">
                        {directory ? folderLabel(directory) : t["Other Sessions"]}
                    </span>
                </Hint>
                <Hint label={t["New Session"]}>
                    <button
                        type="button"
                        className="shrink-0 flex items-center p-0.5 rounded-[var(--radius-xs)] opacity-0 lum-wash transition-opacity duration-[var(--duration-fast)] cursor-pointer group-hover/folder:opacity-100"
                        style={{"--lum-wash": colors.hoverOverlay} as CSSProperties}
                        onClick={(e) => {
                            e.stopPropagation();
                            onNewInFolder(directory || undefined);
                        }}
                    >
                        <Plus size={12} />
                    </button>
                </Hint>
                <span
                    className={`shrink-0 flex items-center transition-rotate duration-[var(--duration-base)] ease-[var(--ease-spring)] ${collapsed ? "" : "rotate-90"}`}
                >
                    <ChevronRight size={12} />
                </span>
            </div>
            {/* The folder body folds via .lum-fold (grid rows) and its
                rows mount only while open (held through the collapse
                transition — the exit engine): collapsed folders keep NO
                rows in the DOM. Session rows themselves leave through
                ExitList: a deleted row (user close, helper-session
                sweep) collapses in place, budget-limited so bulk sweeps
                don't stack twenty animations at once. */}
            <div className="lum-fold -mx-1.5" data-open={!collapsed}>
                {/* Breathing room inside the animated clip: horizontal
                    padding (with the matching negative margin above) keeps
                    row hover washes from being cut off at the sides, bottom
                    padding gives entering rows' rise room — all on an inner
                    layer so collapsing to 0fr clips it away too. */}
                <div className="px-1.5 pt-0.5 pb-2">
                    <ExitPresence present={!collapsed} exitMs={300} budget={false}>
                        {() => (<>
                    <ExitList
                        items={visibleSessions}
                        keyOf={(session) => session.id}
                        exitMs={250}
                        exit={{animation: "lum-row-exit"}}
                        rowClassName="my-0.5"
                    >
                        {(session) => {
                            const isActive = session.id === activeId;
                            const pendingCount = pendingCounts?.get(session.id);
                            return (
                                <div className="lum-enter relative -mx-1.5 px-1.5 cursor-pointer">
                                    <div
                                        className={`group relative flex flex-row items-center justify-between pl-7 pr-3 py-2 rounded-[var(--radius-sm)] lum-wash ${isActive ? "bg-[var(--lum-wash-accent)]" : ""}`}
                                        style={{
                                            // The active row washes with the accent; a
                                            // plain row with the default hover wash.
                                            "--lum-wash": isActive ? colors.accentOverlay : colors.hoverOverlay,
                                        } as CSSProperties}
                                        onClick={() => onSelect(session.id)}
                                        onPointerEnter={() => onSessionHover?.(session.id)}
                                    >
                                        {/* Busy dot pins into the indent gutter left of
                                            the row so session names stay aligned. */}
                                        {busyIds?.has(session.id) && (
                                            <span
                                                className="absolute left-3 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full animate-pulse pointer-events-none"
                                                style={{backgroundColor: "var(--color-brand-lavender)"}}
                                            />
                                        )}
                                        <div className="flex items-center gap-2 min-w-0 flex-1">
                                            <SessionTitle
                                                text={session.name}
                                                className="text-sm leading-tight"
                                                style={{
                                                    color: isActive ? foregroundColor : colors.inactiveText,
                                                }}
                                            />
                                        </div>
                                        {/* Pending badge, age and the delete button
                                            share one fixed-width slot; hover cross-fades
                                            to the delete button so the title never shifts.
                                            A pending count (permissions + questions) takes
                                            the slot over from the age. */}
                                        <div className="relative shrink-0 ml-1 w-5 h-4">
                                            {pendingCount != null && (
                                                <Hint label={t["Permission request"]} className="absolute inset-0">
                                                    <span
                                                        className="w-full h-full flex items-center justify-end transition-opacity duration-[var(--duration-fast)] group-hover:opacity-0"
                                                    >
                                                        <span
                                                            className="min-w-4 h-4 px-1 rounded-full text-[10px] font-semibold leading-4 text-center select-none"
                                                            style={{backgroundColor: "#f59e0b", color: "#fff"}}
                                                        >
                                                            {pendingCount}
                                                        </span>
                                                    </span>
                                                </Hint>
                                            )}
                                            {pendingCount == null && session.updatedAt != null && (
                                                <span
                                                    className="absolute inset-0 flex items-center justify-end text-[11px] tabular-nums transition-opacity duration-[var(--duration-fast)] group-hover:opacity-0"
                                                    style={{color: colors.inactiveText}}
                                                >
                                                    {relativeAge(session.updatedAt, now)}
                                                </span>
                                            )}
                                            <Hint label={t["Delete session"]} className="absolute inset-0">
                                                <button
                                                    className="w-full h-full flex items-center justify-center cursor-pointer opacity-0 rounded-[var(--radius-xs)] lum-wash transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100"
                                                    style={{
                                                        "--lum-wash": colors.activeOverlay,
                                                        color: isActive ? foregroundColor : colors.inactiveText,
                                                    } as CSSProperties}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onClose(session.id);
                                                    }}
                                                >
                                                    <X size={12} />
                                                </button>
                                            </Hint>
                                        </div>
                                    </div>
                                </div>
                            );
                        }}
                    </ExitList>
                    {/* Expanded: split into two halves — left keeps
                        revealing batches of 5, right collapses back
                        to the initial cap. Fully expanded → collapse
                        only. */}
                    {sessions.length > MAX_VISIBLE_SESSIONS && (
                        visibleCount > MAX_VISIBLE_SESSIONS ? (
                            <div className="flex flex-row w-full gap-1">
                                {visibleCount < sessions.length && (
                                    <motion.button
                                        type="button"
                                        {...whileHoverTap}
                                        className="flex-1 min-w-0 flex items-center justify-center px-2 py-1.5 text-[11px] cursor-pointer rounded-[var(--radius-sm)] lum-wash"
                                        style={{color: colors.inactiveText} as CSSProperties}
                                        onClick={() => onShowMore(directory, visibleCount)}
                                    >
                                        {`${t["Show more"]} (${sessions.length - visibleCount})`}
                                    </motion.button>
                                )}
                                <motion.button
                                    type="button"
                                    {...whileHoverTap}
                                    className="flex-1 min-w-0 flex items-center justify-center px-2 py-1.5 text-[11px] cursor-pointer rounded-[var(--radius-sm)] lum-wash"
                                    style={{color: colors.inactiveText} as CSSProperties}
                                    onClick={() => onShowLess(directory)}
                                >
                                    {t["Show less"]}
                                </motion.button>
                            </div>
                        ) : (
                            <motion.button
                                type="button"
                                {...whileHoverTap}
                                className="w-full flex items-center px-7 py-1.5 text-[11px] cursor-pointer rounded-[var(--radius-sm)] lum-wash"
                                style={{color: colors.inactiveText} as CSSProperties}
                                onClick={() => onShowMore(directory, visibleCount)}
                            >
                                {`${t["Show more"]} (${sessions.length - visibleCount})`}
                            </motion.button>
                        )
                    )}
                    </>)}
                </ExitPresence>
                </div>
            </div>
        </div>
    );
}
