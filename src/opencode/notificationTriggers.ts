import type {TranslationKey} from "../i18n/en-us.ts";
import {folderLabel} from "../lib/path.ts";
import type {OpencodeSession} from "./types.ts";

/**
 * The desktop-notification DECISION layer (pure — hooks/useNotifications.ts
 * owns the subscribing/sending half). Everything here answers one question:
 * given the stored notification settings, the window's focus, the open
 * session and the event that just happened, does a system notification
 * fire — and with which text?
 *
 * The three-tier setting (Settings → General → Notifications):
 * - "off":     nothing is ever sent;
 * - "minimal": only a run ENDING notifies (succeeded/failed — never
 *              `interrupted`, which by construction the user initiated
 *              from this window: the stop button or a rejected gate);
 * - "full":    run ends PLUS everything that blocks on the user: permission
 *              asks, AI questions (forms), plan approvals and work reports
 *              (the plan workflow's two Route-A gates — the same signals
 *              the sidebar badge reads, see useSessionRequests).
 *
 * The focus mute (a sub-setting, default ON): while the window is focused
 * AND the event belongs to the OPEN session, nothing is sent — the user is
 * already looking at it. Background sessions still notify with the window
 * focused (parallel sessions are exactly when notifications pay off), and
 * an unfocused window always notifies.
 */

export type NotificationMode = "off" | "minimal" | "full";

/** Why a run ended, narrowed to the notifying reasons — `interrupted` is
 * excluded at the type level so the bus mapping cannot accidentally
 * notify a user-initiated stop. */
export type RunEndReason = "succeeded" | "failed";

/** The kinds of user-attention a notification can report. */
export type AttentionKind = "permission" | "question" | "plan" | "work";

/** Everything a decision needs about the moment the event happened. */
export interface NotifyScene {
    mode: NotificationMode;
    /** Focus mute enabled (the sub-setting). */
    muteFocusedCurrent: boolean;
    /** Whether the Lumina Code window is focused right now. */
    focused: boolean;
    /** The open session's id, if any. */
    activeId: string | null;
}

/** True when the focus mute swallows this session's notifications. */
function muted(scene: NotifyScene, sessionId: string): boolean {
    return scene.muteFocusedCurrent && scene.focused && scene.activeId === sessionId;
}

/** Does a run ending fire a notification? ("minimal" and "full" only.) */
export function shouldNotifyRunEnd(scene: NotifyScene, sessionId: string, reason: RunEndReason): boolean {
    // Runtime guard: the bus layer maps event types, an unexpected
    // reason string must degrade to silence, never to a wrong ping.
    if (reason !== "succeeded" && reason !== "failed") return false;
    if (scene.mode === "off") return false;
    return !muted(scene, sessionId);
}

/** Does a user-attention event fire a notification? ("full" only.) */
export function shouldNotifyAttention(scene: NotifyScene, sessionId: string): boolean {
    if (scene.mode !== "full") return false;
    return !muted(scene, sessionId);
}

/** Most important kind when several pend at once — the plan workflow's
 * gates outrank the model's own asks, and a work report (the acceptance
 * gate) is the rarest, most deliberate stop of all. */
const ATTENTION_PRIORITY: readonly AttentionKind[] = ["work", "plan", "question", "permission"];

export function primaryAttentionKind(kinds: AttentionKind[]): AttentionKind | null {
    for (const kind of ATTENTION_PRIORITY) {
        if (kinds.includes(kind)) return kind;
    }
    return null;
}

/** Notification title for a run ending. */
export function runEndTitleKey(reason: RunEndReason): TranslationKey {
    return reason === "failed" ? "Run failed" : "Run finished";
}

/** Notification title for a user-attention event. */
export function attentionTitleKey(kind: AttentionKind): TranslationKey {
    switch (kind) {
        case "work":
            return "Work report awaiting review";
        case "plan":
            return "Plan awaiting approval";
        case "question":
            return "AI asked you a question";
        case "permission":
            return "An action needs your approval";
    }
}

/** Notification BODY — which session it happened in: the session's title,
 * falling back to the project folder's label (titles are auto-generated
 * until the server retitles) and last to the app's name. */
export function notifySubject(session: OpencodeSession): string {
    if (session.title && session.title.trim() !== "") return session.title;
    const directory = session.directory ?? session.location?.directory;
    if (directory) return folderLabel(directory);
    return "Lumina Code";
}
