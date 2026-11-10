import {useEffect, useMemo, useRef} from "react";
import {isMacOS} from "../lib/platform.ts";
import {chordFromEvent, matchChord, resolveBindings, type ShortcutAction} from "../lib/shortcuts.ts";
import {createModuleStore} from "../lib/moduleStore.ts";
import {useShortcutBindings} from "./useShortcutBindings.ts";

/**
 * THE global shortcut listener — mounted ONCE in AppBody. Capture-phase
 * keydown on document: it runs before any target handler (Lexical's
 * commands included), and a MATCHED chord is consumed with preventDefault
 * + stopPropagation so nothing below re-interprets it. Unmatched events
 * pass through untouched — this hook must never shadow typing, the
 * composer's Enter/arrows, or the modal/menu Escape system.
 *
 * Actions arrive as a callback map and are read through a ref (the
 * listener registers once with stable deps); bindings resolve from the
 * persisted override store. While the settings pane is RECORDING a new
 * chord it raises the recording flag here — live shortcut dispatch
 * pauses so the very combination being recorded cannot fire its current
 * action mid-capture.
 */

// --- The recording gate (the settings pane's recorder owns this) ---

const recording = createModuleStore(false);

/** Live shortcut dispatch pauses while the settings pane records a chord. */
export function setShortcutRecording(active: boolean): void {
    recording.set(active);
}

/** Synchronous probe for the listener's closure (no React binding needed). */
export function isShortcutRecording(): boolean {
    return recording.get();
}

// --- The listener ---

/**
 * Wire shortcut actions. Every entry is optional: an action without a
 * handler simply never fires (surfaces that cannot serve it pass
 * nothing); a handler decides for itself whether NOW is the moment
 * (e.g. interrupt checks the busy set).
 */
export function useKeyboardShortcuts(actions: Partial<Record<ShortcutAction, () => void>>): void {
    const overrides = useShortcutBindings();
    const bindings = useMemo(() => resolveBindings(overrides), [overrides]);

    // Render-time ref updates keep the single document listener current.
    const bindingsRef = useRef(bindings);
    bindingsRef.current = bindings;
    const actionsRef = useRef(actions);
    actionsRef.current = actions;

    useEffect(() => {
        const isMac = isMacOS();
        const onKeyDown = (e: KeyboardEvent) => {
            if (recording.get()) return;
            const action = matchChord(chordFromEvent(e, isMac), bindingsRef.current);
            if (action === null) return;
            const handler = actionsRef.current[action];
            if (!handler) return;
            // Consume: no default browser/webview behavior, and the event
            // never reaches the focused target (Lexical, inputs).
            e.preventDefault();
            e.stopPropagation();
            handler();
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, []);
}
