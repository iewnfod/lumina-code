import {useCallback, useEffect, useState} from "react";
import {motion} from "framer-motion";
import {Plus} from "lucide-react";
import Icon from "../assets/icon.svg";
import {isMacOS} from "../lib/platform.ts";
import {CHROME_TITLE_BAR_HEIGHT} from "../constants.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {glassSurface} from "../lib/glass.ts";
import {whileHoverTap} from "../lib/motion.ts";
import {useI18n} from "../hooks/i18n.tsx";
import {groupByDirectory, type SessionInfo} from "./sessionGrouping.ts";
import SessionFolder, {MAX_VISIBLE_SESSIONS} from "./SessionFolder.tsx";
import type {CSSProperties} from "react";

/**
 * The app's sidebar — a vertical session list grouped by working directory.
 * Ported from lumina-terminal's TabBar with the terminal-only machinery
 * stripped (tab tear-off/reorder drag controller, shell/app icons, update
 * banner, privileged-command dot); the layout, glass material, row anatomy
 * and motion are identical.
 *
 * The shell owns the folder state (which folders are collapsed, how far
 * each is expanded) and the ticking clock for relative ages; each group
 * renders through SessionFolder.
 */

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
    /** Sessions with an execution in flight — show a pulsing indicator. */
    busyIds?: ReadonlySet<string>;
    /** Pending server requests per session (permissions + question
     *  forms) — shows a badge so blocked non-active sessions surface. */
    pendingCounts?: ReadonlyMap<string, number>;
}

export default function SessionBar(props: SessionBarProps) {
    const {sessions, activeId, onSelect, onClose, onNew, backgroundColor, foregroundColor, collapsed, brandTitle, busyIds, pendingCounts} = props;
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

    const showMore = useCallback((directory: string, visibleCount: number) => {
        setExtraDirs((prev) => new Map(prev).set(directory, visibleCount));
    }, []);
    const showLess = useCallback((directory: string) => {
        setExtraDirs((prev) => new Map(prev).set(directory, 0));
    }, []);

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

            <div
                className={`flex-1 overflow-y-auto overflow-x-hidden px-1.5 ${isMacOS() ? "pt-1.5" : ""}`}
                data-tauri-drag-region
            >
                {groupByDirectory(sessions).map(([directory, groupSessions]) => {
                    const collapsedFolder = collapsedDirs.has(directory);
                    const activeIndex = activeId === null ? -1 : groupSessions.findIndex((s) => s.id === activeId);
                    // Cap each folder at its 5 most-recent sessions; each
                    // "Show more" reveals another 5. The active session always
                    // stays visible even beyond the current cap.
                    const visibleCount = Math.min(
                        groupSessions.length,
                        Math.max(MAX_VISIBLE_SESSIONS + (extraDirs.get(directory) ?? 0), activeIndex + 1),
                    );
                    return (
                        <SessionFolder
                            key={directory}
                            directory={directory}
                            sessions={groupSessions}
                            visibleSessions={groupSessions.slice(0, visibleCount)}
                            activeId={activeId}
                            busyIds={busyIds}
                            pendingCounts={pendingCounts}
                            collapsed={collapsedFolder}
                            now={now}
                            foregroundColor={foregroundColor}
                            colors={colors}
                            onSelect={onSelect}
                            onClose={onClose}
                            onToggleFolder={toggleFolder}
                            onNewInFolder={onNew}
                            onShowMore={showMore}
                            onShowLess={showLess}
                        />
                    );
                })}
            </div>

            {/* New session — its own full-width row at the sidebar's bottom
                (bottom-left of the window). No folder given → App defaults
                to the previous session's project (each folder header's +
                pins that folder). */}
            <div className="shrink-0 px-1.5 pt-0.5 pb-1.5">
                <motion.button
                    type="button"
                    {...whileHoverTap}
                    className="w-full flex flex-row items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] cursor-pointer hover:bg-[var(--lum-new-session-hover)] transition-colors duration-[var(--duration-base)] ease-[var(--ease-glass)]"
                    style={{
                        "--lum-new-session-hover": colors.hoverOverlay,
                        color: colors.inactiveText,
                    } as CSSProperties}
                    onClick={() => onNew()}
                >
                    <Plus size={14}/>
                    <span className="text-sm truncate leading-tight">{t["New Session"]}</span>
                </motion.button>
            </div>
        </div>
    );
}
