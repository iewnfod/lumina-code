import {Settings} from "lucide-react";
import type {ChromeTheme} from "../lib/theme.ts";
import {isMacOS} from "../lib/platform.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {useI18n} from "../hooks/i18n.tsx";
import {glassSurface} from "../lib/glass.ts";
import { info } from "@tauri-apps/plugin-log";
import IconButton from "./ui/IconButton.tsx";
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
    onOpenSettings,
    isMaximized,
} : {
    theme: ChromeTheme | null,
    /** Active session's title, shown in the bar's left side. */
    title?: string | null,
    /** Opens the settings modal (General / Model / About tabs). */
    onOpenSettings: () => void,
    isMaximized: boolean,
}) {
    const t = useI18n();
    const bg = theme?.background ?? "black";
    const fg = theme?.foreground ?? "white";

    const {hoverOverlay, activeOverlay} = useSurfaceColors(bg);
    const {supportsGlass} = useGlass();
    const glass = glassSurface(bg, supportsGlass, {blurPx: 14});
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
            className="w-full flex flex-row items-center justify-between select-none shrink-0"
            style={{
                height: size,
                ...glass,
                color: fg,
            }}
        >
            <div className="relative flex-1 min-w-0 flex items-center self-stretch overflow-hidden" data-tauri-drag-region>
                <RollingTitle text={title} className="pl-3 pr-2 text-sm font-medium truncate" style={{color: fg}}/>
            </div>
            <div className="flex flex-row items-center h-full">
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
                <WindowControl size={size} isMaximized={isMaximized} hoverOverlay={hoverOverlay} activeOverlay={activeOverlay} closeHover={closeHover} fg={fg} />
            </div>
        </div>
    );
}
