import {useSyncExternalStore} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";

/**
 * Whether the Linux window outline (the 1px inset box-shadow App draws so
 * the borderless window has a visible edge on DEs without compositor
 * shadows) is enabled. Structured after hooks/useThemePreference.ts: an
 * app-level preference with a module-level store + its own localStorage
 * key, snapshotted via useSyncExternalStore so the toggle takes effect
 * instantly. Default on; the row only shows on Linux (App.tsx gates the
 * outline itself on isLinux() regardless).
 */

const STORAGE_KEY = "lumina-code:window-outline";

let stored = loadStored();

const listeners = new Set<() => void>();

function loadStored(): boolean {
    try {
        // Absent key = default on; only an explicit "false" disables.
        return localStorage.getItem(STORAGE_KEY) !== "false";
    } catch {
        return true;
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The stored outline preference; consumed by App's outline overlay. */
export function useWindowOutline(): boolean {
    return useSyncExternalStore(subscribe, () => stored);
}

/** Toggle the outline and persist it. Never throws. */
export function setWindowOutline(enabled: boolean): void {
    if (stored === enabled) return;
    stored = enabled;
    try {
        localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch (e) {
        logError(`Failed to persist window outline preference: ${e}`).catch(() => {});
    }
    logInfo(`Window outline ${enabled ? "enabled" : "disabled"}`).catch(() => {});
    for (const listener of listeners) listener();
}
