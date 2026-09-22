import {useSyncExternalStore} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";

/**
 * Models the user switched OFF in the model settings, hidden from the
 * composer's model picker. The server has no API for this (v2.0.x drops
 * the legacy provider whitelist/blacklist config), so it's an app-level
 * preference — sessions already using a disabled model keep running
 * server-side. Structured after hooks/useThemePreference.ts: a
 * module-level store + its own localStorage key (lib/persist.ts's state
 * is rewritten wholesale by the session flow and would clobber it),
 * snapshotted via useSyncExternalStore so a toggle takes effect in every
 * open picker immediately.
 */

const STORAGE_KEY = "lumina-code:disabled-models";

/** The store's snapshot — replaced (never mutated) so consumers sharing
 *  the reference skip re-rendering. */
let stored: ReadonlySet<string> = loadStored();

const listeners = new Set<() => void>();

function loadStored(): ReadonlySet<string> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return new Set();
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((k): k is string => typeof k === "string" && k.includes("/")));
    } catch (e) {
        logError(`Failed to load disabled models: ${e}`).catch(() => {});
        return new Set();
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Persistence key of one model — `providerID/modelID` (variants share
 *  their base model's key). */
export function disabledModelKey(providerID: string, modelID: string): string {
    return `${providerID}/${modelID}`;
}

/** The disabled-model keys; presence = hidden from the picker. */
export function useDisabledModels(): ReadonlySet<string> {
    return useSyncExternalStore(subscribe, () => stored);
}

/** Show/hide one model in the picker and persist it. Never throws. */
export function setModelDisabled(providerID: string, modelID: string, disabled: boolean): void {
    const key = disabledModelKey(providerID, modelID);
    if (stored.has(key) === disabled) return;
    const next = new Set(stored);
    if (disabled) next.add(key);
    else next.delete(key);
    stored = next;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...stored]));
    } catch (e) {
        logError(`Failed to persist disabled models: ${e}`).catch(() => {});
    }
    logInfo(`${disabled ? "Disabled" : "Enabled"} model ${key} in the picker`).catch(() => {});
    for (const listener of listeners) listener();
}
