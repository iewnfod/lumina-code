import {useEffect, useState, useSyncExternalStore} from "react";
import {info as logInfo} from "@tauri-apps/plugin-log";
import {isMobileApp} from "../lib/platform.ts";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * The MOBILE app's LAYOUT mode (tablet mode): which chrome the desktop
 * tree renders with on a mobile device — the phone layout (drawer
 * sidebar, fullscreen modals, two-level settings pages, the welcome
 * cluster below the composer — mobile.css's phone adaptations) or the
 * DESKTOP layout (docked sidebar + resize seam, tab-rail settings,
 * centered modals, the standard composer toolbar; the container-query
 * tiers then do the real responsive work, exactly like a desktop
 * window).
 *
 * This is LAYOUT only — deliberately decoupled from isMobileApp(),
 * which keeps the DEVICE/connection semantics that never change with
 * the layout: the remote frp-route opencode connection
 * (useOpencode/serverConnection/useServerFrp), the system-back page
 * stack (useBackLevel/backStack/PopoverMenu), the hidden window
 * controls, the touch anti-misclick delete surfaces (SessionFolder's
 * row X → TitleBar's ⋯ menu), the soft-keyboard focus guard and the
 * touch-sized composer min-height. Consumers split along that line:
 * layout branches read usePhoneLayout(), device/connection branches
 * keep isMobileApp().
 *
 * Three modes, persisted over lib/persistedStore.ts (the
 * useStatsPanelMode store pattern): "auto" (default) resolves by the
 * Material window-size breakpoint — shortest side >= 600px counts as
 * tablet-class (in the WebView CSS px ≈ dp: phones sit ~410, a 7"
 * tablet 600, a 10" 800, a foldable OPENED ~674 — which lands on the
 * desktop layout exactly when its screen real estate appears);
 * "phone" / "desktop" pin the layout regardless of size. Only "auto"
 * tracks viewport changes (rotation, fold/unfold, split screen) — a
 * pinned mode is stable by contract, the user chose it.
 */

export type MobileLayoutMode = "auto" | "phone" | "desktop";

/** The layout an "auto" mode resolves to for the CURRENT viewport. */
export type ResolvedLayout = "phone" | "desktop";

const store = createPersistedStore<MobileLayoutMode>({
    key: "lumina-code:mobile-layout",
    label: "mobile layout mode",
    // Absent / unknown values read as the "auto" default.
    read: (raw) => (raw === "phone" || raw === "desktop" ? raw : "auto"),
    write: (mode) => mode,
});

/** The stored layout mode; consumed by the General settings row. */
export function useMobileLayoutMode(): MobileLayoutMode {
    return useSyncExternalStore(store.subscribe, store.get);
}

/** Pin the layout mode and persist it. Never throws. */
export function setMobileLayoutMode(mode: MobileLayoutMode): void {
    if (store.set(mode)) {
        logInfo(`Mobile layout mode set to ${mode}`).catch(() => {});
    }
}

/**
 * The "auto" resolution: tablet-class viewport → the desktop layout.
 * Pure (over the current viewport); kept exported so the breakpoint
 * stays a named, single place.
 */
export function autoResolvedLayout(): ResolvedLayout {
    if (typeof window === "undefined") return "phone";
    return Math.min(window.innerWidth, window.innerHeight) >= 600 ? "desktop" : "phone";
}

/**
 * Whether the app currently renders in the PHONE layout. The one
 * binding every layout branch reads: false everywhere except the
 * mobile app with the layout resolved to "phone" (a pinned "desktop"
 * = tablet mode; "auto" follows the viewport, tracked ONLY in auto —
 * a pinned mode re-renders through the store, not the resize event).
 */
export function usePhoneLayout(): boolean {
    const mode = useMobileLayoutMode();
    const mobile = isMobileApp();
    const trackAuto = mobile && mode === "auto";
    const [autoLayout, setAutoLayout] = useState<ResolvedLayout>(autoResolvedLayout);
    useEffect(() => {
        if (!trackAuto) return;
        const onChange = () => setAutoLayout(autoResolvedLayout());
        window.addEventListener("resize", onChange);
        // Re-sync once when auto tracking (re)arms — the stashed value
        // may predate the switch back from a pinned mode.
        setAutoLayout(autoResolvedLayout());
        return () => window.removeEventListener("resize", onChange);
    }, [trackAuto]);
    if (!mobile) return false;
    if (mode === "auto") return autoLayout === "phone";
    return mode === "phone";
}
