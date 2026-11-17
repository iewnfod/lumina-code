import {useEffect, useRef, useState} from "react";
import type {ReactNode} from "react";

/** The exit hold's FALLBACK: .lum-surface-exit's keyframes run
 * var(--duration-base) (250ms) and the hold normally ends on the
 * animationend event (same tick as the conversation surface's exit —
 * the two swaps stay in lockstep); canceled animations (display:none,
 * hidden window) never send the event, so the timer covers them.
 * SessionSurface's SURFACE_EXIT_MS twin. */
const STATS_CARD_SWAP_MS = 400;

/**
 * The stats-card KEYED-SWAP layer — SessionSurface's SEQUENTIAL little
 * sibling. The card is keyed by DIRECTORY, and a cross-directory switch
 * (a daily↔dev mode switch, a cross-project jump) replays the
 * conversation surface's choreography on the card:
 *
 *   1. the leaving card plays its rise-out ALONE on stage
 *      (.lum-card-hold > .lum-stats runs lum-surface-exit's keyframes,
 *      main.css) while the successor stays UNMOUNTED — sequential, not
 *      the old crossfade: two glass surfaces translating against each
 *      other smear, the same reason SessionSurface went sequential;
 *   2. the hold ends → the successor mounts fresh and runs its own
 *      .lum-enter (the card root carries it) — the same 250ms + 250ms
 *      cadence as the conversation swap beside it, both halves fired by
 *      the same click.
 *
 * The exit layer is a frozen ReactNode snapshot captured at the flip
 * (SessionSurface's pattern): the element keeps the props it was built
 * with — the OLD directory's diff and the OLD session's terminals — so
 * the leaving card renders untouched for the exit's duration. The
 * snapshot root's own entrance animation is suppressed (.lum-card-hold
 * .lum-enter, main.css — a remounted snapshot would replay it
 * mid-exit). A mid-exit retarget (a rapid second switch) KEEPS the
 * current exit playing — the hold is never re-armed mid-flight, and
 * whatever swapKey holds when it ends is what mounts (SessionSurface's
 * re-aim semantics). Dropping to the welcome screen or the settings
 * page rises the last card out the same way.
 */
export default function StatsCardSwap({swapKey, render}: {swapKey: string | null; render: (key: string) => ReactNode}) {
    const [held, setHeld] = useState<{key: string; node: ReactNode} | null>(null);
    const prevKeyRef = useRef(swapKey);
    const prevNodeRef = useRef<ReactNode>(null);

    const node = swapKey !== null ? render(swapKey) : null;
    if (prevKeyRef.current !== swapKey) {
        const from = prevKeyRef.current;
        const fromNode = prevNodeRef.current;
        prevKeyRef.current = swapKey;
        // Snapshot the leaving card BEFORE the successor's node replaces
        // prevNodeRef below (the derived-state edge — idempotent under
        // StrictMode's second pass, which sees no key edge). A hold
        // already playing KEEPS its snapshot: the exit layer is never
        // swapped mid-flight.
        if (held === null && from !== null && fromNode !== null) setHeld({key: from, node: fromNode});
    }
    if (swapKey !== null) prevNodeRef.current = node;

    // The hold ends on the exit's animationend (the FALLBACK timer's
    // cleanup also runs then — idempotent), so the successor mounts the
    // same tick the conversation surface's exit ends.
    useEffect(() => {
        if (held === null) return;
        const timer = window.setTimeout(() => setHeld(null), STATS_CARD_SWAP_MS);
        return () => window.clearTimeout(timer);
    }, [held]);

    // SEQUENTIAL: while the hold is up the successor stays unmounted —
    // the leaving card is alone on stage, so it may travel.
    if (held !== null) {
        return (
            <div
                key={`ghost-${held.key}`}
                aria-hidden
                className="lum-card-hold"
                onAnimationEnd={(e) => {
                    // The exit animation runs on the CARD itself (see
                    // main.css — a wrapper transform would reparent the
                    // float-mode card's absolute positioning), so the
                    // event BUBBLES to this wrapper: match by animation
                    // NAME (unique to the exit), not target — child
                    // animations with other names never count.
                    if (e.animationName === "lum-surface-exit") setHeld(null);
                }}
            >
                {held.node}
            </div>
        );
    }
    return <>{node}</>;
}
