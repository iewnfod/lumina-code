import type {CSSProperties} from "react";
import {Pin, PinOff, Search, Settings} from "lucide-react";
import type {ChromeTheme} from "../lib/theme.ts";
import {isMacOS} from "../lib/platform.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {useAlwaysOnTop} from "../hooks/useAlwaysOnTop.ts";
import {useIsWayland} from "../hooks/useIsWayland.ts";
import {useI18n} from "../hooks/i18n.tsx";
import {glassSurface} from "../lib/glass.ts";
import { info } from "@tauri-apps/plugin-log";
import IconButton from "./ui/IconButton.tsx";
import Hint from "./ui/Hint.tsx";
import RollingTitle from "./ui/RollingTitle.tsx";
import WindowControl from "./ui/WindowControls.tsx";
import {CHROME_TITLE_BAR_HEIGHT} from "../constants.ts";

/**
 * Window title bar. Ported from lumina-terminal's TitleBar (the only change:
 * the theme prop is typed as the minimal ChromeTheme instead of xterm's
 * ITheme). Layout, glass material, button order and sizing are identical.
 * The window controls themselves live in ui/WindowControls.tsx.
 */

interface PinButtonProps {
    size: number;
    hoverOverlay: string;
    activeOverlay: string;
    fg: string;
    style?: CSSProperties;
}

/** Toggles "always on top" for this window. Shared by both title-bar layouts;
 *  the per-platform sizing/radius comes in as props rather than being decided
 *  here.
 *
 *  Disabled under Wayland: tao maps `setAlwaysOnTop` to GTK's keep-above hint,
 *  which only X11 honors, so the toggle would silently do nothing. */
function PinButton({size, hoverOverlay, activeOverlay, fg, style}: PinButtonProps) {
    const t = useI18n();
    const {pinned, toggle} = useAlwaysOnTop();
    const isWayland = useIsWayland();

    const label = isWayland
        ? t["Always on top is not supported on Wayland"]
        : pinned ? t["Unpin from Top"] : t["Pin on Top"];

    return (
        <Hint label={label}>
            {/* The button is wrapped so the tooltip still opens on hover
             * when it is disabled — disabled buttons dispatch no pointer
             * events of their own. */}
            <IconButton
                size={size}
                isActive={pinned}
                hoverOverlay={hoverOverlay}
                activeOverlay={activeOverlay}
                style={{color: fg, ...style}}
                onClick={toggle}
                disabled={isWayland}
                aria-label={label}
            >
                {pinned ? <PinOff size={18} /> : <Pin size={18} />}
            </IconButton>
        </Hint>
    );
}

export default function TitleBar({
    theme,
    title,
    onOpenCommandPalette,
    onOpenSettings,
    isMaximized,
} : {
    theme: ChromeTheme | null,
    /** Active session's title, shown in the bar's left side. */
    title?: string | null,
    onOpenCommandPalette: () => void,
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
                <PinButton
                    size={28}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    fg={fg}
                />
                <IconButton
                    size={28}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg}}
                    onClick={() => { info("Command palette opened from title bar"); onOpenCommandPalette(); }}
                    aria-label={t["Command Palette"]}
                >
                    <Search size={18} />
                </IconButton>
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
                <PinButton
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    fg={fg}
                    style={{borderRadius: 0}}
                />
                <IconButton
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, borderRadius: 0}}
                    onClick={() => { info("Command palette opened from title bar"); onOpenCommandPalette(); }}
                    aria-label={t["Command Palette"]}
                >
                    <Search size={18} />
                </IconButton>
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
