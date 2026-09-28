import {useEffect, useRef, useState} from "react";

/**
 * Keeps a small scrollable region (thinking text, tool output) pinned to
 * its bottom while content streams in — the same stickiness semantics as
 * the chat transcript: the user scrolling up detaches, scrolling back to
 * the bottom reattaches.
 *
 * Jumps instantly (never smooth): these boxes are short and stream fast,
 * so a smooth animation would perpetually lag behind the tail. To keep
 * the per-frame jump from reading as a snap, callers wear the conditional
 * edge fades (.lum-fade-top / .lum-fade-bottom — main.css) from this
 * hook's `top`/`bottom` flags — content dissolves at an edge only while
 * content is actually hidden beyond it, so a box that opens at the very
 * top keeps its first line crisp (the .lum-tail-fade behavior this
 * replaces) and the resting bottom edge stays solid until it overflows.
 * Static-content scrollers use useScrollEdges instead (same flags, no
 * follow).
 *
 * The follow effect runs on every render instead of over declared deps —
 * streaming updates re-render the component as content arrives, which is
 * exactly when the tail needs chasing.
 */
export function useFollowBottom<T extends HTMLElement>(enabled: boolean) {
    const ref = useRef<T>(null);
    const pinnedRef = useRef(true);
    // Edge flags: content hidden beyond the top/bottom of the scrollport.
    // Same-value setState bails out, so this costs one extra render per
    // transition, not per frame.
    const [edges, setEdges] = useState({top: false, bottom: false});

    const measure = () => {
        const el = ref.current;
        if (!el) return;
        setEdges((prev) => {
            const top = el.scrollTop > 0;
            // 1px of slop for fractional scroll geometry (see
            // useScrollEdges' note on the same constant).
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight > 1;
            return prev.top === top && prev.bottom === bottom ? prev : {top, bottom};
        });
    };

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (enabled && pinnedRef.current) {
            el.scrollTop = el.scrollHeight;
        }
        measure();
    });

    const onScroll = () => {
        const el = ref.current;
        if (!el) return;
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
        measure();
    };

    return {ref, onScroll, top: edges.top, bottom: edges.bottom};
}
