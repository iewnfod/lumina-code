import {useSyncExternalStore} from "react";
import {info as logInfo} from "@tauri-apps/plugin-log";
import {
    applyTypography,
    isDefaultTypography,
    sanitizeTypography,
    type TypographySettings,
} from "../lib/typography.ts";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * Custom typography (font families + UI/code font sizes) for the General
 * settings pane. An app-level preference over lib/persistedStore.ts (own
 * localStorage key), snapshotted via useSyncExternalStore so edits take
 * effect globally and instantly — the store applies lib/typography.ts's
 * CSS overrides to the document root on load and on every change.
 *
 * Load-order note: main.tsx imports main.css BEFORE the App tree, so the
 * @theme font stacks exist by the time this module initializes and the
 * initial apply can read them via getComputedStyle.
 */

const store = createPersistedStore<TypographySettings>({
    key: "lumina-code:typography",
    label: "typography settings",
    read: (raw) => {
        let parsed: unknown = null;
        if (raw !== null) {
            try {
                parsed = JSON.parse(raw);
            } catch {
                parsed = null;
            }
        }
        return sanitizeTypography(parsed);
    },
    // Defaults persist as absence, so a fresh install's storage stays
    // clean and DEFAULT_* bumps propagate.
    write: (settings) => (isDefaultTypography(settings) ? null : JSON.stringify(settings)),
    eq: (a, b) =>
        a.sansFamily === b.sansFamily &&
        a.monoFamily === b.monoFamily &&
        a.uiSizePx === b.uiSizePx &&
        a.codeSizePx === b.codeSizePx,
});

// Applied at module load — before React mounts — so the first paint
// already uses the custom fonts (no default-font flash).
applyTypography(document.documentElement, store.get());

/** The active typography settings (read-only view for the settings pane). */
export function useTypography(): TypographySettings {
    return useSyncExternalStore(store.subscribe, store.get);
}

/** Update typography, apply it to the document root, and persist it. */
export function setTypography(next: TypographySettings): void {
    const settings = sanitizeTypography(next);
    if (store.set(settings)) {
        applyTypography(document.documentElement, settings);
        logInfo(
            `Typography set: sans="${settings.sansFamily}" mono="${settings.monoFamily}" ui=${settings.uiSizePx}px code=${settings.codeSizePx}px`,
        ).catch(() => {});
    }
}
