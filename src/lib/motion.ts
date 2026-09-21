import type {Transition, Variants} from "framer-motion";

/**
 * Shared framer-motion presets. Concentrating motion curves here keeps every
 * chrome surface animated with the same rhythm — one spring, one set of
 * durations — instead of each component inventing its own easing. The numeric
 * timings mirror the `--duration-*` / `--ease-spring` tokens in main.css so
 * CSS and JS motion agree.
 *
 * Ported as-is from lumina-terminal.
 */

/** The one spring curve used for organic motion (sessions, panels). */
export const springSoft: Transition = {
    type: "spring",
    stiffness: 380,
    damping: 30,
    mass: 0.8,
};

/** A slightly snappier spring for small interactive elements (buttons, rows). */
export const springSnappy: Transition = {
    type: "spring",
    stiffness: 500,
    damping: 32,
    mass: 0.6,
};

/** Durations matching the CSS `--duration-*` tokens. */
export const durationFast = 0.15;
export const durationBase = 0.25;
export const durationSlow = 0.4;

/** Easing matching `--ease-spring` (the JS-side mirror of the CSS curve). */
export const easeSpring = [0.22, 1, 0.36, 1] as const;
export const easeGlass = [0.4, 0, 0.2, 1] as const;

/** Enter from below with a fade — panels, modals, dropdowns. */
export const fadeSlideUp: Variants = {
    hidden: {opacity: 0, y: 8},
    show: {
        opacity: 1,
        y: 0,
        transition: {duration: durationBase, ease: easeSpring},
    },
    exit: {
        opacity: 0,
        y: 8,
        transition: {duration: durationFast, ease: easeGlass},
    },
};

/** Spring-driven fade/slide — full-surface swaps (session ↔ welcome). */
export const springSwap: Variants = {
    hidden: {opacity: 0, y: 12},
    show: {
        opacity: 1,
        y: 0,
        transition: springSoft,
    },
    exit: {
        opacity: 0,
        y: -8,
        transition: {duration: durationFast, ease: easeGlass},
    },
};

/** Centered scale-in — modals, popovers. */
export const scaleIn: Variants = {
    hidden: {opacity: 0, scale: 0.96},
    show: {
        opacity: 1,
        scale: 1,
        transition: springSoft,
    },
    exit: {
        opacity: 0,
        scale: 0.96,
        transition: {duration: durationFast, ease: easeGlass},
    },
};

/** Pure opacity fade — backdrop, subtle swaps. */
export const fadeIn: Variants = {
    hidden: {opacity: 0},
    show: {opacity: 1, transition: {duration: durationBase, ease: easeGlass}},
    exit: {opacity: 0, transition: {duration: durationFast, ease: easeGlass}},
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

/**
 * Container variant for staggered children. Pair with a child that declares
 * `variants={fadeSlideUp}` (or similar) — the container drives the stagger
 * delay, the child supplies the actual motion.
 */
export const staggerContainer = (stagger = 0.04, delayChildren = 0): Variants => ({
    hidden: {},
    show: {
        transition: {staggerChildren: stagger, delayChildren},
    },
});
