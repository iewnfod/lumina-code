import {useEffect, useRef, useState} from "react";
import type {ReactNode} from "react";

/** The stats-card swap fade duration — matches lum-fade-exit (fast). */
const STATS_CARD_SWAP_MS = 150;

/**
 * The stats-card KEYED-SWAP layer (the surface swap's little sibling).
 * The card is keyed by DIRECTORY, and a cross-directory session switch
 * REMOUNTS it — a plain keyed unmount pops with no animation (the
 * conversation's SessionSurface swap covers only ITS own column, not
 * this flex sibling). This layer holds the PREVIOUS card mounted for a
 * short fade while the successor mounts: in float mode the two overlap
 * at the top-right and read as a crossfade; in the wide-container mode
 * the successor takes the flex slot immediately (the conversation
 * reflows at once, matching the surface swap's cadence) while the
 * ghost fades out floating over the same corner.
 *
 * The exit layer is a frozen ReactNode snapshot captured at the flip
 * (SessionSurface's pattern): the element keeps the props it was built
 * with — the OLD directory's diff and the OLD session's terminals — so
 * the leaving card renders untouched for the fade's duration instead
 * of flipping to the new session's data mid-fade. The ghost mounts
 * FRESH, so .lum-card-hold (main.css) pins it top-right out of flow
 * and suppresses the card's own entrance animation — the two fades
 * must never fight. Dropping to the welcome screen (no active session)
 * fades the last card the same way. Extracted from App.tsx.
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
        // StrictMode's second pass, which sees no key edge).
        if (from !== null && fromNode !== null) setHeld({key: from, node: fromNode});
    }
    if (swapKey !== null) prevNodeRef.current = node;

    // Timer-only teardown (the wrapper's own fade): simple hold, no
    // animationend matching — one element, no budget accounting.
    useEffect(() => {
        if (held === null) return;
        const timer = window.setTimeout(() => setHeld(null), STATS_CARD_SWAP_MS);
        return () => window.clearTimeout(timer);
    }, [held]);

    return (
        <>
            {node}
            {held !== null && held.key !== swapKey && (
                <div key={`ghost-${held.key}`} aria-hidden className="lum-card-hold lum-fade-exit">
                    {held.node}
                </div>
            )}
        </>
    );
}
