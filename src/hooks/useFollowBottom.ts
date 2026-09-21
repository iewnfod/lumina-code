import {useEffect, useRef} from "react";

/**
 * Keeps a small scrollable region (thinking text, tool output) pinned to
 * its bottom while content streams in — the same stickiness semantics as
 * the chat transcript: the user scrolling up detaches, scrolling back to
 * the bottom reattaches.
 *
 * Jumps instantly (never smooth): these boxes are short and stream fast,
 * so a smooth animation would perpetually lag behind the tail.
 *
 * The follow effect runs on every render instead of over declared deps —
 * streaming updates re-render the component as content arrives, which is
 * exactly when the tail needs chasing.
 */
export function useFollowBottom<T extends HTMLElement>(enabled: boolean) {
    const ref = useRef<T>(null);
    const pinnedRef = useRef(true);

    useEffect(() => {
        const el = ref.current;
        if (el && enabled && pinnedRef.current) {
            el.scrollTop = el.scrollHeight;
        }
    });

    const onScroll = () => {
        const el = ref.current;
        if (!el) return;
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    };

    return {ref, onScroll};
}
