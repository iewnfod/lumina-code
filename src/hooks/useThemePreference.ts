import {useSyncExternalStore} from "react";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * The user's appearance preference: follow the OS light/dark (default) or
 * pin one of the two. An app-level preference that must take effect
 * globally and instantly — a store over lib/persistedStore.ts (own
 * localStorage key; lib/persist.ts's PersistedState is rewritten
 * wholesale by the session flow and would clobber it), snapshotted via
 * useSyncExternalStore.
 */

export type ThemePreference = "system" | "light" | "dark";

const store = createPersistedStore<ThemePreference>({
    key: "lumina-code:theme",
    label: "theme preference",
    read: (raw) => (raw === "light" || raw === "dark" ? raw : "system"),
    write: (pref) => pref,
});

/** The stored preference; "system" means derive from the OS setting. */
export function useThemePreference(): ThemePreference {
    return useSyncExternalStore(store.subscribe, store.get);
}

/** Switch the preference and persist it. Never throws. */
export function setThemePreference(pref: ThemePreference): void {
    store.set(pref);
}
