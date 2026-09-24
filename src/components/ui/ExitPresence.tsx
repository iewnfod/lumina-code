import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type AnimationEvent as ReactAnimationEvent,
    type ReactNode,
    type TransitionEvent as ReactTransitionEvent,
} from "react";
import {
    createExitLedger,
    matchesAnimationEvent,
    matchesTransitionEvent,
    mergeExitOrder,
    type ExitMatcher,
} from "../../lib/exitGate.ts";

/**
 * The exit engine — the event-driven replacement for the old
 * useExitPresence timers (which had to GUESS the CSS duration and cut
 * animations short under load). CSS still does all the animating; these
 * components only decide WHEN an exiting element may leave the DOM:
 *
 * - `present` flips false → the children stay mounted with
 *   `closing` = true (the caller swaps in the exit class, e.g.
 *   .lum-pop-exit) until the exit animation/transition actually ENDS
 *   on the host element — matched by name and target so bubbled child
 *   events don't count — or an `exitMs` fallback timer fires (canceled
 *   animations never send events: display:none, reduced-motion).
 * - THE HOLD STARTS DURING RENDER, not in an effect: the commit that
 *   flips present false must already paint the children (with the exit
 *   class). Starting it in a post-commit effect leaves a one-frame
 *   hole where the element is gone — the fold-collapse "content just
 *   disappears" bug. The ledger/timer side starts in a layout effect
 *   (pre-paint), so even the over-budget degradation paints a clean
 *   unmount.
 * - The app-wide EXIT BUDGET (lib/exitGate.ts) caps concurrent holds
 *   of ANIMATING exits; over budget the children unmount immediately —
 *   bursts skip the choreography exactly when it would cost frames.
 *   Holds whose animation lives on a CONTAINER (fold bodies: the
 *   .lum-fold div runs the transition, the held children just need to
 *   exist) are nearly free and pass `budget={false}`.
 * - A component that starts absent never mounts (no empty-pop flash);
 *   reopening mid-exit cancels the hold and shows immediately.
 *
 * The children are a render prop receiving `closing` and a `bind` bag
 * (`onAnimationEnd`/`onTransitionEnd`) to spread onto the element that
 * carries the exit class — that element is the "host" the matching in
 * exitGate.ts checks against.
 */

/** The one app-wide ledger (budget accounting across all exits). */
const appLedger = createExitLedger();

export interface ExitBind {
    onAnimationEnd: (e: ReactAnimationEvent) => void;
    onTransitionEnd: (e: ReactTransitionEvent) => void;
}

export default function ExitPresence({
    present,
    exitMs = 150,
    exit,
    budget = true,
    children,
}: {
    /** What the app wants mounted. */
    present: boolean;
    /** Fallback hold duration — set to the exit's CSS duration. */
    exitMs?: number;
    /** Which animation/transition finishing ends the hold (see
     * ExitMatcher; omit to finish on the host's first end event). */
    exit?: ExitMatcher;
    /** Count the hold against the exit budget? False for holds whose
     * animation runs on a container (fold bodies) — keeping children
     * mounted through a container transition costs no animation work,
     * so they must never crowd out real exits. */
    budget?: boolean;
    children: (closing: boolean, bind: ExitBind) => ReactNode;
}) {
    const [exiting, setExiting] = useState(false);
    const prevPresent = useRef(present);
    const heldRef = useRef(false);
    const timerRef = useRef(0);
    const budgetRef = useRef(budget);
    budgetRef.current = budget;

    const finish = useRef(() => {
        if (!heldRef.current) return;
        heldRef.current = false;
        if (budgetRef.current) appLedger.release();
        window.clearTimeout(timerRef.current);
        setExiting(false);
    }).current;

    // Edge detection DURING RENDER (React's derived-state pattern —
    // the setState re-renders before committing, so the flipped commit
    // paints the held children; see the header). Idempotent under
    // StrictMode's double render: the second pass sees no edge.
    if (prevPresent.current !== present) {
        const wasPresent = prevPresent.current;
        prevPresent.current = present;
        if (wasPresent && !present) setExiting(true);
        else if (!wasPresent && present) setExiting(false);
    }

    // The ledger/timer side of a hold (pre-paint). Runs after the
    // committing render started the hold above.
    useLayoutEffect(() => {
        if (exiting && !present) {
            if (heldRef.current) return; // already holding
            if (!budget || appLedger.tryAcquire()) {
                heldRef.current = true;
                window.clearTimeout(timerRef.current);
                timerRef.current = window.setTimeout(finish, exitMs);
            } else {
                // Over budget: drop now, still before paint — a clean
                // unmount, never a one-frame flash.
                setExiting(false);
            }
            return;
        }
        // Reopening cancelled the hold in render; release the slot.
        if (present && heldRef.current) finish();
    }, [present, exiting, budget, exitMs, finish]);

    // Release the slot if the consumer unmounts mid-hold.
    useEffect(() => () => {
        if (heldRef.current) {
            heldRef.current = false;
            if (budgetRef.current) appLedger.release();
            window.clearTimeout(timerRef.current);
        }
    }, []);

    const bind: ExitBind = {
        onAnimationEnd: (e) => {
            if (exiting && !present && matchesAnimationEvent(e, exit ?? {})) finish();
        },
        onTransitionEnd: (e) => {
            if (exiting && !present && matchesTransitionEvent(e, exit ?? {})) finish();
        },
    };

    if (!(present || exiting)) return null;
    return <>{children(!present && exiting, bind)}</>;
}

