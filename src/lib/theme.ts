import {foregroundFor} from "./color.ts";

/**
 * Minimal chrome theme type. lumina-terminal types this as xterm's ITheme
 * (its colors come from the active terminal); lumina-code has no terminal, so
 * only the two fields the chrome actually reads survive.
 */
export interface ChromeTheme {
    background?: string;
    foreground?: string;
}

export interface EffectiveTheme {
    theme: ChromeTheme;
    bg: string;
    fg: string;
    dark: boolean;
    /**
     * Opaque background for the content canvas, or null to keep the chrome
     * glass showing through (dark mode). Light mode rides slightly lighter
     * than the chrome so the chat reads as a page over the darker sidebar /
     * titlebar glass.
     */
    contentBg: string | null;
}

/** Neutral base colors the system theme resolves to — the same values
 *  lumina-terminal's lib/themeMode.ts forces for "dark"/"light" modes. */
const DARK_BG = "#1a1a1a";
const LIGHT_BG = "#fafafa";
const LIGHT_CONTENT_BG = "#f8f8f8";

/**
 * Resolve the whole-app theme. lumina-terminal derives this from the active
 * terminal's palette; here the system light/dark preference picks between the
 * two neutral bases, with dark as the fallback while it resolves.
 */
export function appThemeFor(systemTheme: "light" | "dark" | null): EffectiveTheme {
    const dark = systemTheme !== "light";
    const bg = dark ? DARK_BG : LIGHT_BG;
    const fg = foregroundFor(bg);
    return {
        theme: {background: bg, foreground: fg},
        bg,
        fg,
        dark,
        contentBg: dark ? null : LIGHT_CONTENT_BG,
    };
}
