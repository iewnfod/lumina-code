import {useEffect, useRef, useState} from "react";

/**
 * Minimum time a system-opened disclosure stays open before an auto-fold
 * lands. Short live phases (a thought finishing in well under a second)
 * would otherwise flash open→closed — the fold animation barely starts
 * before the live phase ends and folds it right back shut.
 */
export const AUTO_EXPAND_MIN_DWELL_MS = 800;

/**
 * How long a TERMINAL system disclosure — a failed tool call — stays open
 * before folding itself back shut, so a failed call ends collapsed like
 * every successful one (red icon marking the failure). The reason got its
 * moment; an explicit click reopens it for as long as the reader wants.
 */
export const ERROR_DISCLOSURE_MS = 4000;

interface ExpansionState {
    expanded: boolean;
    /** An explicit reader toggle has happened — system logic stands down. */
    userToggled: boolean;
    /** The system has already auto-opened this key within the current
     *  auto-expand stretch. Timed auto-collapses (terminal states whose
     *  autoExpand never drops — errors) check it so they don't re-open
     *  themselves; it resets once autoExpand falls, letting a later
     *  stretch (a resumed thought, a live run again) open the row. */
    systemOpened: boolean;
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
 * `autoCollapseMs` folds a system-opened row on a timer even while
 * autoExpand stays high — for terminal disclosures (a failed call) that
 * never lower it.
 */
export function useExpansion(
    key: string,
    autoExpand: boolean,
    minDwellMs = 0,
    autoCollapseMs = 0,
): {expanded: boolean; toggle: () => void} {
    const [state, setState] = useState<ExpansionState>(
        () => store.get(key) ?? {expanded: false, userToggled: false, systemOpened: false},
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
                // Already had its showing in this stretch (the timed
                // collapse of a failed call) — stay down.
                if (state.systemOpened) return;
                autoOpenedAtRef.current = performance.now();
                apply({expanded: true, userToggled: false, systemOpened: true});
                return;
            }
            // Terminal disclosures never lower autoExpand, so they fold
            // on their own timer instead.
            if (autoCollapseMs > 0) {
                const timer = window.setTimeout(() => {
                    apply({expanded: false, userToggled: false, systemOpened: true});
                }, autoCollapseMs);
                return () => window.clearTimeout(timer);
            }
            return;
        }
        if (!state.expanded) {
            // Outside any auto-expand stretch: re-arm the system side so
            // the next stretch can open the row again.
            if (state.systemOpened) apply({expanded: false, userToggled: false, systemOpened: false});
            return;
        }
        const openedAt = autoOpenedAtRef.current;
        const remaining = openedAt == null
            ? 0
            : minDwellMs - (performance.now() - openedAt);
        if (remaining <= 0) {
            apply({expanded: false, userToggled: false, systemOpened: false});
            return;
        }
        // Honor the dwell: fold once the remainder elapses. The cleanup
        // cancels the fold if the reader toggles or the system re-expands
        // (e.g. the tool errors) in the meantime.
        const timer = window.setTimeout(() => {
            apply({expanded: false, userToggled: false, systemOpened: false});
        }, remaining);
        return () => window.clearTimeout(timer);
    }, [key, autoExpand, minDwellMs, autoCollapseMs, state.userToggled, state.expanded, state.systemOpened]);

    const toggle = () => apply({expanded: !state.expanded, userToggled: true, systemOpened: state.systemOpened});

    return {expanded: state.expanded, toggle};
}
