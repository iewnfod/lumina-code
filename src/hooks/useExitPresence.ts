import {useEffect, useRef, useState} from "react";

/**
 * Keep content mounted through a CSS EXIT animation — the tiny standard
 * replacement for framer's AnimatePresence where all entrances/exits are
 * CSS keyframes now.
 *
 * `open` says what the app wants; the returned `mounted` stays true for
 * `durationMs` after open flips false so the element can play its exit
 * class (`closing` tells you to apply it, e.g. `.lum-pop-exit`), then
 * drops to false and the element unmounts. A component that starts
 * closed never mounts (no empty-pop flash); reopening mid-exit cancels
 * the timer and shows immediately.
 *
 * The caller renders `{mounted && <div className={closing ? "lum-pop-exit" : "lum-pop"}…}</div>}`.
 */
export function useExitPresence(open: boolean, durationMs = 150): {mounted: boolean; closing: boolean} {
    // Previous open value: only a true → false edge starts an exit hold.
    const prevOpen = useRef(open);
    const [exiting, setExiting] = useState(false);

    useEffect(() => {
        const wasOpen = prevOpen.current;
        prevOpen.current = open;
        if (!(wasOpen && !open)) return;
        setExiting(true);
        const timer = window.setTimeout(() => setExiting(false), durationMs);
        return () => window.clearTimeout(timer);
    }, [open, durationMs]);

    return {mounted: open || exiting, closing: exiting && !open};
}
