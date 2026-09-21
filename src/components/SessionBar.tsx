import {type CSSProperties} from "react";
import {motion} from "framer-motion";
import {MessageSquare, Plus, X} from "lucide-react";
import Icon from "../assets/icon.svg";
import {isMacOS} from "../lib/platform.ts";
import {CHROME_TITLE_BAR_HEIGHT} from "../constants.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {glassSurface} from "../lib/glass.ts";
import {springSoft, whileHoverTap} from "../lib/motion.ts";
import {useI18n} from "../hooks/i18n.tsx";

/**
 * The app's sidebar — a vertical session list. Ported from lumina-terminal's
 * TabBar with the terminal-only machinery stripped (tab tear-off/reorder drag
 * controller, shell/app icons, update banner, privileged-command dot); the
 * layout, glass material, row anatomy and motion are identical.
 */

export interface SessionInfo {
    id: string;
    name: string;
    /** Optional small subtitle shown under the title (e.g. working directory). */
    subtitle?: string;
}

interface SessionBarProps {
    sessions: SessionInfo[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onNew: () => void;
    backgroundColor: string;
    foregroundColor: string;
    collapsed: boolean;
    /** Brand text shown in the sidebar's top-left. Falls back to "Lumina". */
    brandTitle?: string;
    /** OpenCode connection indicator shown above the New Session button. */
    connection?: ConnectionState;
}

export interface ConnectionState {
    state: "connecting" | "connected" | "error";
    label: string;
    /** Full text for the tooltip (defaults to the label). */
    detail?: string;
}

/** Indicator dot color per connection state — semantic, brand-adjacent. */
const CONNECTION_DOT: Record<ConnectionState["state"], string> = {
    connecting: "#f59e0b",
    connected: "#22c55e",
    error: "#ef4444",
};

export default function SessionBar(props: SessionBarProps) {
    const {sessions, activeId, onSelect, onClose, onNew, backgroundColor, foregroundColor, collapsed, brandTitle, connection} = props;
    const t = useI18n();

    const colors = useSurfaceColors(backgroundColor);
    const {supportsGlass} = useGlass();

    // The sidebar wears the glass material over the content canvas. On
    // platforms where backdrop-filter is unreliable (Linux/Wayland), this
    // falls back to an opaque derived surface — same visual role, no blur.
    const glass = glassSurface(backgroundColor, supportsGlass, {blurPx: 16});

    return (
        <div
            className="flex flex-col h-full select-none transition-[width,min-width,opacity] duration-[var(--duration-slow)] ease-[var(--ease-spring)] overflow-hidden"
            style={{
                width: collapsed ? 0 : 180,
                minWidth: collapsed ? 0 : 180,
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
                {sessions.map((session) => {
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
                                className={`lum-session-row group relative flex flex-row items-center justify-between px-3 py-2.5 rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-base)] ease-[var(--duration-glass)] hover:bg-[var(--lum-session-hover)] ${isActive ? "bg-[var(--lum-session-active)]" : ""}`}
                                style={{
                                    "--lum-session-hover": isActive ? colors.accentOverlay : colors.hoverOverlay,
                                    "--lum-session-active": colors.accentOverlay,
                                } as CSSProperties}
                                onClick={() => onSelect(session.id)}
                            >
                                <div className="flex flex-col items-start flex-1 w-[70%] overflow-hidden">
                                    <div className="flex items-start gap-2 w-full">
                                        <MessageSquare size={14} className="shrink-0 mt-0.5" />
                                        <div className="flex flex-col min-w-0">
                                            <span
                                                className="text-sm truncate leading-tight"
                                                style={{
                                                    color: isActive ? foregroundColor : colors.inactiveText,
                                                }}
                                            >
                                                {session.name}
                                            </span>
                                        </div>
                                    </div>
                                    {session.subtitle && (
                                        <div
                                            className="text-xs leading-tight flex items-center gap-1.5 min-w-0 overflow-hidden max-w-full"
                                            style={{
                                                color: colors.inactiveText,
                                                opacity: 0.6,
                                            }}
                                        >
                                            <span className="truncate min-w-0 w-full">{session.subtitle}</span>
                                        </div>
                                    )}
                                </div>
                                <button
                                    className={`lum-session-close cursor-pointer opacity-0 rounded-[var(--radius-xs)] p-1 shrink-0 transition-all duration-[var(--duration-fast)] ml-1 group-hover:opacity-100 hover:bg-[var(--lum-session-active)]`}
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
                            </motion.div>
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
                <motion.button
                    {...whileHoverTap}
                    className="lum-session-new flex flex-row items-center gap-2 w-full px-3 py-2.5 mt-1 transition-colors duration-[var(--duration-fast)] cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--lum-new-hover)]"
                    style={{
                        "--lum-new-hover": colors.hoverOverlay,
                        color: colors.inactiveText,
                    } as CSSProperties}
                    onClick={onNew}
                >
                    <Plus size={16} />
                    <div className="flex flex-col w-full justify-start items-start">
                        <span className="text-sm">{t["New Session"]}</span>
                    </div>
                </motion.button>
            </div>
        </div>
    );
}
