import {useEffect, useState} from "react";
import {isLinux} from "../lib/platform.ts";
import {useIsWayland} from "./useIsWayland.ts";

/**
 * Platform capability probe for the glass (backdrop-filter) material.
 * Ported as-is from lumina-terminal.
 *
 * `backdrop-filter` is unreliable on WebKitGTK under several Linux/Wayland
 * compositors (it can render as a solid black smear instead of a blur). We
 * therefore treat the glass material as opt-in: enabled on macOS and Windows,
 * disabled on Linux (where WebKitGTK is the Tauri webview). Within a platform
 * the capability never changes during a run, so the result is computed once
 * and cached module-side.
 *
 * When `supportsGlass` is false, `glassSurface` falls back to an opaque
 * `adjustColor(bg)` surface, so the chrome still reads correctly.
 */

let cached: boolean | null = null;

function computeSupportsGlass(): boolean {
    if (cached !== null) return cached;
    // Linux uses WebKitGTK, whose backdrop-filter support varies by
    // compositor/version and frequently produces a black smear. Disable the
    // material there and rely on the opaque fallback. macOS (WKWebView) and
    // Windows (WebView2) both implement backdrop-filter reliably.
    cached = !isLinux();
    return cached;
}

export interface GlassCapability {
    /** True when backdrop-filter may be used on this platform. */
    supportsGlass: boolean;
    /** Blur radius to apply. Returned so consumers have a single object to
     *  destructure. */
    blurPx: number;
    /** Resolved — the Wayland probe has settled (we always have a synchronous
     *  fallback, so this is mostly informational). */
    isResolved: boolean;
}

export function useGlass(): GlassCapability {
    const isWayland = useIsWayland();
    // Synchronous initial answer so first paint is never glass-then-flash.
    const [supportsGlass, setSupportsGlass] = useState<boolean>(computeSupportsGlass());

    useEffect(() => {
        // Wayland is the riskiest case even within already-disabled Linux; if
        // the probe flips, re-affirm the cached value.
        if (isWayland && supportsGlass) {
            setSupportsGlass(false);
        }
    }, [isWayland, supportsGlass]);

    return {
        supportsGlass,
        blurPx: 16,
        isResolved: !isWayland || supportsGlass === false,
    };
}
