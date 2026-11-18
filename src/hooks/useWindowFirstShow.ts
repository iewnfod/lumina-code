import {useEffect} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {listen} from "@tauri-apps/api/event";
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
 *
 * ALSO the close-to-tray restore hook: a hide/show cycle destroys and
 * rebuilds the wl_surface, so the native blur effect object goes inert —
 * Rust (src-tauri/src/tray.rs's show_main_window) emits
 * "lumina-window-restored" after every restore and we re-push the effect
 * here. CROSS-BOUNDARY STRING: the name mirrors WINDOW_RESTORED_EVENT in
 * tray.rs (AGENTS.md rule 8).
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
        // See the hook docs — the close-to-tray restore re-push. No-op
        // when the native path is unavailable or the preference is off.
        const unlisten = listen("lumina-window-restored", () => {
            ensureNativeBlur(peekCompositorBlurEnabled());
        }).catch((e) => {
            error(`Failed to listen lumina-window-restored: ${e}`).catch(() => {});
        });
        return () => {
            void unlisten.then((fn) => {
                if (fn) fn();
            });
        };
    }, []);
}
