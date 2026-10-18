import {Ellipsis, GitBranch, Menu, Settings, Trash2} from "lucide-react";
import type {ChromeTheme} from "../lib/theme.ts";
import {isMacOS, isMobileApp} from "../lib/platform.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {useCompositorBlurActive} from "../hooks/useBlurMyShell.ts";
import {useI18n} from "../hooks/i18n.tsx";
import {glassSurface} from "../lib/glass.ts";
import { info } from "@tauri-apps/plugin-log";
import IconButton from "./ui/IconButton.tsx";
import PopoverMenu, {MenuItem} from "./ui/PopoverMenu.tsx";
import RollingTitle from "./ui/RollingTitle.tsx";
import WindowControl from "./ui/WindowControls.tsx";
import {CHROME_TITLE_BAR_HEIGHT} from "../constants.ts";

/**
 * Window title bar. Ported from lumina-terminal's TitleBar (the only change:
 * the theme prop is typed as the minimal ChromeTheme instead of xterm's
 * ITheme). Layout, glass material, button order and sizing are identical.
 * The window controls themselves live in ui/WindowControls.tsx.
 */

export default function TitleBar({
    theme,
    title,
    branch,
    onOpenSettings,
    isMaximized,
    onMenu,
    onDeleteSession,
} : {
    theme: ChromeTheme | null,
    /** Active session's title, shown in the bar's left side. */
    title?: string | null,
    /** Active session's git branch (null/absent = no repo, chip hidden).
     *  Managed-worktree sessions show their pinned branch; detached
     *  main-repo HEADs show the abbreviated sha (useDirectoryBranch). */
    branch?: string | null,
    /** Opens the settings modal (General / Model / About tabs). */
    onOpenSettings: () => void,
    isMaximized: boolean,
    /** The MOBILE drawer toggle (hamburger in the bar's left side);
     *  absent on the desktop, where the sidebar is always docked. */
    onMenu?: () => void,
    /** Delete the ACTIVE session (MOBILE only): App passes it on a phone
     *  while a session is open, and the bar shows a ⋯ menu with the
     *  delete action. Relocated here from the sidebar rows because the
     *  row's hover-revealed X is a touch trap — a finger press first
     *  synthesizes hover (revealing the X mid-tap), so the tap that
     *  meant to OPEN the session lands on the revealed delete button.
     *  Absent on desktop, where the row X stays. */
    onDeleteSession?: () => void,
}) {
    const t = useI18n();
    const bg = theme?.background ?? "black";
    const fg = theme?.foreground ?? "white";

    const {hoverOverlay, activeOverlay} = useSurfaceColors(bg);
    const {supportsGlass} = useGlass();
    const compositorBlur = useCompositorBlurActive();
    const glass = glassSurface(bg, supportsGlass, {blurPx: 14, compositorBlur});
    const size = CHROME_TITLE_BAR_HEIGHT;
    // Brand cinnabar wash for the close button hover — the brand accent so
    // window controls feel part of the app identity.
    const closeHover = "rgba(255,70,31,0.18)";

    if (isMacOS()) {
        return (
            <div
                data-tauri-drag-region
                className="w-full flex flex-row items-center select-none shrink-0"
                style={{
                    height: size,
                    ...glass,
                    color: fg,
                }}
            >
                <div className="relative flex-1 min-w-0 flex items-center self-stretch overflow-hidden" data-tauri-drag-region>
                    <RollingTitle text={title} className="px-2 text-sm font-medium truncate" style={{color: fg}}/>
                </div>
                {branch && (
                    <TitleBranchChip branch={branch} fg={fg}/>
                )}
                <IconButton
                    size={28}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, marginRight: 8}}
                    onClick={() => { info("Settings opened from title bar"); onOpenSettings(); }}
                    aria-label={t["Settings"]}
                >
                    <Settings size={18} />
                </IconButton>
            </div>
        );
    }

    return (
        <div
            data-tauri-drag-region
            // relative z-50 hoists the bar's PAINT level above the content
            // area: the glass material's backdrop-filter (live wherever
            // supportsGlass is true — Android/macOS/Windows) makes this
            // element a STACKING CONTEXT, so a downward-opening PopoverMenu
            // panel (the mobile ⋯ menu) would be trapped inside it while
            // the flex-1 content sibling (relative, later in DOM, carrying
            // MaskedSurface z:1) paints OVER the hanging panel — the menu
            // opens but stays invisible. z-50 beats the content's root-level
            // layers while staying under the drawer scrim (z-60) and modals
            // (z:9000, body portal). The bar's own pixels never overlap the
            // content, so this changes nothing visually except the panel.
            className="relative z-50 w-full flex flex-row items-center justify-between select-none shrink-0"
            style={{
                height: size,
                ...glass,
                color: fg,
            }}
        >
            <div className="relative flex-1 min-w-0 flex items-center self-stretch overflow-hidden" data-tauri-drag-region>
                {onMenu && (
                    <IconButton
                        size={size - 8}
                        hoverOverlay={hoverOverlay}
                        activeOverlay={activeOverlay}
                        style={{color: fg, marginLeft: 4, flexShrink: 0}}
                        onClick={onMenu}
                        aria-label={t["Sessions"]}
                    >
                        <Menu size={18}/>
                    </IconButton>
                )}
                <RollingTitle text={title} className="pl-3 pr-2 text-sm font-medium truncate" style={{color: fg}}/>
            </div>
            <div className="flex flex-row items-center h-full">
                {branch && (
                    <TitleBranchChip branch={branch} fg={fg}/>
                )}
                {/* MOBILE session menu (⋯): the delete entry's new home —
                 * see onDeleteSession's doc note. PopoverMenu opens DOWN
                 * from the bar (a title-bar menu, like the composer's
                 * upward menus are bottom-anchored); the trigger keeps the
                 * gear's exact geometry (36px, square) so the bar reads as
                 * one cluster. */}
                {onDeleteSession && (
                    <PopoverMenu
                        direction="down"
                        align="end"
                        trigger={({open, toggle}) => (
                            <IconButton
                                size={size}
                                isActive={open}
                                hoverOverlay={hoverOverlay}
                                activeOverlay={activeOverlay}
                                style={{color: fg, borderRadius: 0}}
                                onClick={toggle}
                                aria-label={t["Delete session"]}
                            >
                                <Ellipsis size={18}/>
                            </IconButton>
                        )}
                    >
                        {(close) => (
                            <MenuItem
                                danger
                                onClick={() => {
                                    info("Session delete requested from title bar").catch(() => {});
                                    close();
                                    onDeleteSession();
                                }}
                            >
                                <span className="flex items-center gap-2">
                                    <Trash2 size={13} className="shrink-0"/>
                                    {t["Delete session"]}
                                </span>
                            </MenuItem>
                        )}
                    </PopoverMenu>
                )}
                <IconButton
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, borderRadius: 0}}
                    onClick={() => { info("Settings opened from title bar"); onOpenSettings(); }}
                    aria-label={t["Settings"]}
                >
                    <Settings size={18} />
                </IconButton>
                {!isMobileApp() && (
                    <WindowControl size={size} isMaximized={isMaximized} hoverOverlay={hoverOverlay} activeOverlay={activeOverlay} closeHover={closeHover} fg={fg} />
                )}
            </div>
        </div>
    );
}

/** The bar's quiet branch readout (right cluster, before the settings
 *  button): icon + name, non-interactive display — switching branches is
 *  not a title-bar action (branch-bound sessions are chosen per session
 *  in the composer's project picker). */
function TitleBranchChip({branch, fg}: {branch: string; fg: string}) {
    return (
        <span
            className="flex flex-row items-center gap-1 min-w-0 shrink px-2 select-none"
            style={{color: fg, opacity: 0.7}}
        >
            <GitBranch size={12} className="shrink-0"/>
            <span className="text-xs truncate">{branch}</span>
        </span>
    );
}
