import {useSyncExternalStore} from "react";
import {info as logInfo} from "@tauri-apps/plugin-log";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * Whether the Linux window outline (the 1px inset box-shadow App draws so
 * the borderless window has a visible edge on DEs without compositor
 * shadows) is enabled. An app-level preference over
 * lib/persistedStore.ts (own localStorage key), snapshotted via
 * useSyncExternalStore so the toggle takes effect instantly. Default on
 * (absent key); the settings row only shows on Linux (App.tsx gates the
 * outline itself on isLinux() regardless).
 */

const store = createPersistedStore<boolean>({
    key: "lumina-code:window-outline",
    label: "window outline preference",
    // Absent key = default on; only an explicit "false" disables.
    read: (raw) => raw !== "false",
    write: (enabled) => String(enabled),
});

/** The stored outline preference; consumed by App's outline overlay. */
export function useWindowOutline(): boolean {
    return useSyncExternalStore(store.subscribe, store.get);
}

/** Toggle the outline and persist it. Never throws. */
export function setWindowOutline(enabled: boolean): void {
    if (store.set(enabled)) {
        logInfo(`Window outline ${enabled ? "enabled" : "disabled"}`).catch(() => {});
    }
}
