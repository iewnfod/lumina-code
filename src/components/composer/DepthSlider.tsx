import {useRef, type KeyboardEvent, type PointerEvent} from "react";
import {useColors} from "../../hooks/colors.tsx";

/**
 * The thinking-depth slider — the HORIZONTAL capsule pinned at the
 * bottom of the merged model picker's panel (a vertical twin was tried
 * and set aside: the horizontal one reads better under a list). LEFT =
 * the model's WEAKEST variant (usually 关), RIGHT = its strongest:
 * sliding right thinks harder. The tick count adapts per model — one
 * tick per variant the CURRENT model offers, so a 关/高 model gets a
 * two-step track and a full 关/低/中/高/最高 model its own ladder (a
 * variant-less or single-variant model hides the section at the call
 * site). Discrete by design: the value is always one of the caller's
 * ids, never an interpolation — dragging snaps to the nearest tick
 * (pointer capture, so the drag survives leaving the track;
 * touch-action:none keeps a phone drag from scrolling the menu) and the
 * track is a role="slider" with ←/→/Home/End keys. No tick labels: the
 * active level reads out at the section title's RIGHT edge (the
 * caller's title row — ComposerToolbar). The handle's travel is inset
 * by its own radius, so at the endmost ticks its edge sits flush with
 * the pill's cap — it never overhangs the track.
 */
