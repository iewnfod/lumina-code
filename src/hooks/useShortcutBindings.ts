import {useSyncExternalStore} from "react";
import {warn} from "@tauri-apps/plugin-log";
import {
    isBindableChord,
    sanitizeCustomBindings,
    type ShortcutAction,
} from "../lib/shortcuts.ts";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * Custom shortcut OVERRIDES, persisted over lib/persistedStore.ts (the
 * useSidebarWidth pattern). The store holds ONLY overrides — an action
 * absent here uses its registry default (lib/shortcuts.ts) — so default
 * bumps propagate with the app and a fresh install's storage stays clean.
 *
 * The effective map is always resolveBindings(overrides) — consumers
 * should not hand-merge defaults themselves.
 */

/** Two override maps are equal when they serialize identically (set()
 * always rebuilds by key spread, so member order is stable). */
function sameOverrides(
    a: Partial<Record<ShortcutAction, string>>,
    b: Partial<Record<ShortcutAction, string>>,
): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

const store = createPersistedStore<Partial<Record<ShortcutAction, string>>>({
    key: "lumina-code:shortcut-bindings",
    label: "shortcut bindings",
    // Never throws: unknown actions / malformed chords drop out, leaving
    // defaults in effect (hand-edited state file, older future shapes).
    read: (raw) => {
        if (raw === null) return {};
        try {
            return sanitizeCustomBindings(JSON.parse(raw));
        } catch {
            return {};
        }
    },
    // Absence semantics: an empty override map persists as no key at all.
    write: (overrides) => {
        const keys = Object.keys(overrides);
        if (keys.length === 0) return null;
        return JSON.stringify(overrides);
    },
    eq: sameOverrides,
});

/** The user's overrides (NOT merged with defaults). Settings pane rows
 *  compare against SHORTCUTS defaults to detect customization. */
export function useShortcutBindings(): Partial<Record<ShortcutAction, string>> {
    return useSyncExternalStore(store.subscribe, store.get);
}

/** Synchronous read for non-React sites. */
export function getShortcutBindings(): Partial<Record<ShortcutAction, string>> {
    return store.get();
}

/** Bind one action (a validated chord) or restore its default (null).
 *  Refuses non-bindable chords (the pane validates too, but the store is
 *  the last line — a bug there must not shadow typing keys). */
export function setShortcutBinding(action: ShortcutAction, chord: string | null): void {
    if (chord !== null && !isBindableChord(chord)) {
        warn(`Refused non-bindable shortcut chord "${chord}" for ${action}`).catch(() => {});
        return;
    }
    const next = {...store.get()};
    if (chord === null) delete next[action];
    else next[action] = chord;
    store.set(next);
}

/** Drop every override (the pane's 「全部重置」). */
export function resetShortcutBindings(): void {
    store.set({});
}
