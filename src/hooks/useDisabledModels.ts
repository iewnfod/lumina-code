import {useSyncExternalStore} from "react";
import {info as logInfo} from "@tauri-apps/plugin-log";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * Models the user switched OFF in the model settings, hidden from the
 * composer's model picker. The server has no API for this (v2.0.x drops
 * the legacy provider whitelist/blacklist config), so it's an app-level
 * preference over lib/persistedStore.ts (own localStorage key;
 * lib/persist.ts's state is rewritten wholesale by the session flow and
 * would clobber it), snapshotted via useSyncExternalStore so a toggle
 * takes effect in every open picker immediately. Sessions already using
 * a disabled model keep running server-side.
 */

const store = createPersistedStore<ReadonlySet<string>>({
    key: "lumina-code:disabled-models",
    label: "disabled models",
    read: (raw) => {
        if (raw === null) return new Set();
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) return new Set();
            return new Set(
                parsed.filter((k): k is string => typeof k === "string" && k.includes("/")),
            );
        } catch {
            return new Set();
        }
    },
    write: (value) => JSON.stringify([...value]),
    eq: (a, b) => a.size === b.size && [...a].every((k) => b.has(k)),
});

/** Persistence key of one model — `providerID/modelID` (variants share
 *  their base model's key). */
export function disabledModelKey(providerID: string, modelID: string): string {
    return `${providerID}/${modelID}`;
}

/** The disabled-model keys; presence = hidden from the picker. The
 *  snapshot is replaced (never mutated) so consumers sharing the
 *  reference skip re-rendering. */
export function useDisabledModels(): ReadonlySet<string> {
    return useSyncExternalStore(store.subscribe, store.get);
}

/** Show/hide one model in the picker and persist it. Never throws. */
export function setModelDisabled(providerID: string, modelID: string, disabled: boolean): void {
    const key = disabledModelKey(providerID, modelID);
    const next = new Set(store.get());
    if (disabled) next.add(key);
    else next.delete(key);
    if (store.set(next)) {
        logInfo(`${disabled ? "Disabled" : "Enabled"} model ${key} in the picker`).catch(() => {});
    }
}

/** Show/hide MANY models in ONE store update (the model lists'
 * "enable all / disable all" affordance) — a single snapshot
 * replacement, a single persistence write. Never throws. */
export function setModelsDisabled(
    models: readonly {providerID: string; modelID: string}[],
    disabled: boolean,
): void {
    const next = new Set(store.get());
    let changed = false;
    for (const m of models) {
        const key = disabledModelKey(m.providerID, m.modelID);
        if (disabled && !next.has(key)) {
            next.add(key);
            changed = true;
        } else if (!disabled && next.has(key)) {
            next.delete(key);
            changed = true;
        }
    }
    if (changed && store.set(next)) {
        logInfo(`${disabled ? "Disabled" : "Enabled"} ${models.length} models in the picker`).catch(() => {});
    }
}

// --- The provider-level disable (a CLIENT-side construct — the server
// has no provider-disable API: credentials present = active) ---
//
// Switching a whole provider OFF must NOT collapse its per-model
// choices the way "disable all" does: the disable SNAPSHOTS which of
// its models were already hidden, hides them all, and re-enabling
// RESTORES the snapshot. While a provider is disabled its model rows
// and bulk actions are locked (there is nothing meaningful to toggle).

/** providerID → the snapshot of modelIDs that were already hidden when
 * the provider was switched off. Presence of the key = the provider is
 * disabled. */
const providerStore = createPersistedStore<ReadonlyMap<string, readonly string[]>>({
    key: "lumina-code:disabled-providers",
    label: "disabled providers",
    read: (raw) => {
        if (raw === null) return new Map();
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) return new Map();
            const entries = parsed
                .map((e): [string, readonly string[]] | null => {
                    if (!Array.isArray(e) || e.length < 2 || typeof e[0] !== "string" || !Array.isArray(e[1])) {
                        return null;
                    }
                    return [e[0], e[1].filter((id): id is string => typeof id === "string")];
                })
                .filter((e): e is [string, readonly string[]] => e !== null);
            return new Map(entries);
        } catch {
            return new Map();
        }
    },
    write: (value) => JSON.stringify([...value.entries()]),
    eq: (a, b) =>
        a.size === b.size &&
        [...a.entries()].every(([k, v]) => {
            const other = b.get(k);
            return other != null && v.length === other.length && v.every((id) => other.includes(id));
        }),
});

/** The disabled providers (key = providerID, value = the hidden-models
 * snapshot the re-enable restores). */
export function useDisabledProviders(): ReadonlyMap<string, readonly string[]> {
    return useSyncExternalStore(providerStore.subscribe, providerStore.get);
}

/** Switch a provider OFF: snapshot its currently-hidden models, then
 * hide ALL of `modelIDs`. The snapshot is derived from the store (the
 * caller only supplies the provider's full model list). Never throws. */
export function disableProvider(providerID: string, modelIDs: readonly string[]): void {
    const prefix = `${providerID}/`;
    const snapshot = [...store.get()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    const next = new Set(store.get());
    for (const id of modelIDs) next.add(disabledModelKey(providerID, id));
    const providersChanged = providerStore.set(new Map(providerStore.get()).set(providerID, snapshot));
    const modelsChanged = store.set(next);
    if (providersChanged || modelsChanged) {
        logInfo(`Disabled provider ${providerID} in the picker (${snapshot.length} models were already hidden)`).catch(() => {});
    }
}

/** Switch a provider back ON: unhide all its models, then re-apply the
 * disable-time snapshot so per-model choices survive the round trip. */
export function enableProvider(providerID: string): void {
    const snapshot = providerStore.get().get(providerID) ?? [];
    const next = new Set(store.get());
    const prefix = `${providerID}/`;
    for (const k of next) {
        if (k.startsWith(prefix)) next.delete(k);
    }
    for (const id of snapshot) next.add(disabledModelKey(providerID, id));
    const providers = new Map(providerStore.get());
    providers.delete(providerID);
    const providersChanged = providerStore.set(providers);
    const modelsChanged = store.set(next);
    if (providersChanged || modelsChanged) {
        logInfo(`Enabled provider ${providerID} in the picker (restored ${snapshot.length} hidden models)`).catch(() => {});
    }
}
