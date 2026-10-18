import {useEffect, useRef} from "react";
import {isMobileApp} from "../lib/platform.ts";
import {backStackDrop, backStackPush} from "../lib/backStack.ts";

/**
 * Wire one "page level" into the SYSTEM BACK navigation (mobile only —
 * desktop short-circuits and keeps its Escape/backdrop closes). While
 * `active` is true the level owns one webview-history entry
 * (lib/backStack.ts): the system back gesture closes the TOP level
 * through popstate, and the level closing through its own UI (X
 * button, backdrop tap, item click) pops its entry on unmount. Both
 * directions are idempotent — whichever fires first removes the stack
 * entry, the other finds nothing.
 *
 * `onClose` may be an inline lambda: it is read through a ref at
 * popstate time, so the effect (and its history entry) runs exactly
 * once per active span. The popstate-driven close is the same callback
 * the UI's close affordances use — no separate code path.
 */
export function useBackLevel(active: boolean, onClose: () => void): void {
    // Refresh the closer every render (the SettingsModal lastPaneRef
    // pattern): the history entry outlives re-renders, the latest
    // callback must be the one a late popstate invokes.
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    useEffect(() => {
        if (!active || !isMobileApp()) return;
        const id = backStackPush(() => closeRef.current());
        return () => {
            backStackDrop(id);
        };
        // Deliberately NOT dep on onClose — see closeRef above.
    }, [active]);
}
