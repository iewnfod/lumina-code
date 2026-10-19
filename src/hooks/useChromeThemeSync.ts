import {useEffect} from "react";
import {glassSurfaceEquivalent} from "../lib/glass.ts";

/**
 * The chrome's theme-facing side effects, extracted from App.tsx's
 * InnerApp:
 * 1. Sync the HeroUI light/dark class on <html> with the resolved
 *    theme so framework controls (tooltips, …) match the chrome.
 * 2. MOBILE ONLY — push the resolved chrome base to the Android shell.
 *    The edge-to-edge safe-area bands are painted by the native window
 *    background, which follows the SYSTEM theme (static resource) while
 *    the app chrome follows the in-app preference — the bridge exists
 *    only in the Android webview (MainActivity's onWebViewCreate
 *    injects window.__luminaNative); desktop/CEF have no such object
 *    and the call is a no-op. The pushed value is NOT effectiveBg but
 *    its GLASS-SURFACE EQUIVALENT (lib/glass.ts): the chrome the bands
 *    sit next to (title bar / chrome glass layer) renders as the glass
 *    tint over the base, so the opaque band must match that composite,
 *    not the raw base — pushing the base read as too-dark on dark /
 *    too-light on light. The static lumina_window_bg resources mirror
 *    the same derivation. systemTheme rides the deps so a system
 *    day/night switch re-pushes even when the resolved base doesn't
 *    change — MainActivity's onConfigurationChanged resets the native
 *    background to the system color, and a manual preference override
 *    must re-win right after.
 */
export function useChromeThemeSync(
    effectiveBg: string,
    dark: boolean,
    systemTheme: "light" | "dark" | null,
): void {
    useEffect(() => {
        const root = document.documentElement;
        root.classList.toggle("dark", dark);
        root.classList.toggle("light", !dark);
        root.setAttribute("data-theme", dark ? "dark" : "light");
    }, [dark]);

    useEffect(() => {
        (window as unknown as {__luminaNative?: {setChromeBackground: (colorHex: string, dark: boolean) => void}}).__luminaNative?.setChromeBackground(glassSurfaceEquivalent(effectiveBg), dark);
    }, [effectiveBg, dark, systemTheme]);
}
