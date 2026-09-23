import {useSyncExternalStore} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";

/**
 * The session-activity panel's expansion mode: "auto" — the card mounts
 * collapsed and outside clicks / Escape collapse it; "always" — the panel
 * mounts expanded and outside interaction never collapses it (a manual
 * collapse lasts until the card remounts, i.e. a session switch).
 * Structured after hooks/useWindowOutline.ts: an app-level preference
 * with a module-level store + its own localStorage key, snapshotted via
 * useSyncExternalStore so a change takes effect instantly.
 */

export type StatsPanelMode = "auto" | "always";

const STORAGE_KEY = "lumina-code:stats-auto-collapse";

let stored = loadStored();

const listeners = new Set<() => void>();

function loadStored(): StatsPanelMode {
    try {
        // Legacy values from the boolean switch this replaced: "false"
        // (the old persistent side pane) maps to "always" — the nearest
        // intent; "true" or absent → the "auto" default.
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === "always" || raw === "false") return "always";
        return "auto";
    } catch {
        return "auto";
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The stored panel mode; consumed by SessionStatsCard. */
export function useStatsPanelMode(): StatsPanelMode {
    return useSyncExternalStore(subscribe, () => stored);
}

/** Set the panel mode and persist it. Never throws. */
export function setStatsPanelMode(mode: StatsPanelMode): void {
    if (stored === mode) return;
    stored = mode;
    try {
        localStorage.setItem(STORAGE_KEY, mode);
    } catch (e) {
        logError(`Failed to persist stats panel mode: ${e}`).catch(() => {});
    }
    logInfo(`Stats panel mode set to ${mode}`).catch(() => {});
    for (const listener of listeners) listener();
}
