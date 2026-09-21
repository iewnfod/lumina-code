import {forwardRef, type CSSProperties, type ReactNode} from "react";
import {motion, type HTMLMotionProps} from "framer-motion";
import {springSnappy} from "../../lib/motion.ts";

/**
 * Unified icon button — the single interactive primitive for chrome controls.
 * Ported as-is from lumina-terminal.
 *
 * The hover/active overlay colors are runtime-derived (passed in from
 * `useSurfaceColors`) because chrome must follow the effective bg; we apply
 * them via CSS variables so framer-motion's `whileHover`/`whileTap` can
 * animate scale without fighting inline-style mutations.
 */

export type IconButtonVariant = "ghost" | "solid" | "glass" | "danger";

export interface IconButtonProps
    extends Omit<HTMLMotionProps<"button">, "ref"> {
    /** Visual style. `ghost` (default) is the see-through chrome button. */
    variant?: IconButtonVariant;
    /** Square pixel size; the button is rendered as a square of this size. */
    size?: number;
    /** Persistent highlight (e.g. an active toggle). */
    isActive?: boolean;
    /** Hover background overlay (runtime-derived from useSurfaceColors). */
    hoverOverlay?: string;
    /** Active/pressed background overlay. */
    activeOverlay?: string;
    /** Danger hover background — used by window close buttons. When set, the
     *  button wears this on hover instead of `hoverOverlay`. */
    dangerHover?: string;
    children: ReactNode;
}

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
    {
        variant = "ghost",
        size = 32,
        isActive = false,
        hoverOverlay = "rgba(255,255,255,0.08)",
        activeOverlay = "rgba(255,255,255,0.14)",
        dangerHover,
        className = "",
        style,
        children,
        ...rest
    },
    ref,
) {
    // Default background is carried as a CSS var (not an inline `background`)
    // so that the `:hover`/`:active` classes below — which have higher
    // specificity — can actually override it. An inline `style.background`
    // would win over the hover class and silently kill the hover effect.
    const baseBg =
        variant === "solid"
            ? activeOverlay
            : variant === "glass"
                ? "rgba(255,255,255,0.06)"
                : isActive
                    ? activeOverlay
                    : "transparent";

    const motionStyle = {
        ...(style as Record<string, unknown>),
        "--lum-button-bg": baseBg,
        "--lum-hover-bg": dangerHover ?? hoverOverlay,
        "--lum-active-bg": activeOverlay,
        width: size,
        height: size,
    } as CSSProperties;

    return (
        <motion.button
            ref={ref}
            type="button"
            whileHover={{scale: 1.04, transition: springSnappy}}
            whileTap={{scale: 0.94, transition: springSnappy}}
            className={`lum-icon-button inline-flex items-center justify-center rounded-[var(--radius-sm)] cursor-pointer select-none transition-colors duration-[var(--duration-fast)] ease-[var(--ease-glass)] bg-[var(--lum-button-bg)] hover:bg-[var(--lum-hover-bg)] active:bg-[var(--lum-active-bg)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-cinnabar)] focus-visible:ring-offset-0 ${className}`}
            style={motionStyle}
            {...rest}
        >
            {children}
        </motion.button>
    );
});

export default IconButton;
