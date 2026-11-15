import {useEffect} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {error} from "@tauri-apps/plugin-log";
import {
    ensureNativeBlur,
    peekCompositorBlurEnabled,
    probeBms,
    probeNativeBlur,
} from "./useBlurMyShell.ts";

/**
 * The window is created hidden (tauri.conf.json `visible: false`) and
 * shown once the first paint is ready — same pattern as lumina-terminal.
 * Both blur probes run BEFORE the show so a blur-capable system
 * (native ext-background-effect-v1, or the Blur my Shell fallback)
 * paints its first visible frame already translucent (no
 * opaque→translucent flash); the race caps the wait so a stuck probe
 * can never keep the window hidden, and a failed probe degrades to
 * the opaque fallback. Extracted from App.tsx's InnerApp.
 */
export function useWindowFirstShow(): void {
    useEffect(() => {
        const win = getCurrentWindow();
        const ready = Promise.race([
            Promise.all([probeBms(), probeNativeBlur()]),
            new Promise<void>((resolve) => {
                setTimeout(resolve, 400);
            }),
        ]);
        ready.then(() => {
            win.show().then(() => {
                win.setFocus().catch(() => {});
                // The native effect can only be applied once the
                // window is MAPPED (the wl_surface does not exist
                // before that) — right after show() is the earliest
                // moment. No-op when the native path is unavailable
                // or the preference is off.
                ensureNativeBlur(peekCompositorBlurEnabled());
            }).catch((e) => {
                error(`Failed to show window: ${e}`).catch(() => {});
            });
        });
    }, []);
}
