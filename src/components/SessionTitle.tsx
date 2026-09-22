import {type CSSProperties, useEffect, useRef, useState} from "react";
import {Tooltip} from "@heroui/react";

/** Edge-fade width for overflowing tab titles (px). */
const TITLE_FADE = 32;

/** Hover must rest this long before the tooltip opens (ms), counted
 *  fresh per row — a quick swipe across the list shouldn't pop it. */
const TITLE_TOOLTIP_DELAY = 1000;

/**
 * A single-line label that, when its text overflows, fades out at the
 * right edge (same dissolve as the transcript edges — no "…" ellipsis)
 * and shows the full title in a HeroUI tooltip once the pointer rests
 * on it. Labels that fit never wear a mask or a tooltip.
 *
 * The hover debounce is ours, not the library's: react-aria keeps a
 * global "warmed up" flag, so moving the pointer from one open tooltip
 * to the next trigger skips the delay entirely (and for ~500ms after a
 * close) — a sweep down the session list would pop every title open
 * instantly. `trigger="focus"` idles the library's hover path (keyboard
 * focus still opens immediately, keeping the a11y story), while our
 * mouseenter/mouseleave pair below runs the delay and RESETS it on
 * every new trigger, which is the behavior a per-tab debounce needs.
 */
export default function SessionTitle({text, className, style}: {
    text: string;
    className?: string;
    style?: CSSProperties;
}) {
    const slotRef = useRef<HTMLSpanElement>(null);
    const [overflowing, setOverflowing] = useState(false);
    const [open, setOpen] = useState(false);
    const hoverTimerRef = useRef<number | null>(null);

    // Re-measure when the text or the sidebar width changes.
    useEffect(() => {
        const el = slotRef.current;
        if (!el) return;
        const measure = () => setOverflowing(el.scrollWidth > el.clientWidth);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [text]);

    const cancelHoverTimer = () => {
        if (hoverTimerRef.current !== null) {
            window.clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
    };
    useEffect(() => cancelHoverTimer, []);

    // The Tooltip scaffolding renders UNCONDITIONALLY so the measured
    // span never moves in the tree. Wrapping it only once the text
    // overflows remounts the span: the ResizeObserver keeps watching
    // the detached node, which reports 0×0 and flips `overflowing`
    // back off for good — no fade, no tooltip.
    return (
        <Tooltip trigger="focus" isOpen={open} onOpenChange={setOpen} closeDelay={0}>
            {/* The trigger renders a wrapper div that becomes the row's
             * flex item — min-w-0 lets it shrink below the unbreakable
             * one-liner, and w-full keeps the hover/anchor area as wide
             * as the title slot was before the wrapper existed. With no
             * Tooltip.Content mounted (text fits), hovering opens
             * nothing. The mouse handlers chain after (and in place of)
             * the library's idled hover pair and own the pointer path. */}
            <Tooltip.Trigger
                className="min-w-0 w-full"
                onMouseEnter={() => {
                    cancelHoverTimer();
                    hoverTimerRef.current = window.setTimeout(() => setOpen(true), TITLE_TOOLTIP_DELAY);
                }}
                onMouseLeave={() => {
                    cancelHoverTimer();
                    setOpen(false);
                }}
            >
                <span
                    ref={slotRef}
                    className={`block overflow-hidden whitespace-nowrap ${className ?? ""}`}
                    style={{
                        ...style,
                        ...(overflowing ? {
                            WebkitMaskImage: `linear-gradient(to right, black calc(100% - ${TITLE_FADE}px), transparent 100%)`,
                            maskImage: `linear-gradient(to right, black calc(100% - ${TITLE_FADE}px), transparent 100%)`,
                        } : {}),
                    }}
                >
                    {text}
                </span>
            </Tooltip.Trigger>
            {overflowing && (
                <Tooltip.Content>
                    <p className="text-xs max-w-64 break-words">{text}</p>
                </Tooltip.Content>
            )}
        </Tooltip>
    );
}
