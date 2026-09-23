/**
 * Arrival timing for the stats card's box-size animation (and any future
 * size-arrival motion of the same kind). The CURVE is a CSS token
 * (--ease-arrival in main.css) consumed by the card's width/height
 * transition; this module owns the part CSS can't compute — the
 * distance-scaled duration, injected per animation as the
 * --lum-size-dur custom property (seconds here, converted to ms at the
 * injection site).
 *
 * Why this split (the history, so nobody walks it back): a JS rAF loop
 * (spring first, then a hand-evaluated bezier) fought the main thread —
 * every starved frame while content mounted INSIDE the growing box was
 * a visible skip, and the elapsed-clock catch-up ended the motion in
 * one jump. Handing interpolation to the engine removed per-frame JS
 * entirely and made mid-flight retargeting native (a transition resumes
 * from its current interpolated value — exactly the pin's frozen rect).
 * The standard-ease curve itself was chosen by frame-by-frame
 * simulation: a spring charges ~84% of the distance then brakes into an
 * exponential tail the eye reads as a knee + crawl (and can only
 * "arrive" by snapping its last pixels), while this ease launches
 * softly, decelerates at a near-constant per-frame ratio, and lands
 * with the gap and the speed hitting zero together.
 */

/** Duration (seconds) for a size animation from the LARGEST axis delta:
 *  small in-panel resizes stay near-instant, big expands/collapses land
 *  within a bounded ~160–260ms. */
export function arrivalDuration(deltaPx: number): number {
    return Math.min(0.26, Math.max(0.16, 0.1 + Math.abs(deltaPx) / 3000));
}
