import {useCallback, useEffect, useRef} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {invoke} from "@tauri-apps/api/core";
import {info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {isPermissionGranted, requestPermission, sendNotification} from "@tauri-apps/plugin-notification";
import {useConnection} from "../opencode/connectionContext.tsx";
import {
    attentionTitleKey,
    notifySubject,
    primaryAttentionKind,
    runEndTitleKey,
    shouldNotifyAttention,
    shouldNotifyRunEnd,
    type AttentionKind,
    type NotifyScene,
    type RunEndReason,
} from "../opencode/notificationTriggers.ts";
import {peekGateFlags} from "../opencode/useSessionRequests.ts";
import {useSessionData} from "../opencode/sessionDataContext.tsx";
import {isLinux} from "../lib/platform.ts";
import {currentDictionary} from "./i18n.tsx";
import {useNotificationSettings} from "./useNotificationMode.ts";

/**
 * The desktop-notification SUBSCRIBING half (the decisions live in the
 * pure opencode/notificationTriggers.ts). Mounted once in AppBody, it
 * watches the two signals every tier is built from:
 *
 * - a run ENDING (session.execution.succeeded/failed on the bus — read
 *   directly, because the busy set's diff carries no reason; interrupted
 *   is deliberately ignored: an interrupt can only be initiated from
 *   THIS window, the user already knows). Notified after a short delay
 *   so a follow-up ask or restart in the same session cancels the ping.
 * - user ATTENTION appearing (a session's pendingCounts going 0 → N:
 *   permission asks, AI questions, the plan workflow's two gates — the
 *   same pipeline the sidebar badge reads).
 *
 * Only ROOT sessions notify: execution events fire for subagent children
 * and the tools plugin's helper sessions too, which would ping on every
 * internal step. The focus mute and the three-tier mode are applied per
 * event (settings are re-read at fire time, so a change applies to the
 * very next notification, including ones already waiting out the delay).
 */

/** How long a run-end notification waits before firing — a pending ask
 * appearing or the session going busy again in that window cancels it. */
const RUN_END_DELAY_MS = 1500;

// --- Sending (module state: one OS permission per app run) ------------------

let notifyPermission: "unknown" | "granted" | "denied" = "unknown";

/** Resolve the OS notification permission once per run. A transient IPC
 * failure stays "unknown" so the next event retries; a user/OS denial
 * latches — no prompt spam, just logs. */
async function ensureNotifyPermission(): Promise<boolean> {
    if (notifyPermission === "granted") return true;
    if (notifyPermission === "denied") return false;
    let granted = false;
    try {
        granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
    } catch (e) {
        logWarn(`Notification permission check failed: ${e}`).catch(() => {});
        return false;
    }
    notifyPermission = granted ? "granted" : "denied";
    if (!granted) {
        logWarn("Desktop notifications denied — further sends skipped this run").catch(() => {});
    }
    return granted;
}

/** Fire one system notification: title = the event's text, body = which
 * session it happened in. Linux routes through our own PERSISTENT-
 * connection command (src-tauri/src/notify.rs): the plugin's per-send
 * D-Bus connection gets GNOME to destroy the notification outright
 * (module docs there), so it is only used off-Linux — where its
 * synchronous shim may throw (caught here) and its async failures
 * never surface (a DE without a notification daemon); both leave the
 * app untouched. */
function sendDesktopNotification(title: string, body: string): void {
    if (isLinux()) {
        invoke("desktop_notify", {title, body})
            .then(() => {
                logInfo(`Desktop notification sent: ${title} · ${body}`).catch(() => {});
            })
            .catch((e) => {
                logWarn(`Failed to send desktop notification: ${e}`).catch(() => {});
            });
        return;
    }
    void ensureNotifyPermission().then((granted) => {
        if (!granted) return;
        try {
            sendNotification({title, body});
            logInfo(`Desktop notification sent: ${title} · ${body}`).catch(() => {});
        } catch (e) {
            logWarn(`Failed to send desktop notification: ${e}`).catch(() => {});
        }
    });
}

// --- The hook ----------------------------------------------------------------

export function useNotifications(activeId: string | null): void {
    const {sessions, permissions, forms, pendingCounts} = useSessionData();
    const {subscribe} = useConnection();
    const settings = useNotificationSettings();

    // Event-time values the handlers must see CURRENT, without paying a
    // re-subscribe on every change — the apiRef pattern from useSessions.
    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    const activeIdRef = useRef(activeId);
    activeIdRef.current = activeId;
    const sessionsRef = useRef(sessions);
    sessionsRef.current = sessions;
    const permissionsRef = useRef(permissions);
    permissionsRef.current = permissions;
    const formsRef = useRef(forms);
    formsRef.current = forms;
    const focusedRef = useRef(false);

    const currentScene = useCallback((): NotifyScene => {
        const {mode, muteFocusedCurrent} = settingsRef.current;
        return {mode, muteFocusedCurrent, focused: focusedRef.current, activeId: activeIdRef.current};
    }, []);

    // Delayed run-end notifications, per session (a restart or a new ask
    // in the same session cancels the pending ping).
    const runEndTimersRef = useRef(new Map<string, number>());

    const cancelRunEndTimer = useCallback((sessionId: string) => {
        const timer = runEndTimersRef.current.get(sessionId);
        if (timer === undefined) return;
        window.clearTimeout(timer);
        runEndTimersRef.current.delete(sessionId);
    }, []);

    // Window focus: the mute rule needs the CURRENT state at event time.
    useEffect(() => {
        const win = getCurrentWindow();
        let cancelled = false;
        win.isFocused().then((focused) => {
            if (!cancelled) focusedRef.current = focused;
        }).catch((e) => {
            logWarn(`Failed to read window focus: ${e}`).catch(() => {});
        });
        const unlisten = win.onFocusChanged(({payload}) => {
            focusedRef.current = payload;
        });
        return () => {
            cancelled = true;
            unlisten.then((fn) => fn()).catch((e) => {
                logWarn(`Failed to unlisten focus changes: ${e}`).catch(() => {});
            });
        };
    }, []);

    // Run ends: read the bus directly (the busy set's diff carries no
    // reason, and interrupted must stay silent by construction).
    useEffect(() => {
        const scheduleRunEnd = (sessionId: string, reason: RunEndReason) => {
            // Root sessions only — execution events fire for subagent
            // children and tool helper sessions too.
            if (!sessionsRef.current.some((s) => s.id === sessionId)) return;
            if (!shouldNotifyRunEnd(currentScene(), sessionId, reason)) return;
            cancelRunEndTimer(sessionId);
            const timer = window.setTimeout(() => {
                runEndTimersRef.current.delete(sessionId);
                // Re-decide at fire time: focus, the open session and the
                // settings may all have moved during the delay.
                if (!shouldNotifyRunEnd(currentScene(), sessionId, reason)) return;
                const session = sessionsRef.current.find((s) => s.id === sessionId);
                const dict = currentDictionary();
                sendDesktopNotification(
                    dict[runEndTitleKey(reason)],
                    session ? notifySubject(session) : "Lumina Code",
                );
            }, RUN_END_DELAY_MS);
            runEndTimersRef.current.set(sessionId, timer);
        };
        return subscribe((event) => {
            switch (event.type) {
                case "session.execution.started": {
                    const {sessionID} = event.data as {sessionID: string};
                    cancelRunEndTimer(sessionID);
                    break;
                }
                case "session.execution.succeeded":
                case "session.execution.failed": {
                    const {sessionID} = event.data as {sessionID: string};
                    scheduleRunEnd(
                        sessionID,
                        event.type === "session.execution.failed" ? "failed" : "succeeded",
                    );
                    break;
                }
                case "session.deleted": {
                    const {sessionID} = event.data as {sessionID: string};
                    cancelRunEndTimer(sessionID);
                    break;
                }
                // session.execution.interrupted: only ever user-initiated
                // from this window (stop button, a rejected gate card) —
                // notifying would be noise about their own action.
            }
        });
    }, [subscribe, cancelRunEndTimer, currentScene]);

    // User attention: a session's pending count going 0 → N. The first
    // observed snapshot is the BASELINE — asks that predate our event
    // stream (the connect-time seed) never replay as notifications.
    const prevPendingRef = useRef<ReadonlyMap<string, number> | null>(null);
    useEffect(() => {
        const prev = prevPendingRef.current;
        prevPendingRef.current = pendingCounts;
        if (prev === null) return;
        for (const [sessionId, count] of pendingCounts) {
            if (count > 0 && (prev.get(sessionId) ?? 0) === 0) {
                // An ask supersedes any run-end ping still waiting out
                // its delay — one decision point, one notification.
                cancelRunEndTimer(sessionId);
                if (!shouldNotifyAttention(currentScene(), sessionId)) continue;
                const kinds: AttentionKind[] = [];
                if (permissionsRef.current.some((p) => p.sessionID === sessionId)) kinds.push("permission");
                if (formsRef.current.some((f) => f.sessionID === sessionId)) kinds.push("question");
                const gates = peekGateFlags(sessionId);
                if (gates.plan) kinds.push("plan");
                if (gates.work) kinds.push("work");
                const primary = primaryAttentionKind(kinds);
                if (primary === null) continue;
                const session = sessionsRef.current.find((s) => s.id === sessionId);
                const dict = currentDictionary();
                sendDesktopNotification(
                    dict[attentionTitleKey(primary)],
                    session ? notifySubject(session) : "Lumina Code",
                );
            }
        }
    }, [pendingCounts, cancelRunEndTimer, currentScene]);

    // Never fire a notification for a session the app stopped watching.
    useEffect(() => {
        const timers = runEndTimersRef.current;
        return () => {
            for (const timer of timers.values()) window.clearTimeout(timer);
            timers.clear();
        };
    }, []);
}
