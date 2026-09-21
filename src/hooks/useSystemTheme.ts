import {useEffect, useState} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {error} from "@tauri-apps/plugin-log";

/**
 * The OS light/dark preference, kept live as it changes.
 * Ported as-is from lumina-terminal.
 *
 * Returns `"light"` / `"dark"`, or `null` before the first read resolves.
 * Module-level cached + shared across callers, and refreshed by a single
 * `onThemeChanged` subscription so N components don't each open a listener.
 */
type SystemTheme = "light" | "dark" | null;

let cached: SystemTheme = null;
let initialized = false;
const subscribers = new Set<(t: Exclude<SystemTheme, null>) => void>();

async function readTheme(): Promise<Exclude<SystemTheme, null>> {
    try {
        const t = await getCurrentWindow().theme();
        // Tauri returns null when the window follows the system but the system
        // preference is unknown; treat that as dark.
        return t === "light" ? "light" : "dark";
    } catch (e) {
        error(`Failed to read system theme: ${e}`).catch(() => {});
        return "dark";
    }
}

/** Ensure the initial read + change listener are set up exactly once. */
function ensureInit() {
    if (initialized) return;
    initialized = true;
    readTheme().then((t) => {
        cached = t;
        for (const sub of subscribers) sub(t);
    });
    getCurrentWindow().onThemeChanged(({payload: t}) => {
        const next: Exclude<SystemTheme, null> = t === "light" ? "light" : "dark";
        cached = next;
        for (const sub of subscribers) sub(next);
    }).catch((e) => {
        error(`Failed to listen for system theme changes: ${e}`).catch(() => {});
    });
}

export function useSystemTheme(): SystemTheme {
    const [theme, setTheme] = useState<SystemTheme>(cached);

    useEffect(() => {
        ensureInit();
        // If the cache already had a value different from our initial state
        // (rare race), sync up.
        if (cached !== theme) setTheme(cached);
        const sub = (t: Exclude<SystemTheme, null>) => setTheme(t);
        subscribers.add(sub);
        return () => {
            subscribers.delete(sub);
        };
    }, []);

    return theme;
}