const NOOP_BIND: ExitBind = {
    onAnimationEnd: () => {},
    onTransitionEnd: () => {},
};

/**
 * The list form of the engine: rows that leave `items` don't vanish —
 * they collapse IN PLACE (mergeExitOrder keeps their position between
 * surviving neighbors) until their exit finishes or the budget drops
 * them. Present rows render through unchanged; their entrances remain
 * the children's own business (.lum-enter inside the content).
 *
 * One shared wrapper per row keeps entering and exiting rows in the
 * same layout context, so the .lum-row-exit height collapse (grid-rows
 * keyframes, main.css) folds real geometry; spacing that must collapse
 * WITH the row (margins) belongs on the wrapper's `rowClassName`, not
 * on the child.
 *
 * Holds start in a LAYOUT effect — after the committing render, before
 * paint — so a departing row is never missing for a frame: the
 * re-render it triggers lands in the same paint.
 */
export function ExitList<T>({
    items,
    keyOf,
    exitMs = 250,
    exit,
    rowClassName = "",
    children,
}: {
    /** What the app wants mounted, in order. */
    items: T[];
    keyOf: (item: T) => string;
    /** Fallback hold duration — set to the exit's CSS duration. */
    exitMs?: number;
    /** Which animation/transition finishing ends a row's hold. */
    exit?: ExitMatcher;
    /** Class on every row wrapper (spacing that must collapse with the
     * row). */
    rowClassName?: string;
    children: (item: T, closing: boolean, bind: ExitBind) => ReactNode;
}) {
    interface Hold {
        item: T;
        timer: number;
    }
    // Held rows + the previous items live in refs (mutations from the
    // layout effect); `tick` re-renders after a mutation.
    const holdsRef = useRef(new Map<string, Hold>());
    const prevItemsRef = useRef<T[] | null>(null);
    const orderRef = useRef<string[]>([]);
    const [, setTick] = useState(0);

    const finish = useRef((key: string) => {
        const hold = holdsRef.current.get(key);
        if (!hold) return;
        window.clearTimeout(hold.timer);
        holdsRef.current.delete(key);
        appLedger.release();
        setTick((t) => t + 1);
    }).current;

    useLayoutEffect(() => {
        const prev = prevItemsRef.current;
        prevItemsRef.current = items;
        const liveKeys = items.map(keyOf);
        const liveKeySet = new Set(liveKeys);
        let mutated = false;
        if (prev !== null) {
            // A key came back: cancel its hold (it renders live again).
            for (const [key, hold] of [...holdsRef.current]) {
                if (liveKeySet.has(key)) {
                    window.clearTimeout(hold.timer);
                    holdsRef.current.delete(key);
                    appLedger.release();
                    mutated = true;
                }
            }
            // A key left: hold it through an exit, budget permitting. Over
            // budget rows are simply not held — they already unmounted.
            for (const item of prev) {
                const key = keyOf(item);
                if (liveKeySet.has(key) || holdsRef.current.has(key)) continue;
                if (!appLedger.tryAcquire()) continue;
                const timer = window.setTimeout(() => finish(key), exitMs);
                holdsRef.current.set(key, {item, timer});
                mutated = true;
            }
        }
        // The committed order the NEXT render positions holds against.
        // Updated HERE, never during render: the render that drops a key
        // paints an order without it, and a held key's position must
        // survive that render or mergeExitOrder can't place it (held
        // keys are filtered out when absent from the previous order —
        // the exit would never render). Re-running the merge with the
        // current holds reinserts them at their live-key anchors.
        orderRef.current = mergeExitOrder(orderRef.current, liveKeys, [...holdsRef.current.keys()]);
        if (mutated) setTick((t) => t + 1);
    }, [items, keyOf, exitMs, finish]);

    // Drop in-flight holds on unmount.
    useEffect(() => () => {
        for (const {timer} of holdsRef.current.values()) {
            window.clearTimeout(timer);
            appLedger.release();
        }
        holdsRef.current.clear();
    }, []);

    // Merged view: live rows plus holds, in the order the last commit
    // painted (holds interleave at their original positions).
    const byKey = new Map<string, {item: T; closing: boolean}>();
    for (const item of items) byKey.set(keyOf(item), {item, closing: false});
    for (const [key, {item}] of holdsRef.current) {
        if (!byKey.has(key)) byKey.set(key, {item, closing: true});
    }
    const order = mergeExitOrder(orderRef.current, items.map(keyOf), [...holdsRef.current.keys()]);

    const makeBind = (key: string): ExitBind => ({
        onAnimationEnd: (e) => {
            if (matchesAnimationEvent(e, exit ?? {})) finish(key);
        },
        onTransitionEnd: (e) => {
            if (matchesTransitionEvent(e, exit ?? {})) finish(key);
        },
    });

    return (
        <>
            {order.map((key) => {
                const row = byKey.get(key);
                if (!row) return null;
                return (
                    <div
                        key={key}
                        className={`${rowClassName}${row.closing ? " lum-row-exit" : ""}`}
                        {...(row.closing ? makeBind(key) : {})}
                    >
                        {children(row.item, row.closing, row.closing ? makeBind(key) : NOOP_BIND)}
                    </div>
                );
            })}
        </>
    );
}
