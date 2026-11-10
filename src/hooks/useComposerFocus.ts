import {useSyncExternalStore} from "react";
import {createModuleStore} from "../lib/moduleStore.ts";

/**
 * Cross-surface composer focus REQUESTS — the useStatsPanelMode drill-
 * request pattern: the transcript and the composer are strangers in the
 * tree (the shortcut listener lives in AppBody, the composer mounts
 * inside whichever surface is live — session OR welcome), so "focus the
 * message box" cannot be a prop. Whoever wants focus bumps the token;
 * the mounted ChatInput (there is at most one) subscribes and focuses
 * its editor on every change. Token 0 is the untouched initial state.
 */

const focusRequests = createModuleStore<number>(0);

/** Ask the mounted composer to take focus (no-op while none is mounted —
 *  e.g. the settings surface owns the canvas). */
export function requestComposerFocus(): void {
    focusRequests.update((n) => n + 1);
}

/** The current request token; ChatInput focuses on every change past 0. */
export function useComposerFocusRequest(): number {
    return useSyncExternalStore(focusRequests.subscribe, focusRequests.get);
}
