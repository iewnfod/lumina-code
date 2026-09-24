import {useEffect, useLayoutEffect, useRef, type RefObject} from "react";

/**
 * Scroll management for the transcript column (extracted from ChatView):
 *
 * - Follows the newest content while the reader is parked at the bottom;
 *   scrolling up pauses the follow so history stays put. Small deltas
 *   (a new message while idle) glide smoothly; large ones (a session
 *   switch, first render) and streaming deltas jump instantly — frames
 *   land every ~16ms and each would restart the eased animation from
 *   scratch, which reads as stutter, not motion.
 * - Keeps the viewport steady while older content is prepended above it
 *   (scroll anchoring around window expansions).
 * - Re-pins on geometry changes that arrive after the follow effect ran
 *   (composer growing, images loading late).
 *
 * `expansionToken` (ChatView's render limit) re-runs the anchor restore
 * after the caller grows the render window — call {@link pinAnchor}
 * right before committing the growth.
 */
export function useTranscriptScroll({
    messages,
    busy,
    expansionToken,
}: {
    /** The transcript list — identity-tracked so streaming frames re-pin. */
    messages: unknown[];
    /** A run is in flight — follow jumps instead of gliding. */
    busy: boolean;
    /** The render-window size; anchor restore runs after it grows. */
    expansionToken: number;
}): {
    scrollRef: RefObject<HTMLDivElement | null>;
    onScroll: () => void;
    onWheel: () => void;
    /** Capture the current scrollHeight; restored (+delta) after the
     *  window expansion commits, so prepended content doesn't jump. */
    pinAnchor: () => void;
} {
    const scrollRef = useRef<HTMLDivElement>(null);
    const atBottomRef = useRef(true);
    // Timestamp until which scroll events are treated as our own follow
    // animation rather than user intent (see the follow effect below).
    const programmaticUntilRef = useRef(0);
    // Scroll anchor: scrollHeight captured right before a window expansion
    // commits, restored (+delta) after, so prepended content doesn't jump.
    const anchorHeightRef = useRef<number | null>(null);

    const pinAnchor = useRef(() => {
        anchorHeightRef.current = scrollRef.current?.scrollHeight ?? null;
    }).current;

    // Follow the newest content while parked at the bottom. Small deltas
    // (a new message while idle) glide smoothly; large ones (a session
    // switch, first render) jump instantly so the view doesn't spend a
    // second sweeping past pages of content. Streaming deltas jump too:
    // frames land every ~16ms and each restarts the eased animation from
    // scratch — a burst of restarts reads as stutter, not motion.
    useEffect(() => {
        const el = scrollRef.current;
        if (el && atBottomRef.current) {
            const delta = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (delta > el.clientHeight || busy) {
                el.scrollTop = el.scrollHeight;
            } else {
                // The smooth animation emits intermediate scroll events that
                // are nowhere near the bottom yet — tell onScroll to
                // ignore everything until it settles (or until this window
                // is refreshed by the next follow-scroll).
                programmaticUntilRef.current = performance.now() + 600;
                el.scrollTo({top: el.scrollHeight, behavior: "smooth"});
            }
        }
    }, [messages, busy]);

    // Restore the scroll position after content was prepended above.
    useLayoutEffect(() => {
        const el = scrollRef.current;
        const anchor = anchorHeightRef.current;
        if (el && anchor !== null) {
            el.scrollTop += el.scrollHeight - anchor;
        }
        anchorHeightRef.current = null;
    }, [expansionToken, messages]);

    // Re-pin on geometry changes that arrive AFTER the follow effect ran.
    // The composer column is a flex SIBLING of the scroller (its height
    // never enters scrollHeight, and scrollTop assignments clamp at
    // scrollHeight - clientHeight — so "aim lower" is a no-op). But when
    // the composer grows (context ring appearing, a permission card
    // replacing the input, the editable expanding), the flex-1 scroller
    // loses exactly that much height and a pin that was precise a moment
    // ago is suddenly short. Content can also grow late from inside
    // (images, code highlighting). ResizeObserver on both boxes re-fires
    // the pin while the reader is parked at the bottom; the clamp makes
    // it strictly additive — over-scroll is impossible, under-scroll
    // self-heals. Skipped during our own smooth glide so small deltas
    // keep gliding instead of snapping.
    //
    // AND while the reader is mid-gesture: content-visibility materializes
    // never-rendered rows as they approach the viewport (and the render
    // window can shift on older builds), each materialization resizing
    // the column a little. Re-pinning on those during the FIRST 80px of
    // an upward scroll — while atBottomRef still says true — snapped the
    // view back to the bottom on every step: a bounce loop that read as
    // constant jitter (the re-pin is for content that grows while the
    // reader is PARKED, not while they're actively leaving). The gesture
    // timestamp below stands the re-pin down until the reader settles.
    const lastGestureAtRef = useRef(0);
    const lastScrollTopRef = useRef<number | null>(null);
    useEffect(() => {
        const el = scrollRef.current;
        const content = el?.firstElementChild;
        if (!el || !content) return;
        const observer = new ResizeObserver(() => {
            if (!atBottomRef.current) return;
            if (performance.now() < programmaticUntilRef.current) return;
            if (performance.now() - lastGestureAtRef.current < 300) return;
            el.scrollTop = el.scrollHeight;
        });
        observer.observe(el); // viewport side: composer/window resize
        observer.observe(content); // content side: late growth
        return () => observer.disconnect();
    }, [scrollRef]);

    const onScroll = useRef(() => {
        const el = scrollRef.current;
        if (!el) return;
        // Mid-flight frames of our own follow-scroll aren't "the user left
        // the bottom" — without this guard, fast streaming content unpins
        // the view and the follow stops partway.
        if (performance.now() < programmaticUntilRef.current) return;
        lastGestureAtRef.current = performance.now();
        // An UPWARD user delta always unpins the follow — immediately,
        // not after fighting the 80px stickiness zone. While a run
        // streams, the follow effect fires per frame and yanks back to
        // the bottom as long as atBottomRef says true; with trackpad
        // smoothing (many small deltas) the reader could never cross
        // 80px in one gesture and was trapped bouncing. Distance alone
        // can't tell intent from noise; direction can: content growth
        // under a pinned view doesn't move scrollTop (no event), so any
        // real upward delta is the reader.
        const goingUp = el.scrollTop < (lastScrollTopRef.current ?? el.scrollTop) - 1;
        lastScrollTopRef.current = el.scrollTop;
        if (goingUp) {
            atBottomRef.current = false;
            return;
        }
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }).current;

    // An explicit wheel gesture always wins: cancel the ignore window so
    // the very next scroll event re-evaluates stickiness.
    const onWheel = useRef(() => {
        programmaticUntilRef.current = 0;
        lastGestureAtRef.current = performance.now();
    }).current;

    // While the tab/webview is hidden the browser pauses rendering:
    // smooth scrolls never run and streaming updates may stop arriving,
    // so no follow effect fires to catch up. On return, snap a pinned
    // view straight to the bottom, and shield the flag from the stale
    // scroll event the restore can synthesize.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState !== "visible") return;
            const el = scrollRef.current;
            if (!el) return;
            programmaticUntilRef.current = performance.now() + 300;
            if (atBottomRef.current) el.scrollTop = el.scrollHeight;
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, []);

    return {scrollRef, onScroll, onWheel, pinAnchor};
}
