import {type CSSProperties} from "react";
import {motion, AnimatePresence} from "framer-motion";
import {ChevronRight, Plus, X} from "lucide-react";
import type {SurfaceColors} from "../hooks/surfaceColors.ts";
import {durationBase, durationFast, easeGlass, easeSpring, springSnappy, springSoft, whileHoverTap} from "../lib/motion.ts";
import {folderLabel} from "../lib/path.ts";
import {useI18n} from "../hooks/i18n.tsx";
import {relativeAge, type SessionInfo} from "./sessionGrouping.ts";
import SessionTitle from "./SessionTitle.tsx";

/** Sessions shown per folder before the "Show more" expander. */
export const MAX_VISIBLE_SESSIONS = 5;

/**
 * One folder group in the sidebar: collapsible header (label + per-folder
 * new-session button + disclosure chevron), the animated session list,
 * and the "Show more / Show less" expander. The parent (SessionBar) owns
 * which folders are collapsed and how far each is expanded; this
 * component renders the state it's handed.
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
    colors,
    onSelect,
    onClose,
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
    colors: SurfaceColors;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onToggleFolder: (directory: string) => void;
    /** New session pinned to this folder (header +). */
    onNewInFolder: (directory?: string) => void;
    /** Reveal another batch ("Show more" — grows the cap). */
    onShowMore: (directory: string, visibleCount: number) => void;
    /** Collapse back to the initial cap ("Show less"). */
    onShowLess: (directory: string) => void;
}) {
    const t = useI18n();
    const visibleCount = visibleSessions.length;

    return (
        <div>
            <div
                className="group/folder w-full flex items-center gap-1 px-3 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider cursor-pointer transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-glass)] hover:opacity-70"
                style={{color: colors.inactiveText}}
                title={directory || undefined}
                onClick={() => onToggleFolder(directory)}
            >
                <span className="truncate flex-1 text-left">
                    {directory ? folderLabel(directory) : t["Other Sessions"]}
                </span>
                <button
                    type="button"
                    className="shrink-0 flex items-center p-0.5 rounded-[var(--radius-xs)] opacity-0 group-hover/folder:opacity-100 hover:bg-[var(--lum-folder-new-hover)] transition-opacity duration-[var(--duration-fast)] cursor-pointer"
                    style={{"--lum-folder-new-hover": colors.hoverOverlay} as CSSProperties}
                    title={t["New Session"]}
                    onClick={(e) => {
                        e.stopPropagation();
                        onNewInFolder(directory || undefined);
                    }}
                >
                    <Plus size={12} />
                </button>
                <motion.span
                    className="shrink-0 flex items-center"
                    animate={{rotate: collapsed ? 0 : 90}}
                    transition={springSnappy}
                >
                    <ChevronRight size={12} />
                </motion.span>
            </div>
            <AnimatePresence initial={false}>
                {!collapsed && (
                    <motion.div
                        key="folder-body"
                        initial={{height: 0, opacity: 0}}
                        animate={{
                            height: "auto",
                            opacity: 1,
                            transition: {height: {duration: durationBase, ease: easeSpring}, opacity: {duration: durationBase, ease: easeGlass, delay: 0.05}},
                        }}
                        exit={{
                            height: 0,
                            opacity: 0,
                            transition: {height: {duration: durationBase, ease: easeGlass}, opacity: {duration: durationFast, ease: easeGlass}},
                        }}
                        className="overflow-hidden -mx-1.5"
                    >
                        {/* Breathing room inside the animated clip: horizontal
                            padding (with the matching negative margin above)
                            keeps row hover-scale from being cut off at the
                            sides, bottom padding gives entering rows' y-offset
                            room — all on an inner layer so collapsing to
                            height 0 clips it away too. */}
                        <div className="px-1.5 pt-0.5 pb-2">
                            <AnimatePresence initial={false}>
                                {visibleSessions.map((session) => {
                                    const isActive = session.id === activeId;
                                    return (
                                        <motion.div
                                            key={session.id}
                                            initial={{
                                                opacity: 0,
                                                height: 0,
                                                marginTop: 0,
                                                marginBottom: 0,
                                            }}
                                            animate={{
                                                opacity: 1,
                                                height: "auto",
                                                marginTop: 2,
                                                marginBottom: 2,
                                                transition: {height: {duration: durationBase, ease: easeSpring}, opacity: {duration: durationBase, ease: easeGlass, delay: 0.05}},
                                            }}
                                            // Enter and exit both animate height so bulk
                                            // reveals ("Show more") and collapses ("Show
                                            // less") read as the list growing/shrinking
                                            // in place — no y-drift, no height snap.
                                            exit={{
                                                opacity: 0,
                                                height: 0,
                                                marginTop: 0,
                                                marginBottom: 0,
                                                transition: {height: {duration: durationBase, ease: easeGlass}, opacity: {duration: durationFast, ease: easeGlass}},
                                            }}
                                            className="relative my-0.5 overflow-hidden -mx-1.5 px-1.5 cursor-pointer"
                                        >
                                            {/* Inner motion layer carries the spring scale
                                                animation and the layout slide used when the
                                                list reorders (a session closing). */}
                                            <motion.div
                                                {...whileHoverTap}
                                                layout="position"
                                                transition={springSoft}
                                                className={`lum-session-row group relative flex flex-row items-center justify-between pl-7 pr-3 py-2 rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-base)] ease-[var(--duration-glass)] hover:bg-[var(--lum-session-hover)] ${isActive ? "bg-[var(--lum-session-active)]" : ""}`}
                                                style={{
                                                    "--lum-session-hover": isActive ? colors.accentOverlay : colors.hoverOverlay,
                                                    "--lum-session-active": colors.accentOverlay,
                                                } as CSSProperties}
                                                onClick={() => onSelect(session.id)}
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
                                                {pendingCounts?.get(session.id) != null && (
                                                    <span
                                                        className="shrink-0 min-w-4 h-4 px-1 ml-1 rounded-full text-[10px] font-semibold leading-4 text-center select-none"
                                                        style={{backgroundColor: "#f59e0b", color: "#fff"}}
                                                        title={t["Permission request"]}
                                                    >
                                                        {pendingCounts.get(session.id)}
                                                    </span>
                                                )}
                                                {/* Age and the delete button share one fixed-width
                                                    slot; hover cross-fades between them so the
                                                    title never shifts. */}
                                                <div className="relative shrink-0 ml-1 w-5 h-4">
                                                    {session.updatedAt != null && (
                                                        <span
                                                            className="absolute inset-0 flex items-center justify-end text-[11px] tabular-nums transition-opacity duration-[var(--duration-fast)] group-hover:opacity-0"
                                                            style={{color: colors.inactiveText}}
                                                            title={new Date(session.updatedAt).toLocaleString()}
                                                        >
                                                            {relativeAge(session.updatedAt, now)}
                                                        </span>
                                                    )}
                                                    <button
                                                        className="lum-session-close absolute inset-0 flex items-center justify-center cursor-pointer opacity-0 rounded-[var(--radius-xs)] transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100 hover:bg-[var(--lum-session-active)]"
                                                        title={t["Delete session"]}
                                                        style={{
                                                            "--lum-session-active": colors.activeOverlay,
                                                            color: isActive ? foregroundColor : colors.inactiveText,
                                                        } as CSSProperties}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onClose(session.id);
                                                        }}
                                                    >
                                                        <X size={12} />
                                                    </button>
                                                </div>
                                            </motion.div>
                                        </motion.div>
                                    );
                                })}
                            </AnimatePresence>
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
                                                className="flex-1 min-w-0 flex items-center justify-center px-2 py-1.5 text-[11px] cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--lum-folder-more-hover)] transition-colors duration-[var(--duration-base)] ease-[var(--ease-glass)]"
                                                style={{"--lum-folder-more-hover": colors.hoverOverlay, color: colors.inactiveText} as CSSProperties}
                                                onClick={() => onShowMore(directory, visibleCount)}
                                            >
                                                {`${t["Show more"]} (${sessions.length - visibleCount})`}
                                            </motion.button>
                                        )}
                                        <motion.button
                                            type="button"
                                            {...whileHoverTap}
                                            className="flex-1 min-w-0 flex items-center justify-center px-2 py-1.5 text-[11px] cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--lum-folder-more-hover)] transition-colors duration-[var(--duration-base)] ease-[var(--ease-glass)]"
                                            style={{"--lum-folder-more-hover": colors.hoverOverlay, color: colors.inactiveText} as CSSProperties}
                                            onClick={() => onShowLess(directory)}
                                        >
                                            {t["Show less"]}
                                        </motion.button>
                                    </div>
                                ) : (
                                    <motion.button
                                        type="button"
                                        {...whileHoverTap}
                                        className="w-full flex items-center px-7 py-1.5 text-[11px] cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--lum-folder-more-hover)] transition-colors duration-[var(--duration-base)] ease-[var(--ease-glass)]"
                                        style={{"--lum-folder-more-hover": colors.hoverOverlay, color: colors.inactiveText} as CSSProperties}
                                        onClick={() => onShowMore(directory, visibleCount)}
                                    >
                                        {`${t["Show more"]} (${sessions.length - visibleCount})`}
                                    </motion.button>
                                )
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
