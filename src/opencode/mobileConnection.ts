import {useSyncExternalStore} from "react";
import {info as logInfo} from "@tauri-apps/plugin-log";
import {createPersistedStore} from "../lib/persistedStore.ts";
import {normalizeServerUrl} from "../opencode/serverConnection.ts";

/**
 * The MOBILE app's server connection (its whole account identity): the
 * lumina-code-server address + the device token from login. Same persisted
 * store machinery as the desktop's preferences — on HarmonyOS the
 * storage is the kv shim (mobile.html hydrate gate), on browser dev the
 * native localStorage. No `enabled` toggle here: connected IS the app's
 * state; signing out clears the store and returns to the login screen.
 */

export interface MobileConnection {
    url: string;
    token: string;
    username: string;
}

function parse(raw: string | null): MobileConnection | null {
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<MobileConnection>;
        if (
            typeof parsed.url !== "string" ||
            typeof parsed.token !== "string" ||
            typeof parsed.username !== "string"
        ) {
            return null;
        }
        if (normalizeServerUrl(parsed.url) === null) return null;
        return parsed as MobileConnection;
    } catch {
        return null;
    }
}

const store = createPersistedStore<MobileConnection | null>({
    key: "lumina-mobile:connection",
    label: "mobile server connection",
    read: parse,
    write: (value) => (value === null ? null : JSON.stringify(value)),
    eq: (a, b) => a === b,
});

export function useMobileConnection(): MobileConnection | null {
    return useSyncExternalStore(store.subscribe, store.get);
}

export function peekMobileConnection(): MobileConnection | null {
    return store.get();
}

/** Persist a signed-in connection (called after a successful login). */
export function setMobileConnection(next: MobileConnection): void {
    if (store.set(next)) {
        logInfo(`Signed in to ${next.url} as ${next.username}`).catch(() => {});
    }
}

/** Sign out: forget locally. The Server settings' mobile page revokes
 * the token server-side (best effort) BEFORE calling this; clearing the
 * store is what returns the app to the login screen. */
export function clearMobileConnection(): void {
    if (store.set(null)) {
        logInfo("Signed out (connection cleared)").catch(() => {});
    }
}
