import {useSyncExternalStore} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";

/**
 * Whether the session-activity panel auto-collapses on outside clicks and
 * Escape. Structured after hooks/useWindowOutline.ts: an app-level
 * preference with a module-level store + its own localStorage key,
 * snapshotted via useSyncExternalStore so the toggle takes effect
 * instantly. Default on (the historical behavior); turning it off keeps
 * the panel open until collapsed with its own button — a persistent
 * side-pane mode.
 */

const STORAGE_KEY = "lumina-code:stats-auto-collapse";

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

/** The stored auto-collapse preference; consumed by SessionStatsCard. */
export function useStatsAutoCollapse(): boolean {
    return useSyncExternalStore(subscribe, () => stored);
}

/** Toggle auto-collapse and persist it. Never throws. */
export function setStatsAutoCollapse(enabled: boolean): void {
    if (stored === enabled) return;
    stored = enabled;
    try {
        localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch (e) {
        logError(`Failed to persist stats auto-collapse preference: ${e}`).catch(() => {});
    }
    logInfo(`Stats auto-collapse ${enabled ? "enabled" : "disabled"}`).catch(() => {});
    for (const listener of listeners) listener();
}
