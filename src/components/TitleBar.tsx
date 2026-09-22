import type {CSSProperties} from "react";
import {Pin, PinOff, Search, Settings} from "lucide-react";
import {Tooltip} from "@heroui/react";
import type {ChromeTheme} from "../lib/theme.ts";
import {isMacOS} from "../lib/platform.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {useGlass} from "../hooks/useGlass.ts";
import {useAlwaysOnTop} from "../hooks/useAlwaysOnTop.ts";
import {useIsWayland} from "../hooks/useIsWayland.ts";
import {useI18n, setLanguage, currentLanguage, type Language} from "../hooks/i18n.tsx";
import {glassSurface} from "../lib/glass.ts";
import { info } from "@tauri-apps/plugin-log";
import type {SurfaceColors} from "../hooks/surfaceColors.ts";
import IconButton from "./ui/IconButton.tsx";
import PopoverMenu, {MenuItem, MenuLabel} from "./ui/PopoverMenu.tsx";
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
        <Tooltip delay={300} closeDelay={0}>
            <Tooltip.Trigger>
                {/* The button is wrapped so the tooltip still opens on hover
                    when it is disabled — disabled buttons dispatch no pointer
                    events of their own. */}
                <span className="inline-flex">
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
                </span>
            </Tooltip.Trigger>
            <Tooltip.Content>
                <p className="text-xs">{label}</p>
            </Tooltip.Content>
        </Tooltip>
    );
}

interface SettingsMenuProps {
    size: number;
    hoverOverlay: string;
    activeOverlay: string;
    colors: SurfaceColors;
    fg: string;
    style?: CSSProperties;
}

/** Language switcher on the settings button — the first (and, until a real
 *  settings panel lands, only) entry in it. Language names stay in their
 *  own language regardless of the active one. */
function SettingsMenu({size, hoverOverlay, activeOverlay, colors, fg, style}: SettingsMenuProps) {
    const t = useI18n();
    const active = currentLanguage();

    const item = (lang: Language | null, label: string, close: () => void) => (
        <MenuItem
            key={lang ?? "system"}
            colors={colors}
            selected={active === lang}
            onClick={() => {
                info(`Language set to ${lang ?? "system"} from title bar`);
                setLanguage(lang);
                close();
            }}
        >
            {lang === null ? t["Follow System"] : label}
        </MenuItem>
    );

    return (
        <PopoverMenu
            colors={colors}
            align="end"
            direction="down"
            trigger={({toggle}) => (
                <IconButton
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    style={{color: fg, ...style}}
                    onClick={() => { info("Settings menu opened from title bar"); toggle(); }}
                    aria-label={t["Language"]}
                >
                    <Settings size={18} />
                </IconButton>
            )}
        >
            {(close) => (
                <>
                    <MenuLabel>{t["Language"]}</MenuLabel>
                    {item(null, "", close)}
                    {item("en-us", "English", close)}
                    {item("zh-cn", "简体中文", close)}
                </>
            )}
        </PopoverMenu>
    );
}

export default function TitleBar({
    theme,
    title,
    onOpenCommandPalette,
    isMaximized,
} : {
    theme: ChromeTheme | null,
    /** Active session's title, shown in the bar's left side. */
    title?: string | null,
    onOpenCommandPalette: () => void,
    isMaximized: boolean,
}) {
    const t = useI18n();
    const bg = theme?.background ?? "black";
    const fg = theme?.foreground ?? "white";

    const surface = useSurfaceColors(bg);
    const { hoverOverlay, activeOverlay } = surface;
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
                <SettingsMenu
                    size={28}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    colors={surface}
                    fg={fg}
                    style={{marginRight: 8}}
                />
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
                <SettingsMenu
                    size={size}
                    hoverOverlay={hoverOverlay}
                    activeOverlay={activeOverlay}
                    colors={surface}
                    fg={fg}
                    style={{borderRadius: 0}}
                />
                <WindowControl size={size} isMaximized={isMaximized} hoverOverlay={hoverOverlay} activeOverlay={activeOverlay} closeHover={closeHover} fg={fg} />
            </div>
        </div>
    );
}
