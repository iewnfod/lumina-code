import {type CSSProperties, useCallback, useEffect, useState} from "react";
import {motion} from "framer-motion";
import {ChevronRight, Plus, X} from "lucide-react";
import Icon from "../assets/icon.svg";
import {isMacOS} from "../lib/platform.ts";
import {CHROME_TITLE_BAR_HEIGHT} from "../constants.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {glassSurface} from "../lib/glass.ts";
import {springSnappy, springSoft, whileHoverTap} from "../lib/motion.ts";
import {useI18n} from "../hooks/i18n.tsx";

/**
 * The app's sidebar — a vertical session list grouped by working directory.
 * Ported from lumina-terminal's TabBar with the terminal-only machinery
 * stripped (tab tear-off/reorder drag controller, shell/app icons, update
 * banner, privileged-command dot); the layout, glass material, row anatomy
 * and motion are identical.
 */

export interface SessionInfo {
    id: string;
    name: string;
    /** Working directory the session lives in — tabs group under it. */
    directory?: string;
    /** Last update time (epoch ms) — rendered as a relative age. */
    updatedAt?: number;
}

interface SessionBarProps {
    sessions: SessionInfo[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    /** Create a session — in the given folder's directory, if any. */
    onNew: (directory?: string) => void;
    backgroundColor: string;
    foregroundColor: string;
    collapsed: boolean;
    /** Brand text shown in the sidebar's top-left. Falls back to "Lumina". */
    brandTitle?: string;
    /** OpenCode connection indicator shown above the New Session button. */
    connection?: ConnectionState;
    /** Sessions with an execution in flight — show a pulsing indicator. */
    busyIds?: ReadonlySet<string>;
    /** Pending server requests per session (permissions + question
     *  forms) — shows a badge so blocked non-active sessions surface. */
    pendingCounts?: ReadonlyMap<string, number>;
}

export interface ConnectionState {
    state: "connecting" | "connected" | "error";
    label: string;
    /** Full text for the tooltip (defaults to the label). */
    detail?: string;
}

/** Sessions shown per folder before the "Show more" expander. */
const MAX_VISIBLE_SESSIONS = 5;

/** Indicator dot color per connection state — semantic, brand-adjacent. */
const CONNECTION_DOT: Record<ConnectionState["state"], string> = {
    connecting: "#f59e0b",
    connected: "#22c55e",
    error: "#ef4444",
};

/** Group-header label for a directory: its last path segment. */
function folderLabel(directory: string): string {
    const trimmed = directory.replace(/[\\/]+$/, "");
    const base = trimmed.split(/[\\/]/).filter(Boolean).pop();
    return base || trimmed || directory;
}

/** Compact relative age: "now", "5m", "3h", "2d" — locale-neutral units. */
function relativeAge(updatedAt: number, now: number): string {
    const diff = Math.max(0, now - updatedAt);
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

/** Sessions bucketed by working directory, folders in order of each
 *  folder's most recently updated session (the server's list order). */
function groupByDirectory(sessions: SessionInfo[]): [string, SessionInfo[]][] {
    const groups = new Map<string, SessionInfo[]>();
    for (const session of sessions) {
        const key = session.directory ?? "";
        const bucket = groups.get(key);
        if (bucket) bucket.push(session);
        else groups.set(key, [session]);
    }
    return Array.from(groups.entries());
}

export default function SessionBar(props: SessionBarProps) {
    const {sessions, activeId, onSelect, onClose, onNew, backgroundColor, foregroundColor, collapsed, brandTitle, connection, busyIds, pendingCounts} = props;
    const t = useI18n();

    // Ticking "now" so relative ages stay fresh (minute resolution —
    // re-rendering every 30s is plenty and keeps the list calm).
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, []);

    const colors = useSurfaceColors(backgroundColor);
    const {supportsGlass} = useGlass();

    // Folders the user has collapsed (by directory path). The active
    // session's folder always re-expands so the open tab can't vanish.
    const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(new Set());
    // Folders expanded past the initial 5 most-recent sessions; each
    // "Show more" press reveals another batch of 5.
    const [extraDirs, setExtraDirs] = useState<Map<string, number>>(new Map());
    const toggleFolder = useCallback((directory: string) => {
        setCollapsedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(directory)) next.delete(directory);
            else next.add(directory);
            return next;
        });
    }, []);
    useEffect(() => {
        if (activeId === null) return;
        const dir = sessions.find((s) => s.id === activeId)?.directory ?? "";
        setCollapsedDirs((prev) => (prev.has(dir) ? new Set([...prev].filter((d) => d !== dir)) : prev));
    }, [activeId, sessions]);

    // The sidebar wears the glass material over the content canvas. On
    // platforms where backdrop-filter is unreliable (Linux/Wayland), this
    // falls back to an opaque derived surface — same visual role, no blur.
    const glass = glassSurface(backgroundColor, supportsGlass, {blurPx: 16});

    return (
        <div
            className="flex flex-col h-full select-none transition-[width,min-width,opacity] duration-[var(--duration-slow)] ease-[var(--ease-spring)] overflow-hidden"
            style={{
                width: collapsed ? 0 : 240,
                minWidth: collapsed ? 0 : 240,
                ...glass,
            }}
        >
            {/* On macOS this intentionally stays empty: the native Overlay
                traffic lights occupy this full-width chrome row. Keeping it
                equal to TitleBar prevents the first session row from sliding
                underneath the window controls. */}
            <div
                data-tauri-drag-region
                className="shrink-0 px-3 flex flex-row items-center"
                style={{
                    height: CHROME_TITLE_BAR_HEIGHT,
                    color: foregroundColor,
                }}
            >
                <div className="flex flex-row items-center gap-1.5" data-tauri-drag-region>
                    {!isMacOS() && (
                        <>
                            <img
                                src={Icon}
                                alt=""
                                className="h-5 w-5 pointer-events-none"
                            />
                            <span className="text-sm font-medium truncate leading-tight">
                                {brandTitle ?? "Lumina"}
                            </span>
                        </>
                    )}
                </div>
            </div>

            {/* New session — its own full-width row above the session list.
                No folder given → App defaults to the previous session's
                project (each folder header's + pins that folder). */}
            <div className="shrink-0 px-1.5 pt-0.5 pb-1">
                <motion.button
                    type="button"
                    {...whileHoverTap}
                    className="w-full flex flex-row items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] cursor-pointer hover:bg-[var(--lum-new-session-hover)] transition-colors duration-[var(--duration-base)] ease-[var(--ease-glass)]"
                    style={{
                        "--lum-new-session-hover": colors.hoverOverlay,
                        color: colors.inactiveText,
                    } as CSSProperties}
                    title={t["New Session"]}
                    onClick={() => onNew()}
                >
                    <Plus size={14}/>
                    <span className="text-sm truncate leading-tight">{t["New Session"]}</span>
                </motion.button>
            </div>

            <div
                className={`flex-1 overflow-y-auto overflow-x-hidden px-1.5 ${isMacOS() ? "pt-1.5" : ""}`}
                data-tauri-drag-region
            >
                {groupByDirectory(sessions).map(([directory, groupSessions]) => {
                    const collapsed = collapsedDirs.has(directory);
                    const activeIndex = activeId === null ? -1 : groupSessions.findIndex((s) => s.id === activeId);
                    // Cap each folder at its 5 most-recent sessions; each
                    // "Show more" reveals another 5. The active session always
                    // stays visible even beyond the current cap.
                    const visibleCount = Math.min(
                        groupSessions.length,
                        Math.max(MAX_VISIBLE_SESSIONS + (extraDirs.get(directory) ?? 0), activeIndex + 1),
                    );
                    const visibleSessions = groupSessions.slice(0, visibleCount);
                    return (
                        <div key={directory}>
                        <div
                            className="group/folder w-full flex items-center gap-1 px-3 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider cursor-pointer transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-glass)] hover:opacity-70"
                            style={{color: colors.inactiveText}}
                            title={directory || undefined}
                            onClick={() => toggleFolder(directory)}
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
                                    onNew(directory || undefined);
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
                            {!collapsed && visibleSessions.map((session) => {
                                const isActive = session.id === activeId;
                                return (
                                    <div
                                        key={session.id}
                                        className="relative my-0.5 cursor-pointer"
                                        title={session.name}
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
                                            <span
                                                    className="text-sm truncate leading-tight"
                                                    style={{
                                                        color: isActive ? foregroundColor : colors.inactiveText,
                                                    }}
                                                >
                                                    {session.name}
                                                </span>
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
                                                    title="Delete session"
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
                                    </div>
                                );
                            })}
                            {!collapsed && groupSessions.length > MAX_VISIBLE_SESSIONS && (
                                <button
                                    type="button"
                                    className="w-full flex items-center px-7 py-1.5 text-[11px] cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--lum-folder-more-hover)] transition-colors duration-[var(--duration-base)] ease-[var(--ease-glass)]"
                                    style={{"--lum-folder-more-hover": colors.hoverOverlay, color: colors.inactiveText} as CSSProperties}
                                    onClick={() => {
                                        setExtraDirs((prev) => {
                                            const next = new Map(prev);
                                            next.set(directory, visibleCount >= groupSessions.length ? 0 : visibleCount);
                                            return next;
                                        });
                                    }}
                                >
                                    {visibleCount >= groupSessions.length
                                        ? t["Show less"]
                                        : `${t["Show more"]} (${groupSessions.length - visibleCount})`}
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>

            <div className="shrink-0 px-1.5 pb-1.5">
                {connection && !collapsed && (
                    <div
                        className="my-1 flex items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)]"
                        title={connection.detail ?? connection.label}
                        style={{color: colors.inactiveText}}
                    >
                        <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{backgroundColor: CONNECTION_DOT[connection.state]}}
                        />
                        <span className="text-xs truncate">{connection.label}</span>
                    </div>
                )}
            </div>
        </div>
    );
}
