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