export default function DepthSlider({
    ticks,
    value,
    onChange,
    ariaLabel,
}: {
    /** Ordered variant ticks, WEAKEST FIRST (index 0 = the LEFT end of
     * the track) — labeled by the caller (i18n lives there; the labels
     * serve the reading row and aria, the track itself is unlabeled). */
    ticks: {id: string; label: string}[];
    /** The selected variant id (expected to be one of the ticks). */
    value: string;
    onChange: (id: string) => void;
    /** Accessible name for the slider role (not rendered). */
    ariaLabel: string;
}) {
    const colors = useColors();
    const trackRef = useRef<HTMLDivElement>(null);
    const index = Math.max(0, ticks.findIndex((t) => t.id === value));
    const last = ticks.length - 1;

    /** The knob's radius (h-7/w-7): its center never comes closer to
     * the track's ends than this, so at the endmost ticks its EDGE sits
     * flush with the pill's cap instead of overhanging it. */
    const HANDLE_INSET = 14;

    /** The handle-center position for tick i as a CSS calc: the
     * percentage mapped onto the track's INNER span (HANDLE_INSET from
     * each end). */
    const centerAt = (i: number) =>
        last <= 0
            ? "50%"
            : `calc(${HANDLE_INSET}px + ${i / last} * (100% - ${2 * HANDLE_INSET}px))`;

    /** The fill's width for tick i: from the track's left edge TO THE
     * HANDLE'S CENTER — the knob RIDES the fill's end (it never sits
     * detached ahead of it), its round corners letting a hint of color
     * through at mid levels like every standard slider. The one
     * exception is 关 (i = 0): exactly 0 — "off" must show nothing, a
     * stub of fill peeking out from under the knob's left corner is
     * the tell-tale gap. */
    const fillTo = (i: number) => (last <= 0 || i <= 0 ? "0px" : centerAt(i));

    /** One faint notch per stop, centered where the knob parks. */
    const marks = (background: string) =>
        ticks.map((t, i) => (
            <span
                key={t.id}
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{left: centerAt(i), width: 2, height: 8, background}}
            />
        ));

    /** Nearest tick index for a pointer x inside the track — measured
     * over the SAME inner span the handle travels (HANDLE_INSET from
     * each end), so the drag and the knob always agree. */
    const tickAt = (clientX: number): number => {
        const track = trackRef.current;
        if (!track) return index;
        const rect = track.getBoundingClientRect();
        if (rect.width <= 2 * HANDLE_INSET || last <= 0) return 0;
        const fraction = Math.min(
            1,
            Math.max(0, (clientX - rect.left - HANDLE_INSET) / (rect.width - 2 * HANDLE_INSET)),
        );
        return Math.round(fraction * last);
    };

    const pick = (i: number) => {
        const tick = ticks[i];
        if (tick && tick.id !== value) onChange(tick.id);
    };

    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        // No default gestures during a drag: focus manually instead.
        e.preventDefault();
        trackRef.current?.focus();
        trackRef.current?.setPointerCapture(e.pointerId);
        pick(tickAt(e.clientX));
    };

    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        if (!trackRef.current?.hasPointerCapture(e.pointerId)) return;
        pick(tickAt(e.clientX));
    };

    // Horizontal-slider convention: → increases, ← decreases; Home is
    // the weakest tick (left), End the strongest (right).
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "ArrowRight") {
            e.preventDefault();
            pick(index + 1);
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            pick(index - 1);
        } else if (e.key === "Home") {
            e.preventDefault();
            pick(0);
        } else if (e.key === "End") {
            e.preventDefault();
            pick(last);
        }
    };

    return (
        <div className="w-full select-none px-2.5">
            {/* px-2.5 aligns the track's ends with the section title's
             * text and the menu rows' content — the slider reads as part
             * of the same column, and the track gets the longest span
             * the insets allow. The hit area below is the whole track
             * row, not just the 24px pill — a generous target for
             * pointer AND touch drags; the pill/handle/fill center
             * inside it. */}
            <div
                ref={trackRef}
                role="slider"
                tabIndex={0}
                aria-label={ariaLabel}
                aria-orientation="horizontal"
                aria-valuemin={0}
                aria-valuemax={last}
                aria-valuenow={index}
                aria-valuetext={ticks[index]?.label}
                className="relative h-7 w-full cursor-pointer touch-none rounded-[var(--radius-sm)] focus-visible:outline-1 focus-visible:outline-[var(--lum-focus)] focus-visible:-outline-offset-2"
                style={{"--lum-focus": colors.focusRing} as React.CSSProperties}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onKeyDown={onKeyDown}
            >
                {/* Base pill — the track's OWN ground: a clearly visible
                 * neutral capsule (the design's #E9E9E9 role) that fences
                 * the slider's full travel range, so the gradient fill
                 * ends into SOMETHING instead of empty panel space. */}
                <div
                    className="absolute inset-x-0 top-1/2 h-6 -translate-y-1/2 rounded-full"
                    style={{background: colors.activeOverlay}}
                />
                {/* Gradient fill: from the LEFT (weakest) end to the
                 * handle's center — the brand lavender→cinnabar
                 * spectrum, with the knob riding its end (0 at 关:
                 * "off" shows truly nothing colored). Transitions its
                 * width in LOCKSTEP with the handle — the fill grows
                 * and shrinks with the knob, never snapping behind it. */}
                <div
                    className="absolute left-0 top-1/2 h-6 -translate-y-1/2 rounded-full transition-[width] duration-[var(--duration-fast)]"
                    style={{
                        width: fillTo(index),
                        background:
                            "linear-gradient(90deg, var(--color-brand-lavender), var(--color-brand-cinnabar))",
                    }}
                />
                {/* Tick marks, split into TWO CLIPPED layers so each
                 * ground carries the right mark: a BRIGHT white notch
                 * where the gradient has passed (a light scar on the
                 * color, not a dark one) and the plain grey one ahead
                 * on the track. Both clips track the fill's edge and
                 * transition with it; the current stop hides under the
                 * knob itself. */}
                <div
                    className="absolute inset-0 transition-[clip-path] duration-[var(--duration-fast)]"
                    style={{clipPath: `inset(0 0 0 ${fillTo(index)})`}}
                >
                    {marks("var(--lum-neutral-divider)")}
                </div>
                <div
                    className="absolute inset-0 transition-[clip-path] duration-[var(--duration-fast)]"
                    style={{clipPath: `inset(0 calc(100% - ${fillTo(index)}) 0 0)`}}
                >
                    {marks("rgba(255,255,255,0.45)")}
                </div>
                {/* Handle: an elevated white knob slightly taller than
                 * the pill, lifted by a soft drop (the design's only
                 * shadow). */}
                <div
                    className="absolute top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full transition-[left] duration-[var(--duration-fast)]"
                    style={{
                        left: centerAt(index),
                        background: "var(--color-elevated)",
                        boxShadow: "0 2px 6px rgba(0,0,0,0.28)",
                    }}
                />
            </div>
        </div>
    );
}
