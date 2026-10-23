import {motion} from "framer-motion";
import {useColors} from "../../hooks/colors.tsx";
import {whileHoverTap} from "../../lib/motion.ts";

/**
 * The chrome's labeled button: primary (cinnabar fill) or ghost with the
 * runtime-derived surface colors. Extracted from RequestCardChrome so
 * every chrome surface (request cards, modals) shares one button — the
 * labeled sibling of IconButton. Carries the shared hover/tap spring
 * (lib/motion's whileHoverTap) like IconButton does.
 *
 * Sizes: md (default — the settings pages' roomier h-9/text-sm tier)
 * and sm (the request cards' compact h-7/text-xs tier, kept for the
 * chat surfaces where the pinned stack must stay dense).
 */
export default function Button({
    label,
    primary = false,
    disabled = false,
    onClick,
    type = "button",
    size = "md",
}: {
    label: string;
    primary?: boolean;
    disabled?: boolean;
    onClick: () => void;
    type?: "button" | "submit";
    size?: "sm" | "md";
}) {
    const colors = useColors();
    return (
        <motion.button
            type={type}
            disabled={disabled}
            onClick={onClick}
            {...whileHoverTap}
            className={`${
                size === "sm" ? "h-7 px-3 text-xs" : "h-9 px-4 text-sm"
            } rounded-[var(--radius-sm)] font-medium cursor-pointer select-none transition-colors duration-[var(--duration-fast)] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--lum-btn-hover)]`}
            style={primary
                ? {
                    background: "var(--color-brand-cinnabar)",
                    color: "#fff",
                    "--lum-btn-hover": "rgba(255,255,255,0.15)",
                } as React.CSSProperties
                : {
                    // Ghost, like the composer's ToolbarButton — no outline.
                    color: colors.inactiveText,
                    "--lum-btn-hover": colors.hoverOverlay,
                } as React.CSSProperties}
        >
            {label}
        </motion.button>
    );
}
