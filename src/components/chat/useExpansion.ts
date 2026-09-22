import {useEffect, useRef, useState} from "react";

/**
 * Minimum time a system-opened disclosure stays open before an auto-fold
 * lands. Quick tools (glob/grep/read finish in well under a second) would
 * otherwise flash open→closed — the fold animation barely starts before
 * the tool completes and folds it right back shut.
 */
export const AUTO_EXPAND_MIN_DWELL_MS = 800;

interface ExpansionState {
    expanded: boolean;
    /** An explicit reader toggle has happened — system logic stands down. */
    userToggled: boolean;
}

const store = new Map<string, ExpansionState>();

/**
 * Expansion state for disclosure rows (FoldRow callers), backed by a
 * module-scope store keyed by a stable part/message identity.
 *
 * Why not plain useState: ChatView folds runs of activity-only messages
 * into one ActivityGroup keyed by the run's first message. While a run
 * grows from one message to two (every multi-step run does, on the second
 * step), that key swaps MessageItem for ActivityGroup — same key,
 * different component type — and React remounts the whole subtree. Plain
 * useState would lose the reader's toggles there and rows would open or
 * close on their own. Store entries are tiny and keyed by server-side
 * unique ids, so no pruning is needed.
 *
 * `autoExpand` drives the system side (live tool output, visible error
 * reason, …); an explicit toggle wins for the lifetime of the key.
 * `minDwellMs` delays the auto-fold of a freshly auto-opened row.
 */
export function useExpansion(
    key: string,
    autoExpand: boolean,
    minDwellMs = 0,
): {expanded: boolean; toggle: () => void} {
    const [state, setState] = useState<ExpansionState>(
        () => store.get(key) ?? {expanded: false, userToggled: false},
    );
    // When the system opened the current expansion (performance.now()).
    // Null when it was open at birth (restored from the store) or opened
    // by the user — those fold without a dwell delay.
    const autoOpenedAtRef = useRef<number | null>(null);

    const apply = (next: ExpansionState) => {
        store.set(key, next);
        setState(next);
    };

    useEffect(() => {
        if (state.userToggled) return;
        if (autoExpand) {
            if (!state.expanded) {
                autoOpenedAtRef.current = performance.now();
                apply({expanded: true, userToggled: false});
            }
            return;
        }
        if (!state.expanded) return;
        const openedAt = autoOpenedAtRef.current;
        const remaining = openedAt == null
            ? 0
            : minDwellMs - (performance.now() - openedAt);
        if (remaining <= 0) {
            apply({expanded: false, userToggled: false});
            return;
        }
        // Honor the dwell: fold once the remainder elapses. The cleanup
        // cancels the fold if the reader toggles or the system re-expands
        // (e.g. the tool errors) in the meantime.
        const timer = window.setTimeout(() => {
            apply({expanded: false, userToggled: false});
        }, remaining);
        return () => window.clearTimeout(timer);
    }, [key, autoExpand, minDwellMs, state.userToggled, state.expanded]);

    const toggle = () => apply({expanded: !state.expanded, userToggled: true});

    return {expanded: state.expanded, toggle};
}
