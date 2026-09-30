import {useSyncExternalStore} from "react";
import {info as logInfo} from "@tauri-apps/plugin-log";
import {createPersistedStore} from "../lib/persistedStore.ts";
import type {NotificationMode} from "../opencode/notificationTriggers.ts";

/**
 * The desktop-notification preference (Settings → General →
 * Notifications): the three-tier MODE (off / minimal — run ends only /
 * full — run ends plus every user-attention event) plus the FOCUS MUTE
 * sub-setting (skip notifications for the OPEN session while the window
 * is focused; background sessions and an unfocused window still notify).
 * An app-level preference over lib/persistedStore.ts (own localStorage
 * key), snapshotted via useSyncExternalStore — hooks/useNotifications.ts
 * reads the same store from its event handlers so a change applies to
 * the very next event.
 */

export interface NotificationSettings {
    mode: NotificationMode;
    /** Focus-mute enabled (see the module doc). */
    muteFocusedCurrent: boolean;
}

const DEFAULT_SETTINGS: NotificationSettings = {mode: "full", muteFocusedCurrent: true};

function parseMode(raw: unknown): NotificationMode {
    return raw === "off" || raw === "minimal" || raw === "full" ? raw : DEFAULT_SETTINGS.mode;
}

const store = createPersistedStore<NotificationSettings>({
    key: "lumina-code:notifications",
    label: "notification settings",
    // Field-level fallback to defaults — never throws, per the read
    // contract (malformed/partial storage must not brick notifications).
    read: (raw) => {
        if (raw === null) return DEFAULT_SETTINGS;
        try {
            const parsed = JSON.parse(raw) as {mode?: unknown; muteFocusedCurrent?: unknown};
            return {
                mode: parseMode(parsed.mode),
                muteFocusedCurrent:
                    typeof parsed.muteFocusedCurrent === "boolean"
                        ? parsed.muteFocusedCurrent
                        : DEFAULT_SETTINGS.muteFocusedCurrent,
            };
        } catch {
            return DEFAULT_SETTINGS;
        }
    },
    // Default values persist as absence (a fresh install's storage stays
    // clean; see persistedStore's write semantics).
    write: (s) =>
        s.mode === DEFAULT_SETTINGS.mode && s.muteFocusedCurrent === DEFAULT_SETTINGS.muteFocusedCurrent
            ? null
            : JSON.stringify(s),
    eq: (a, b) => a.mode === b.mode && a.muteFocusedCurrent === b.muteFocusedCurrent,
});

/** The stored notification settings; consumed by the settings pane and
 * the notification hook. */
export function useNotificationSettings(): NotificationSettings {
    return useSyncExternalStore(store.subscribe, store.get);
}

/** Update and persist the notification settings. Never throws. */
export function setNotificationSettings(next: NotificationSettings): void {
    if (store.set(next)) {
        logInfo(`Notification settings: mode=${next.mode}, focus mute=${next.muteFocusedCurrent}`).catch(() => {});
    }
}
