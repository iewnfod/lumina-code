import type {Transition} from "framer-motion";

/**
 * The framer-motion residue. After the CSS-first motion refactor (see
 * AGENTS.md §3.7) framer survives ONLY as the hover/tap spring on
 * button primitives — everything else (entrances, folds, pops, rolls,
 * panel sizes) is the CSS utility classes in main.css (.lum-enter,
 * .lum-fold, .lum-pop, .lum-roll-in, container queries…).
 *
 * The durations here are the JS-visible halves of the --duration-*
 * tokens (timers in RollingTitle), mirrored numerically.
 */

/** The snappy spring for small interactive elements (buttons, rows). */
export const springSnappy: Transition = {
    type: "spring",
    stiffness: 500,
    damping: 32,
    mass: 0.6,
};

/** One drum turn (seconds) — RollingTitle's pending-queue timer. */
export const durationTitleRoll = 0.35;

/**
 * Hover/tap micro-interactions for an interactive element. Apply to a
 * `motion.button`/`motion.div` via `whileHover`/`whileTap` — no variants
 * wrapper needed.
 */
export const whileHoverTap = {
    whileHover: {scale: 1.03, transition: springSnappy},
    whileTap: {scale: 0.97, transition: springSnappy},
};
