import {useEffect, useRef, useState} from "react";

/**
 * Keeps a small scrollable region (thinking text, tool output) pinned to
 * its bottom while content streams in — the same stickiness semantics as
 * the chat transcript: the user scrolling up detaches, scrolling back to
 * the bottom reattaches.
 *
 * Jumps instantly (never smooth): these boxes are short and stream fast,
 * so a smooth animation would perpetually lag behind the tail. To keep
 * the per-frame jump from reading as a snap, callers can wear the
 * .lum-tail-fade top mask (main.css) while `scrolled` is set — content
 * then dissolves out the top instead of hard-clipping.
 *
 * The follow effect runs on every render instead of over declared deps —
 * streaming updates re-render the component as content arrives, which is
 * exactly when the tail needs chasing.
 */
export function useFollowBottom<T extends HTMLElement>(enabled: boolean) {
    const ref = useRef<T>(null);
    const pinnedRef = useRef(true);
    // Content sits above the viewport (tail being chased or reader is
    // scrolled down). Same-value setState bails out, so this costs one
    // extra render per transition, not per frame.
    const [scrolled, setScrolled] = useState(false);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (enabled && pinnedRef.current) {
            el.scrollTop = el.scrollHeight;
        }
        setScrolled(el.scrollTop > 0);
    });

    const onScroll = () => {
        const el = ref.current;
        if (!el) return;
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
        setScrolled(el.scrollTop > 0);
    };

    return {ref, onScroll, scrolled};
}
