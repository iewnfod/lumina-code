import {useEffect, useRef, useState} from "react";

/**
 * Scroll-edge tracking for scrollers that wear the CONDITIONAL edge fades
 * (.lum-fade-top/-bottom/-left/-right — main.css): a fade shows on a side
 * only while content is actually hidden beyond it, so a resting list keeps
 * its first/last row crisp, a non-overflowing region carries no fade at
 * all (a static mask would eat the edges of fully-visible content), and a
 * table that fits its column renders mask-free. Padded reading surfaces
 * don't need this — their padding covers the default 12px band, so they
 * wear BOTH edge classes statically instead.
 *
 * Like useFollowBottom, the re-check runs on every render instead of over
 * declared deps: content growth (rows added, items filtered, a menu
 * repopulating) is exactly when an edge can appear or vanish, and the
 * check itself is a few comparisons — the same-value setState bails out,
 * so this costs one extra render per transition, not per frame. Layout
 * changes that arrive WITHOUT a render (window resize, container-query
 * reflow) are covered by a ResizeObserver on the element's own box.
 *
 * Streaming/tail-chasing regions (thinking text, tool output, terminal
 * output) use useFollowBottom instead — it folds the vertical edge flags
 * into its follow logic so one hook serves both jobs.
 */
export function useScrollEdges<T extends HTMLElement>() {
    const ref = useRef<T>(null);
    const [edges, setEdges] = useState({top: false, bottom: false, left: false, right: false});

    const measure = () => {
        const el = ref.current;
        if (!el) return;
        setEdges((prev) => {
            const top = el.scrollTop > 0;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight > 1;
            const left = el.scrollLeft > 0;
            const right = el.scrollWidth - el.scrollLeft - el.clientWidth > 1;
            // 1px of slop on the hidden-content checks: fractional scroll
            // geometry (zoom, sub-pixel line heights) can leave a sub-pixel
            // remainder that would keep an edge fade lit at the very end.
            return prev.top === top && prev.bottom === bottom && prev.left === left && prev.right === right
                ? prev
                : {top, bottom, left, right};
        });
    };

    useEffect(measure);

    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => measure());
        ro.observe(el);
        return () => ro.disconnect();
        // measure only reads the (stable) ref + setState — the first
        // render's closure is safe to keep for the observer's lifetime.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return {ref, onScroll: measure, top: edges.top, bottom: edges.bottom, left: edges.left, right: edges.right};
}
