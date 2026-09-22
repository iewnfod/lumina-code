import {useSyncExternalStore} from "react";
import {error as logError} from "@tauri-apps/plugin-log";

/**
 * The user's appearance preference: follow the OS light/dark (default) or
 * pin one of the two. Structured after the i18n store (hooks/i18n.tsx) —
 * an app-level preference that must take effect globally and instantly,
 * so it owns a module-level store + its own localStorage key rather than
 * riding lib/persist.ts (whose PersistedState is rewritten wholesale by
 * the session flow and would clobber it).
 */

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "lumina-code:theme";

let stored: ThemePreference = loadStored();

const listeners = new Set<() => void>();

function loadStored(): ThemePreference {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        return v === "light" || v === "dark" ? v : "system";
    } catch {
        return "system";
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The stored preference; "system" means derive from the OS setting. */
export function useThemePreference(): ThemePreference {
    return useSyncExternalStore(subscribe, () => stored);
}

/** Switch the preference and persist it. Never throws. */
export function setThemePreference(pref: ThemePreference): void {
    stored = pref;
    try {
        localStorage.setItem(STORAGE_KEY, pref);
    } catch (e) {
        logError(`Failed to persist theme preference: ${e}`).catch(() => {});
    }
    for (const listener of listeners) listener();
}
