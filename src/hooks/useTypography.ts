import {useSyncExternalStore} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import {
    applyTypography,
    isDefaultTypography,
    sanitizeTypography,
    type TypographySettings,
} from "../lib/typography.ts";

/**
 * Custom typography (font families + UI/code font sizes) for the General
 * settings pane. Structured after hooks/useThemePreference.ts: a
 * module-level store + its own localStorage key, snapshotted via
 * useSyncExternalStore so edits take effect globally and instantly — the
 * store applies lib/typography.ts's CSS overrides to the document root on
 * load and on every change.
 *
 * Load-order note: main.tsx imports main.css BEFORE the App tree, so the
 * @theme font stacks exist by the time this module initializes and the
 * initial apply can read them via getComputedStyle.
 */

const STORAGE_KEY = "lumina-code:typography";

let stored: TypographySettings = loadStored();

const listeners = new Set<() => void>();

function loadStored(): TypographySettings {
    let parsed: unknown = null;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        parsed = raw ? JSON.parse(raw) : null;
    } catch (e) {
        logError(`Failed to load typography settings: ${e}`).catch(() => {});
    }
    const settings = sanitizeTypography(parsed);
    applyTypography(document.documentElement, settings);
    return settings;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The active typography settings (read-only view for the settings pane). */
export function useTypography(): TypographySettings {
    return useSyncExternalStore(subscribe, () => stored);
}

/** Update typography, apply it to the document root, and persist it. */
export function setTypography(next: TypographySettings): void {
    const settings = sanitizeTypography(next);
    if (
        settings.sansFamily === stored.sansFamily &&
        settings.monoFamily === stored.monoFamily &&
        settings.uiSizePx === stored.uiSizePx &&
        settings.codeSizePx === stored.codeSizePx
    ) {
        return;
    }
    stored = settings;
    applyTypography(document.documentElement, settings);
    try {
        if (isDefaultTypography(settings)) {
            // Defaults persist as absence, so a fresh install's storage
            // stays clean and DEFAULT_* bumps propagate.
            localStorage.removeItem(STORAGE_KEY);
        } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        }
    } catch (e) {
        logError(`Failed to persist typography settings: ${e}`).catch(() => {});
    }
    logInfo(
        `Typography set: sans="${settings.sansFamily}" mono="${settings.monoFamily}" ui=${settings.uiSizePx}px code=${settings.codeSizePx}px`,
    ).catch(() => {});
    for (const listener of listeners) listener();
}
