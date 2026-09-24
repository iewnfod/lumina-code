import type {Transition, Variants} from "framer-motion";

/**
 * The framer-motion residue after the CSS-first motion refactor (see
 * AGENTS.md §3.7): the button hover/tap spring, plus the ONE sanctioned
 * exception — RollingTitle's drum-roll pair. Everything else (entrances,
 * folds, pops, panel sizes) is the CSS utility classes in main.css
 * (.lum-enter, .lum-fold, .lum-pop, container queries…).
 *
 * The durations here are the JS-visible halves of the --duration-*
 * tokens, mirrored numerically.
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

/** Easing matching `--ease-spring` (the JS-side mirror of the CSS curve). */
export const easeSpring = [0.22, 1, 0.36, 1] as const;

/**
 * Drum-roll swap — rolling text (title bar session title, fold-row
 * titles, stat counters). The old title rolls up over the drum's top
 * horizon while the new one rolls in from beneath the bottom. Enter and
 * exit share identical timing so both spans turn as one rigid cylinder.
 * Pair with `transformPerspective` in the element's style for the
 * cylindrical depth cue, a positioned edge-clipping container
 * (overflow-hidden), and AnimatePresence mode="popLayout" so the
 * departing span stays pinned at its measured spot — THAT pairing (an
 * exiting element held at its measured position) is why this one
 * animation is framer and not CSS keyframes.
 */
export const titleRoll: Variants = {
    hidden: {opacity: 0, y: "100%", rotateX: -60},
    show: {
        opacity: 1,
        y: 0,
        rotateX: 0,
        transition: {duration: durationTitleRoll, ease: easeSpring},
    },
    exit: {
        opacity: 0,
        y: "-100%",
        rotateX: 60,
        transition: {duration: durationTitleRoll, ease: easeSpring},
    },
};

/**
 * Hover/tap micro-interactions for an interactive element. Apply to a
 * `motion.button`/`motion.div` via `whileHover`/`whileTap` — no variants
 * wrapper needed.
 */
export const whileHoverTap = {
    whileHover: {scale: 1.03, transition: springSnappy},
    whileTap: {scale: 0.97, transition: springSnappy},
};
