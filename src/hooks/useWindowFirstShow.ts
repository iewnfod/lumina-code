import {useEffect} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {error} from "@tauri-apps/plugin-log";
import {probeBms} from "./useBlurMyShell.ts";

/**
 * The window is created hidden (tauri.conf.json `visible: false`) and
 * shown once the first paint is ready — same pattern as lumina-terminal.
 * The Blur my Shell probe runs BEFORE the show so a BMS-enabled system
 * paints its first visible frame already translucent (no
 * opaque→translucent flash); the race caps the wait so a stuck
 * gsettings can never keep the window hidden, and a failed probe
 * degrades to the opaque fallback. Extracted from App.tsx's InnerApp.
 */
export function useWindowFirstShow(): void {
    useEffect(() => {
        const win = getCurrentWindow();
        const ready = Promise.race([
            probeBms(),
            new Promise<void>((resolve) => {
                setTimeout(resolve, 400);
            }),
        ]);
        ready.then(() => {
            win.show().then(() => {
                win.setFocus().catch(() => {});
            }).catch((e) => {
                error(`Failed to show window: ${e}`).catch(() => {});
            });
        });
    }, []);
}
