import {useSyncExternalStore} from "react";
import {createPersistedStore} from "../lib/persistedStore.ts";
import {
    markSettingsSyncDirty,
    parseSyncedValue,
    serializeSyncedValue,
    SYNCED_DEFAULTS,
    type SyncedKeyIo,
} from "../opencode/settingsSync.ts";

/**
 * Sessions the user PINNED to the top of their PROJECT folder in the
 * sidebar (a per-folder ordering preference, keyed by session id) —
 * persisted across restarts over lib/persistedStore.ts (the
 * useCollapsedFolders pattern: a module store read by the sidebar,
 * absence = nothing pinned, the fresh-install default).
 *
 * Pinned sessions rise to the top of their folder (sessionGrouping's
 * orderSessions, stable among themselves in the server's recency order)
 * and do NOT count against the folder's default reveal cap (5 per dev
 * folder / 50 for the daily flat list) — pinned rows are always visible.
 *
 * Entries for deleted sessions are inert (no row matches the id) and
 * simply ride along — the same no-pruning policy as the collapsed-folder
 * set. That inertness is also what makes this set SAFE to sync across
 * devices as the "sessionPins" key (opencode/settingsSync.ts): a second
 * desktop's opencode storage holds different session ids entirely, so a
 * synced id that matches nothing there is silently ignored while the
 * desktop + its own mobile clients (one opencode) share pins fully.
 * User toggles mark the key dirty (the sync engine uploads); the engine
 * lands other devices' values through the silent replace below.
 */
const store = createPersistedStore<ReadonlySet<string>>({
    key: "lumina-code:pinned-sessions",
    label: "pinned sessions",
    // Malformed storage (hand-edited file, partial JSON) degrades to the
    // default — nothing pinned — never throws.
    read: (raw) => {
        if (raw === null) return new Set<string>();
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) return new Set<string>();
            return new Set(parsed.filter((id): id is string => typeof id === "string" && id !== ""));
        } catch {
            return new Set<string>();
        }
    },
    // The empty set (nothing pinned) persists as absence.
    write: (ids) => (ids.size === 0 ? null : JSON.stringify([...ids])),
    // Set identity churns on every toggle; semantic equality is size +
    // membership both ways.
    eq: (a, b) => a.size === b.size && [...a].every((id) => b.has(id)),
});

/** The pinned-session set; consumed by the sidebar's ordering + reveal. */
export function useSessionPins(): ReadonlySet<string> {
    return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Synchronous read for non-React sites. */
export function getSessionPins(): ReadonlySet<string> {
    return store.get();
}

/** Pin when absent, unpin when present (the sidebar row's pin button).
 * Never throws; persistence failures log while the value still updates. */
export function toggleSessionPin(id: string): void {
    const current = store.get();
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (store.set(next)) markSettingsSyncDirty("sessionPins");
}

// --- The settings-sync landing half (the modelVisibility pattern) ---------

/** Replace the set wholesale from a synced value — SILENT (landing never
 * marks dirty, or the value would bounce straight back). */
export function applySyncedSessionPins(ids: Iterable<string>): void {
    store.set(new Set(ids));
}

/** The "sessionPins" sync key's IO adapter — see opencode/settingsSync.ts. */
export function sessionPinsIo(): SyncedKeyIo {
    return {
        readLocal() {
            // The store's read side already sanitizes; the default
            // fallback is pure paranoia.
            const wire = serializeSyncedValue("sessionPins", [...store.get()]);
            return Promise.resolve(wire ?? SYNCED_DEFAULTS.sessionPins);
        },
        async applyLocal(raw: string) {
            const value = parseSyncedValue("sessionPins", raw);
            if (!Array.isArray(value)) return false;
            applySyncedSessionPins(value);
            return true;
        },
    };
}
